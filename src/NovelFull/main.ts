import {
  CloudflareError,
  type Chapter,
  type ChapterDetails,
  type ExtensionImpl,
  type Metadata,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
  type UpdateManager,
} from "@paperback/types";

import {
  CACHE_VERSION,
  CHAPTER_CACHE_CHUNK_SIZE,
  CHAPTERS_PER_PAGE,
  DOMAIN,
  buildPartTitle,
  cacheChunkKey,
  cacheKey,
  chapterUrl,
  createPartMangaId,
  formatPartRange,
  getPartCount,
  getSplitPart,
  getVisiblePartChapterCount,
  mangaUrl,
  parsePartMangaId,
  searchUrl,
  shouldSplitTitle,
  type ChapterCache,
  type ChapterCacheMetadata,
  type SerializedChapter,
  type SearchNovel,
  type SplitPartInfo,
} from "./models";
import { fetchHTML, mainRateLimiter } from "./network";
import { NovelFullParser } from "./parser";
import NovelFullConfig from "./pbconfig";

type SourceRequest = {
  baseSlug: string;
  part?: SplitPartInfo;
};

export class NovelFullExtension implements ExtensionImpl<typeof NovelFullConfig> {
  private readonly parser = new NovelFullParser();
  private readonly chapterPayloadLimit = 120000;

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const request = this.getMangaRequest(mangaId);
    const html = await fetchHTML(mangaUrl(request.baseSlug), mangaUrl(request.baseSlug));
    const pageInfo = this.parser.parseNovelPageInfo(html);
    const sourceManga = this.parser.parseNovelPage(request.baseSlug, html);

    if (!request.part) {
      return sourceManga;
    }

    const totalChapters = await this.getTotalChapterCount(request.baseSlug, sourceManga, pageInfo);
    return this.createPartSourceManga(sourceManga, request.part, totalChapters);
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    _metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const title = query.title.trim();
    if (!title) {
      return { items: [] };
    }

    const html = await fetchHTML(searchUrl(title), `${DOMAIN}/`);
    const results = this.parser.parseSearchPage(html);
    return {
      items: results.flatMap((result) => this.buildSearchResults(result)),
    };
  }

  async getChapters(sourceManga: SourceManga, _sinceDate?: Date): Promise<Chapter[]> {
    const chapters = await this.resolveChaptersForSource(sourceManga);
    return this.prepareChaptersForReturn(chapters, sourceManga);
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const request = this.getSourceRequest(chapter.sourceManga);
    const url = chapterUrl(request.baseSlug, chapter.chapterId);
    const html = await fetchHTML(url, mangaUrl(request.baseSlug));
    return this.parser.parseChapterDetails(chapter, html);
  }

  async processTitlesForUpdates(
    updateManager: UpdateManager,
    _lastUpdateDate?: Date,
  ): Promise<void> {
    const latestChapterCounts = new Map<string, number | undefined>();

    for (const sourceManga of updateManager.getQueuedItems()) {
      const request = this.getSourceRequest(sourceManga);

      try {
        if (!latestChapterCounts.has(request.baseSlug)) {
          latestChapterCounts.set(request.baseSlug, await this.getLatestChapterCount(request.baseSlug));
        }

        const latestChapterCount = latestChapterCounts.get(request.baseSlug);
        const knownChapterCount =
          sourceManga.chapterCount ?? (await updateManager.getNumberOfChapters(sourceManga.mangaId));

        if (latestChapterCount === undefined) {
          await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
          continue;
        }

        const visibleChapterCount = this.getVisibleChapterCountForRequest(request, latestChapterCount);
        if (visibleChapterCount <= knownChapterCount) {
          await updateManager.setUpdatePriority(sourceManga.mangaId, "skip");
          continue;
        }

        const chapters = await this.resolveChaptersForSource(sourceManga, latestChapterCount);
        const newChapters = chapters.slice(knownChapterCount);

        if (newChapters.length > 0) {
          await updateManager.setNewChapters(sourceManga.mangaId, newChapters);
          await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
          continue;
        }

        await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
      } catch (error) {
        if (error instanceof CloudflareError) {
          throw error;
        }

        await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
      }
    }
  }

  async initialise(): Promise<void> {
    mainRateLimiter.registerInterceptor();
  }

  private buildSearchResults(result: SearchNovel): SearchResultItem[] {
    const [baseResult] = this.parser.parseSearchResults([result]);
    if (!baseResult) {
      return [];
    }

    if (!shouldSplitTitle(result.latestChapterNumber)) {
      return [baseResult];
    }

    return Array.from({ length: getPartCount(result.latestChapterNumber) }, (_, index) => {
      const part = getSplitPart(result.slug, index + 1);
      const subtitlePrefix = baseResult.subtitle?.trim() ? `${baseResult.subtitle.trim()} • ` : "";

      return {
        ...baseResult,
        mangaId: createPartMangaId(result.slug, part.partNumber),
        title: buildPartTitle(baseResult.title, part.partNumber),
        subtitle: `${subtitlePrefix}Chapters ${formatPartRange(part, result.latestChapterNumber)}`,
      };
    });
  }

  private getMangaRequest(mangaId: string): SourceRequest {
    const part = parsePartMangaId(mangaId);
    if (part) {
      return {
        baseSlug: part.baseSlug,
        part,
      };
    }

    return { baseSlug: mangaId };
  }

  private getSourceRequest(sourceManga: SourceManga): SourceRequest {
    const parsedRequest = this.getMangaRequest(sourceManga.mangaId);
    if (parsedRequest.part) {
      return parsedRequest;
    }

    const additionalInfo = sourceManga.mangaInfo.additionalInfo;
    if (!additionalInfo?.baseSlug || !additionalInfo.partNumber) {
      return parsedRequest;
    }

    const partNumber = Number(additionalInfo.partNumber);
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      return parsedRequest;
    }

    return {
      baseSlug: additionalInfo.baseSlug,
      part: getSplitPart(additionalInfo.baseSlug, partNumber),
    };
  }

  private createPartSourceManga(
    sourceManga: SourceManga,
    part: SplitPartInfo,
    totalChapters?: number,
  ): SourceManga {
    const range = formatPartRange(part, totalChapters);
    const synopsisPrefix = `Contains chapters ${range}.`;

    return {
      ...sourceManga,
      mangaId: createPartMangaId(part.baseSlug, part.partNumber),
      mangaInfo: {
        ...sourceManga.mangaInfo,
        primaryTitle: buildPartTitle(sourceManga.mangaInfo.primaryTitle, part.partNumber),
        synopsis: sourceManga.mangaInfo.synopsis
          ? `${synopsisPrefix}\n\n${sourceManga.mangaInfo.synopsis}`
          : synopsisPrefix,
        additionalInfo: {
          ...sourceManga.mangaInfo.additionalInfo,
          baseSlug: part.baseSlug,
          partNumber: String(part.partNumber),
          rangeStart: String(part.rangeStart),
          rangeEnd: String(part.rangeEnd),
          totalChapters: totalChapters
            ? String(totalChapters)
            : sourceManga.mangaInfo.additionalInfo?.totalChapters ?? "",
        },
      },
    };
  }

  private createBaseSourceManga(sourceManga: SourceManga, baseSlug: string): SourceManga {
    return sourceManga.mangaId === baseSlug
      ? sourceManga
      : {
          ...sourceManga,
          mangaId: baseSlug,
          mangaInfo: {
            ...sourceManga.mangaInfo,
            additionalInfo: {
              ...sourceManga.mangaInfo.additionalInfo,
              baseSlug,
            },
          },
        };
  }

  private async resolveChaptersForSource(
    sourceManga: SourceManga,
    latestChapterCount?: number,
  ): Promise<Chapter[]> {
    const request = this.getSourceRequest(sourceManga);
    const baseSourceManga = this.createBaseSourceManga(sourceManga, request.baseSlug);
    let cache = this.getCache(request.baseSlug);
    let refreshFailed = false;

    if (cache?.complete) {
      try {
        const resolvedLatestChapterCount = latestChapterCount ?? (await this.getLatestChapterCount(request.baseSlug));
        if (resolvedLatestChapterCount !== undefined && resolvedLatestChapterCount > cache.chapters.length) {
          const newChapters = await this.fetchNewestChapters(
            request.baseSlug,
            baseSourceManga,
            resolvedLatestChapterCount - cache.chapters.length,
            resolvedLatestChapterCount,
          );
          cache = this.mergeIntoCache(
            request.baseSlug,
            cache,
            newChapters,
            undefined,
            resolvedLatestChapterCount,
          );
        }
      } catch (error) {
        if (error instanceof CloudflareError) {
          throw error;
        }

        // Use cached chapters when the refresh check fails.
        refreshFailed = true;
      }
    }

    if (refreshFailed && latestChapterCount !== undefined) {
      throw new Error(`Could not refresh chapters for ${request.baseSlug}`);
    }

    if (!cache?.complete) {
      cache = await this.fetchAllChapters(request.baseSlug, baseSourceManga, cache);
    }

    return this.filterChaptersForRequest(this.hydrateChapters(cache.chapters, sourceManga), request);
  }

  private filterChaptersForRequest(chapters: Chapter[], request: SourceRequest): Chapter[] {
    if (!request.part) {
      return chapters;
    }

    const part = request.part;
    return chapters.filter((chapter) => chapter.chapNum >= part.rangeStart && chapter.chapNum <= part.rangeEnd);
  }

  private getVisibleChapterCountForRequest(request: SourceRequest, totalChapters: number): number {
    return request.part ? getVisiblePartChapterCount(request.part, totalChapters) : totalChapters;
  }

  private async fetchAllChapters(
    baseSlug: string,
    sourceManga: SourceManga,
    cache?: ChapterCache,
  ): Promise<ChapterCache> {
    let workingCache = cache ?? this.createEmptyCache();
    const knownTotalChapters = this.getKnownChapterCount(sourceManga) ?? workingCache.totalChapters;
    const expectedPages = knownTotalChapters
      ? Math.max(1, Math.ceil(knownTotalChapters / CHAPTERS_PER_PAGE))
      : undefined;
    const baseSourceManga = this.createBaseSourceManga(sourceManga, baseSlug);

    if (!workingCache.totalPages) {
      const firstPage = await this.fetchChapterPage(baseSlug, baseSourceManga, 1);
      workingCache = this.mergeIntoCache(
        baseSlug,
        workingCache,
        firstPage.chapters,
        1,
        firstPage.totalPages === 1 ? firstPage.chapters.length : knownTotalChapters,
        firstPage.totalPages,
      );
    }

    const totalPages = workingCache.totalPages ?? expectedPages ?? 1;
    for (let page = 1; page <= totalPages; page += 1) {
      if (workingCache.fetchedPages.includes(page)) {
        continue;
      }

      const chapterPage = await this.fetchChapterPage(baseSlug, baseSourceManga, page);
      workingCache = this.mergeIntoCache(
        baseSlug,
        workingCache,
        chapterPage.chapters,
        page,
        page === totalPages ? (totalPages - 1) * CHAPTERS_PER_PAGE + chapterPage.chapters.length : knownTotalChapters,
        chapterPage.totalPages,
      );
    }

    const normalizedCache = this.normalizeCache({
      ...workingCache,
      complete: totalPages > 0 && workingCache.fetchedPages.length >= totalPages,
      totalPages,
      totalChapters: workingCache.totalChapters ?? workingCache.chapters.length,
      updatedAt: new Date().toISOString(),
    });
    return this.saveCache(baseSlug, normalizedCache);
  }

  private async fetchNewestChapters(
    baseSlug: string,
    sourceManga: SourceManga,
    newChapterCount: number,
    latestChapterCount: number,
  ): Promise<Chapter[]> {
    const totalPages = Math.max(1, Math.ceil(latestChapterCount / CHAPTERS_PER_PAGE));
    const collected: Chapter[] = [];
    const baseSourceManga = this.createBaseSourceManga(sourceManga, baseSlug);

    for (let page = totalPages; page >= 1 && collected.length < newChapterCount; page -= 1) {
      const chapterPage = await this.fetchChapterPage(baseSlug, baseSourceManga, page);
      collected.push(...chapterPage.chapters);
    }

    return collected
      .sort((left, right) => (left.sortingIndex ?? 0) - (right.sortingIndex ?? 0))
      .slice(-newChapterCount);
  }

  private async fetchChapterPage(baseSlug: string, sourceManga: SourceManga, page: number): Promise<ChapterPageResult> {
    const html = await fetchHTML(mangaUrl(baseSlug, page), mangaUrl(baseSlug));
    const parsed = this.parser.parseChapterListPage(sourceManga, html, page);
    return {
      ...parsed,
      totalPages: parsed.totalPages || 1,
    };
  }

  private async getLatestChapterCount(baseSlug: string): Promise<number | undefined> {
    const html = await fetchHTML(mangaUrl(baseSlug), mangaUrl(baseSlug));
    const pageInfo = this.parser.parseNovelPageInfo(html);
    if (pageInfo.totalPages === 1) {
      return pageInfo.pageChapterCount;
    }

    const sourceManga = this.parser.parseNovelPage(baseSlug, html);
    const lastPage = await this.fetchChapterPage(baseSlug, sourceManga, pageInfo.totalPages);
    return (pageInfo.totalPages - 1) * CHAPTERS_PER_PAGE + lastPage.chapters.length;
  }

  private async getTotalChapterCount(
    baseSlug: string,
    sourceManga: SourceManga,
    pageInfo: ReturnType<NovelFullParser["parseNovelPageInfo"]>,
  ): Promise<number | undefined> {
    if (pageInfo.totalPages === 1) {
      return pageInfo.pageChapterCount;
    }

    const lastPage = await this.fetchChapterPage(baseSlug, sourceManga, pageInfo.totalPages);
    return (pageInfo.totalPages - 1) * CHAPTERS_PER_PAGE + lastPage.chapters.length;
  }

  private getKnownChapterCount(sourceManga: SourceManga): number | undefined {
    const totalChapters = sourceManga.mangaInfo.additionalInfo?.totalChapters;
    if (!totalChapters) {
      return undefined;
    }

    const parsed = Number(totalChapters);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private getCache(mangaId: string): ChapterCache | undefined {
    const state = Application.getState(cacheKey(mangaId));
    if (!state || typeof state !== "object") {
      return undefined;
    }

    const cache = state as Partial<ChapterCacheMetadata>;
    if (
      cache.version !== CACHE_VERSION ||
      !Array.isArray(cache.fetchedPages) ||
      typeof cache.chunkCount !== "number"
    ) {
      return undefined;
    }

    const chapters: SerializedChapter[] = [];
    for (let chunkIndex = 0; chunkIndex < cache.chunkCount; chunkIndex += 1) {
      const chunk = Application.getState(cacheChunkKey(mangaId, chunkIndex));
      if (!Array.isArray(chunk)) {
        return undefined;
      }

      chapters.push(...chunk.filter(this.isSerializedChapter));
    }

    return this.normalizeCache({
      version: cache.version,
      complete: Boolean(cache.complete),
      fetchedPages: cache.fetchedPages.filter((page): page is number => typeof page === "number"),
      totalPages: typeof cache.totalPages === "number" ? cache.totalPages : undefined,
      totalChapters: typeof cache.totalChapters === "number" ? cache.totalChapters : undefined,
      chapters,
      updatedAt: typeof cache.updatedAt === "string" ? cache.updatedAt : new Date(0).toISOString(),
    });
  }

  private mergeIntoCache(
    mangaId: string,
    cache: ChapterCache | undefined,
    chapters: Chapter[],
    fetchedPage?: number,
    totalChapters?: number,
    totalPages?: number,
  ): ChapterCache {
    const workingCache = cache ?? this.createEmptyCache();
    const merged = new Map<string, SerializedChapter>();

    for (const chapter of workingCache.chapters) {
      merged.set(chapter.chapterId, chapter);
    }

    for (const chapter of chapters) {
      merged.set(chapter.chapterId, this.serializeChapter(chapter));
    }

    const fetchedPages = new Set<number>(workingCache.fetchedPages);
    if (fetchedPage !== undefined) {
      fetchedPages.add(fetchedPage);
    }

    const resolvedTotalPages =
      totalPages ??
      workingCache.totalPages ??
      (totalChapters ? Math.ceil(totalChapters / CHAPTERS_PER_PAGE) : undefined);

    const normalizedCache = this.normalizeCache({
      version: CACHE_VERSION,
      complete: workingCache.complete,
      fetchedPages: [...fetchedPages],
      totalPages: resolvedTotalPages,
      totalChapters: totalChapters ?? workingCache.totalChapters,
      chapters: [...merged.values()],
      updatedAt: new Date().toISOString(),
    });

    return this.saveCache(mangaId, normalizedCache);
  }

  private normalizeCache(cache: ChapterCache): ChapterCache {
    const chapters = [...cache.chapters].sort((left, right) => left.sortingIndex - right.sortingIndex);
    const fetchedPages = [...new Set(cache.fetchedPages)].sort((left, right) => left - right);
    const totalPages = cache.totalPages;

    return {
      ...cache,
      complete: totalPages !== undefined ? fetchedPages.length >= totalPages : cache.complete,
      fetchedPages,
      chapters,
    };
  }

  private hydrateChapters(serializedChapters: SerializedChapter[], sourceManga: SourceManga): Chapter[] {
    return serializedChapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      sourceManga,
      langCode: "en",
      chapNum: chapter.chapNum,
      title: chapter.title,
      sortingIndex: chapter.sortingIndex,
    }));
  }

  private serializeChapter(chapter: Chapter): SerializedChapter {
    return {
      chapterId: chapter.chapterId,
      chapNum: chapter.chapNum,
      title: chapter.title,
      sortingIndex: chapter.sortingIndex ?? 0,
    };
  }

  private createEmptyCache(): ChapterCache {
    return {
      version: CACHE_VERSION,
      complete: false,
      fetchedPages: [],
      chapters: [],
      updatedAt: new Date(0).toISOString(),
    };
  }

  private isSerializedChapter(value: unknown): value is SerializedChapter {
    if (!value || typeof value !== "object") {
      return false;
    }

    const chapter = value as Partial<SerializedChapter>;
    return (
      typeof chapter.chapterId === "string" &&
      typeof chapter.chapNum === "number" &&
      typeof chapter.sortingIndex === "number"
    );
  }

  private saveCache(mangaId: string, cache: ChapterCache): ChapterCache {
    const normalizedCache = this.normalizeCache(cache);
    const chunks = this.chunkChapters(normalizedCache.chapters);
    const existingState = Application.getState(cacheKey(mangaId));
    const existingChunkCount =
      existingState &&
      typeof existingState === "object" &&
      typeof (existingState as Partial<ChapterCacheMetadata>).chunkCount === "number"
        ? (existingState as ChapterCacheMetadata).chunkCount
        : 0;

    const metadata: ChapterCacheMetadata = {
      version: normalizedCache.version,
      complete: normalizedCache.complete,
      fetchedPages: normalizedCache.fetchedPages,
      totalPages: normalizedCache.totalPages,
      totalChapters: normalizedCache.totalChapters,
      updatedAt: normalizedCache.updatedAt,
      chunkCount: chunks.length,
    };

    for (const [index, chunk] of chunks.entries()) {
      Application.setState(chunk, cacheChunkKey(mangaId, index));
    }

    for (let chunkIndex = chunks.length; chunkIndex < existingChunkCount; chunkIndex += 1) {
      Application.setState([], cacheChunkKey(mangaId, chunkIndex));
    }

    Application.setState(metadata, cacheKey(mangaId));
    return normalizedCache;
  }

  private chunkChapters(chapters: SerializedChapter[]): SerializedChapter[][] {
    const chunks: SerializedChapter[][] = [];
    for (let index = 0; index < chapters.length; index += CHAPTER_CACHE_CHUNK_SIZE) {
      chunks.push(chapters.slice(index, index + CHAPTER_CACHE_CHUNK_SIZE));
    }
    return chunks;
  }

  private prepareChaptersForReturn(chapters: Chapter[], sourceManga: SourceManga): Chapter[] {
    if (this.estimateChapterPayloadSize(chapters) <= this.chapterPayloadLimit) {
      return chapters;
    }

    const compactChapters = chapters.map((chapter) => this.compactChapterForReturn(chapter, sourceManga));
    if (this.estimateChapterPayloadSize(compactChapters) <= this.chapterPayloadLimit) {
      return compactChapters;
    }

    return this.trimChaptersForPayload(compactChapters);
  }

  private compactChapterForReturn(chapter: Chapter, sourceManga: SourceManga): Chapter {
    return {
      chapterId: chapter.chapterId,
      sourceManga,
      chapNum: chapter.chapNum,
      langCode: chapter.langCode || "en",
    } as Chapter;
  }

  private trimChaptersForPayload(chapters: Chapter[]): Chapter[] {
    const trimmed: Chapter[] = [];
    let estimatedSize = 2;

    for (let index = chapters.length - 1; index >= 0; index -= 1) {
      const chapter = chapters[index];
      const chapterSize = this.estimateChapterPayloadSize([chapter]) + (trimmed.length > 0 ? 1 : 0);
      if (estimatedSize + chapterSize > this.chapterPayloadLimit) {
        break;
      }

      trimmed.unshift(chapter);
      estimatedSize += chapterSize;
    }

    return trimmed.length > 0 ? trimmed : chapters.slice(-1);
  }

  private estimateChapterPayloadSize(chapters: Chapter[]): number {
    return JSON.stringify(
      chapters.map((chapter) => ({
        chapterId: chapter.chapterId,
        chapNum: chapter.chapNum,
        langCode: chapter.langCode,
        title: chapter.title,
        version: chapter.version,
        volume: chapter.volume,
        sortingIndex: chapter.sortingIndex,
        publishDate: chapter.publishDate?.toISOString(),
        creationDate: chapter.creationDate?.toISOString(),
        additionalInfo: chapter.additionalInfo,
      })),
    ).length;
  }
}

type ChapterPageResult = {
  totalPages: number;
  chapters: Chapter[];
};

export const NovelFull = new NovelFullExtension();
