import {
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
  BLOCK_SIZE,
  CHAPTERS_PER_PAGE,
  SEGMENTATION_THRESHOLD,
  blockMangaId,
  buildSearchScore,
  chapterApiUrl,
  getBlockRange,
  hasStrongSearchMatch,
  novelBaseApiUrl,
  novelChaptersApiUrl,
  novelGenresApiUrl,
  novelStatsApiUrl,
  novelVolumesApiUrl,
  parseSegmentMangaId,
  searchApiUrl,
  volumeChaptersApiUrl,
  volumeMangaId,
  type SkyNovelsChapterResponse,
  type SkyNovelsGenresResponse,
  type SkyNovelsNovelBaseResponse,
  type SkyNovelsNovelChaptersResponse,
  type SkyNovelsNovelSummary,
  type SkyNovelsSearchResponse,
  type SkyNovelsStatsResponse,
  type SkyNovelsVolume,
  type SkyNovelsVolumeChaptersResponse,
  type SkyNovelsVolumesResponse,
} from "./models";
import {
  mergeChapterCache,
  readChapterCache,
  serializeChapter,
  type SkyNovelsCacheScope,
  type SkyNovelsChapterCache,
  type SkyNovelsSerializedChapter,
} from "./cache";
import { fetchJSON, mainRateLimiter } from "./network";
import { SkyNovelsParser } from "./parser";
import SkyNovelsConfig from "./pbconfig";

export class SkyNovelsExtension implements ExtensionImpl<typeof SkyNovelsConfig> {
  private readonly parser = new SkyNovelsParser();

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const title = query.title.trim();
    if (!title) {
      return { items: [] };
    }

    const page = this.getSearchPage(metadata ?? query.metadata);
    const primaryResults = await this.searchNovels(title, page);
    let mergedResults = primaryResults.novels ?? [];

    if (!hasStrongSearchMatch(title, mergedResults)) {
      const fallbackTerm = title.split(/\s+/).find((token) => token.length >= 3);
      if (fallbackTerm && fallbackTerm.toLowerCase() !== title.toLowerCase()) {
        const fallbackResults = await this.searchNovels(fallbackTerm, page);
        mergedResults = this.mergeNovelResults(mergedResults, fallbackResults.novels ?? []);
      }
    }

    const sortedResults = [...mergedResults].sort((left, right) => {
      const scoreDifference = buildSearchScore(title, right) - buildSearchScore(title, left);
      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      const popularityDifference =
        Number(right.nvl_ratings_count ?? 0) - Number(left.nvl_ratings_count ?? 0);
      if (popularityDifference !== 0) {
        return popularityDifference;
      }

      return left.nvl_title.localeCompare(right.nvl_title, "es", { sensitivity: "base" });
    });

    const items: SearchResultItem[] = [];
    for (const result of sortedResults) {
      items.push(...(await this.buildSearchResults(result)));
    }

    const totalPages = primaryResults.totalPages ?? 1;
    return {
      items,
      metadata: page < totalPages ? { skynovelsPage: page + 1 } : undefined,
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const segment = parseSegmentMangaId(mangaId);
    const [baseResponse, genresResponse, statsResponse] = await Promise.all([
      fetchJSON<SkyNovelsNovelBaseResponse>(novelBaseApiUrl(segment.novelId)),
      fetchJSON<SkyNovelsGenresResponse>(novelGenresApiUrl(segment.novelId)),
      fetchJSON<SkyNovelsStatsResponse>(novelStatsApiUrl(segment.novelId)),
    ]);

    const sourceManga = this.parser.parseNovelDetails(
      segment.novelId,
      baseResponse.novel,
      genresResponse.genres ?? [],
      statsResponse,
    );

    if (segment.kind === "legacy") {
      return sourceManga;
    }

    if (segment.kind === "volume") {
      const volume = (await this.fetchVolumes(segment.novelId)).find((item) => item.id === segment.volumeId);
      return this.createVolumeSourceManga(sourceManga, mangaId, volume);
    }

    const range = getBlockRange(segment.blockNumber);
    return this.createBlockSourceManga(sourceManga, mangaId, segment.blockNumber, range.rangeStart, range.rangeEnd);
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const segment = parseSegmentMangaId(sourceManga.mangaId);
    let chapters: Chapter[];

    if (segment.kind === "volume") {
      const volume = (await this.fetchVolumes(segment.novelId)).find((item) => item.id === segment.volumeId);
      chapters = volume ? await this.resolveVolumeChapters(segment.novelId, volume, sourceManga) : [];
    } else if (segment.kind === "block") {
      const allChapters = await this.resolveFallbackChapters(segment.novelId, sourceManga);
      const range = getBlockRange(segment.blockNumber);
      chapters = allChapters.filter(
        (chapter) => chapter.chapNum >= range.rangeStart && chapter.chapNum <= range.rangeEnd,
      );
    } else {
      const volumes = await this.fetchVolumes(segment.novelId);
      if (volumes.length > 0) {
        const volumeChapters = await Promise.all(
          volumes.map((volume) => this.resolveVolumeChapters(segment.novelId, volume, sourceManga)),
        );
        chapters = this.mergeChapterLists(volumeChapters);
      } else {
        chapters = await this.resolveFallbackChapters(segment.novelId, sourceManga);
      }
    }

    return sinceDate
      ? chapters.filter((chapter) => !chapter.publishDate || chapter.publishDate > sinceDate)
      : chapters;
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const response = await fetchJSON<SkyNovelsChapterResponse>(chapterApiUrl(chapter.chapterId));
    return this.parser.parseChapterDetails(chapter, response.chapter);
  }

  async processTitlesForUpdates(updateManager: UpdateManager, _lastUpdateDate?: Date): Promise<void> {
    const statsCache = new Map<string, SkyNovelsStatsResponse>();
    const volumesCache = new Map<string, SkyNovelsVolume[]>();

    for (const sourceManga of updateManager.getQueuedItems()) {
      const segment = parseSegmentMangaId(sourceManga.mangaId);

      try {
        if (segment.kind === "volume") {
          const volumes = await this.getCachedVolumes(segment.novelId, volumesCache);
          const volume = volumes.find((item) => item.id === segment.volumeId);
          const latestChapterCount = volume?.chapters_count;
          const knownChapterCount = await this.getKnownChapterCount(updateManager, sourceManga);

          if (latestChapterCount === undefined || latestChapterCount < knownChapterCount) {
            await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
            continue;
          }

          if (latestChapterCount === knownChapterCount) {
            await updateManager.setUpdatePriority(sourceManga.mangaId, "skip");
            continue;
          }

          if (!volume) {
            await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
            continue;
          }

          const chapters = await this.resolveVolumeChapters(segment.novelId, volume, sourceManga);
          const newChapters = chapters.slice(knownChapterCount);
          if (newChapters.length > 0) {
            await updateManager.setNewChapters(sourceManga.mangaId, newChapters);
          }
          await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
          continue;
        }

        if (segment.kind === "block") {
          const stats = await this.getCachedStats(segment.novelId, statsCache);
          const latestChapterCount = stats.nvl_chapters;
          const knownChapterCount = await this.getKnownChapterCount(updateManager, sourceManga);
          const range = getBlockRange(segment.blockNumber);
          const visibleChapterCount = latestChapterCount === undefined
            ? undefined
            : Math.max(0, Math.min(latestChapterCount, range.rangeEnd) - range.rangeStart + 1);

          if (visibleChapterCount === undefined || visibleChapterCount < knownChapterCount) {
            await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
            continue;
          }

          if (visibleChapterCount === knownChapterCount) {
            await updateManager.setUpdatePriority(sourceManga.mangaId, "skip");
            continue;
          }

          const chapters = (await this.resolveFallbackChapters(segment.novelId, sourceManga)).filter(
            (chapter) => chapter.chapNum >= range.rangeStart && chapter.chapNum <= range.rangeEnd,
          );
          const newChapters = chapters.slice(knownChapterCount);
          if (newChapters.length > 0) {
            await updateManager.setNewChapters(sourceManga.mangaId, newChapters);
          }
          await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
          continue;
        }

        const stats = await this.getCachedStats(segment.novelId, statsCache);
        const latestChapterCount = stats.nvl_chapters;
        const knownChapterCount = await this.getKnownChapterCount(updateManager, sourceManga);
        await updateManager.setUpdatePriority(
          sourceManga.mangaId,
          latestChapterCount !== undefined && latestChapterCount <= knownChapterCount ? "skip" : "high",
        );
      } catch {
        await updateManager.setUpdatePriority(sourceManga.mangaId, "high");
      }
    }
  }

  async initialise(): Promise<void> {
    mainRateLimiter.registerInterceptor();
  }

  private async searchNovels(title: string, page: number): Promise<SkyNovelsSearchResponse> {
    return fetchJSON<SkyNovelsSearchResponse>(searchApiUrl(title, page));
  }

  private async buildSearchResults(result: SkyNovelsNovelSummary): Promise<SearchResultItem[]> {
    const [baseResult] = this.parser.parseSearchResults([result]);
    if (!baseResult) {
      return [];
    }

    const totalChapters = Number(result.nvl_chapters ?? 0);
    if (totalChapters <= SEGMENTATION_THRESHOLD) {
      return [baseResult];
    }

    try {
      const volumes = await this.fetchVolumes(String(result.id));
      if (volumes.length > 0) {
        return volumes.map((volume) => ({
          ...baseResult,
          mangaId: volumeMangaId(String(result.id), volume.id),
          title: `${baseResult.title} — ${volume.vlm_title}`,
          subtitle: `${baseResult.subtitle ?? ""}${baseResult.subtitle ? " • " : ""}${volume.chapters_count ?? "?"} capítulos`,
        }));
      }
    } catch {
      return [baseResult];
    }

    return Array.from({ length: Math.ceil(totalChapters / BLOCK_SIZE) }, (_, index) => {
      const blockNumber = index + 1;
      const range = getBlockRange(blockNumber);
      const rangeEnd = Math.min(totalChapters, range.rangeEnd);
      return {
        ...baseResult,
        mangaId: blockMangaId(String(result.id), blockNumber),
        title: `${baseResult.title} — Capítulos ${range.rangeStart}-${rangeEnd}`,
        subtitle: baseResult.subtitle,
      };
    });
  }

  private mergeNovelResults(...resultSets: SkyNovelsNovelSummary[][]): SkyNovelsNovelSummary[] {
    const seenIds = new Set<number>();
    const mergedResults: SkyNovelsNovelSummary[] = [];

    for (const resultSet of resultSets) {
      for (const result of resultSet) {
        if (seenIds.has(result.id)) {
          continue;
        }

        seenIds.add(result.id);
        mergedResults.push(result);
      }
    }

    return mergedResults;
  }

  private getSearchPage(metadata: Metadata | undefined): number {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return 1;
    }

    const page = (metadata as { skynovelsPage?: unknown }).skynovelsPage;
    return typeof page === "number" && Number.isInteger(page) && page > 0 ? page : 1;
  }

  private async fetchVolumes(novelId: string): Promise<SkyNovelsVolume[]> {
    const response = await fetchJSON<SkyNovelsVolumesResponse>(novelVolumesApiUrl(novelId));
    return response.volumes ?? [];
  }

  private async getCachedVolumes(novelId: string, cache: Map<string, SkyNovelsVolume[]>): Promise<SkyNovelsVolume[]> {
    const cached = cache.get(novelId);
    if (cached) {
      return cached;
    }

    const volumes = await this.fetchVolumes(novelId);
    cache.set(novelId, volumes);
    return volumes;
  }

  private createVolumeSourceManga(sourceManga: SourceManga, mangaId: string, volume?: SkyNovelsVolume): SourceManga {
    const segment = parseSegmentMangaId(mangaId);
    const title = volume?.vlm_title?.trim() || `Volumen ${segment.kind === "volume" ? segment.volumeId : ""}`;
    const additionalInfo = {
      ...sourceManga.mangaInfo.additionalInfo,
      baseNovelId: sourceManga.mangaId,
      segmentType: "volume",
      volumeId: volume ? String(volume.id) : "",
      volumeTitle: title,
      volumeChapterCount: volume?.chapters_count ? String(volume.chapters_count) : "",
    };

    return {
      ...sourceManga,
      mangaId,
      mangaInfo: {
        ...sourceManga.mangaInfo,
        primaryTitle: `${sourceManga.mangaInfo.primaryTitle} — ${title}`,
        synopsis: `Volumen: ${title}.\n\n${sourceManga.mangaInfo.synopsis}`,
        additionalInfo,
      },
    };
  }

  private createBlockSourceManga(
    sourceManga: SourceManga,
    mangaId: string,
    blockNumber: number,
    rangeStart: number,
    rangeEnd: number,
  ): SourceManga {
    return {
      ...sourceManga,
      mangaId,
      mangaInfo: {
        ...sourceManga.mangaInfo,
        primaryTitle: `${sourceManga.mangaInfo.primaryTitle} — Capítulos ${rangeStart}-${rangeEnd}`,
        synopsis: `Capítulos ${rangeStart}-${rangeEnd}.\n\n${sourceManga.mangaInfo.synopsis}`,
        additionalInfo: {
          ...sourceManga.mangaInfo.additionalInfo,
          baseNovelId: sourceManga.mangaId,
          segmentType: "block",
          blockNumber: String(blockNumber),
          rangeStart: String(rangeStart),
          rangeEnd: String(rangeEnd),
        },
      },
    };
  }

  private async resolveVolumeChapters(
    novelId: string,
    volume: SkyNovelsVolume,
    sourceManga: SourceManga,
  ): Promise<Chapter[]> {
    const scope: SkyNovelsCacheScope = { kind: "volume", novelId, volumeId: volume.id };
    let cache = readChapterCache(scope);
    if (cache?.complete && (volume.chapters_count === undefined || cache.totalChapters === volume.chapters_count)) {
      return this.hydrateChapters(cache.chapters, sourceManga);
    }

    if (cache?.complete && volume.chapters_count !== cache.totalChapters) {
      cache = undefined;
    }

    cache = await this.fetchVolumeChapters(novelId, volume, sourceManga, scope, cache);
    return this.hydrateChapters(cache.chapters, sourceManga);
  }

  private async fetchVolumeChapters(
    novelId: string,
    volume: SkyNovelsVolume,
    sourceManga: SourceManga,
    scope: SkyNovelsCacheScope,
    existingCache?: SkyNovelsChapterCache,
  ): Promise<SkyNovelsChapterCache> {
    let cache = existingCache;
    let totalPages = cache?.totalPages;

    if (!cache?.fetchedPages.includes(1) || totalPages === undefined) {
      const response = await fetchJSON<SkyNovelsVolumeChaptersResponse>(
        volumeChaptersApiUrl(novelId, volume.id, 1),
      );
      totalPages = this.getResponseTotalPages(response, volume.chapters_count);
      cache = mergeChapterCache(
        scope,
        cache,
        this.parseAndSerializeChapters(sourceManga, volume, response.items ?? [], 0),
        1,
        response.pagination?.total ?? volume.chapters_count,
        totalPages,
      );
    }

    for (let page = 1; page <= (totalPages ?? 1); page += 1) {
      if (cache.fetchedPages.includes(page)) {
        continue;
      }

      const response = await fetchJSON<SkyNovelsVolumeChaptersResponse>(
        volumeChaptersApiUrl(novelId, volume.id, page),
      );
      cache = mergeChapterCache(
        scope,
        cache,
        this.parseAndSerializeChapters(sourceManga, volume, response.items ?? [], (page - 1) * CHAPTERS_PER_PAGE),
        page,
        response.pagination?.total ?? volume.chapters_count,
        this.getResponseTotalPages(response, volume.chapters_count),
      );
    }

    return cache;
  }

  private async resolveFallbackChapters(novelId: string, sourceManga: SourceManga): Promise<Chapter[]> {
    const scope: SkyNovelsCacheScope = { kind: "fallback", novelId };
    const cached = readChapterCache(scope);
    if (cached?.complete) {
      return this.hydrateChapters(cached.chapters, sourceManga);
    }

    const response = await fetchJSON<SkyNovelsNovelChaptersResponse>(novelChaptersApiUrl(novelId));
    const rawChapters = response.novel?.find((novel) => String(novel.id) === novelId)?.chapters ?? [];
    const chapters = this.parser.parseChapters(
      sourceManga,
      [{ volume: { id: 0, vlm_title: "", chapters_count: rawChapters.length }, chapters: rawChapters }],
    );
    const cache = mergeChapterCache(
      scope,
      undefined,
      chapters.map(serializeChapter),
      1,
      chapters.length,
      1,
    );
    return this.hydrateChapters(cache.chapters, sourceManga);
  }

  private parseAndSerializeChapters(
    sourceManga: SourceManga,
    volume: SkyNovelsVolume,
    chapters: NonNullable<SkyNovelsVolumeChaptersResponse["items"]>,
    sortingOffset: number,
  ): SkyNovelsSerializedChapter[] {
    return this.parser
      .parseChapters(sourceManga, [{ volume, chapters }], sortingOffset)
      .map(serializeChapter);
  }

  private getResponseTotalPages(
    response: SkyNovelsVolumeChaptersResponse,
    expectedChapterCount?: number,
  ): number {
    if (response.pagination?.totalPages && response.pagination.totalPages > 0) {
      return response.pagination.totalPages;
    }

    const total = response.pagination?.total ?? expectedChapterCount ?? response.items?.length ?? 0;
    return Math.max(1, Math.ceil(total / CHAPTERS_PER_PAGE));
  }

  private hydrateChapters(chapters: SkyNovelsSerializedChapter[], sourceManga: SourceManga): Chapter[] {
    return chapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      sourceManga,
      langCode: "es",
      chapNum: chapter.chapNum,
      title: chapter.title,
      volume: chapter.volume,
      publishDate: chapter.publishDate ? new Date(chapter.publishDate) : undefined,
      sortingIndex: chapter.sortingIndex,
    }));
  }

  private mergeChapterLists(chapterLists: Chapter[][]): Chapter[] {
    const merged = new Map<string, Chapter>();
    for (const chapters of chapterLists) {
      for (const chapter of chapters) {
        merged.set(chapter.chapterId, chapter);
      }
    }

    return [...merged.values()].sort((left, right) => {
      if (left.chapNum !== right.chapNum) {
        return left.chapNum - right.chapNum;
      }

      return (left.sortingIndex ?? 0) - (right.sortingIndex ?? 0);
    });
  }

  private async getCachedStats(
    novelId: string,
    cache: Map<string, SkyNovelsStatsResponse>,
  ): Promise<SkyNovelsStatsResponse> {
    const cached = cache.get(novelId);
    if (cached) {
      return cached;
    }

    const stats = await fetchJSON<SkyNovelsStatsResponse>(novelStatsApiUrl(novelId));
    cache.set(novelId, stats);
    return stats;
  }

  private async getKnownChapterCount(updateManager: UpdateManager, sourceManga: SourceManga): Promise<number> {
    return sourceManga.chapterCount ?? (await updateManager.getNumberOfChapters(sourceManga.mangaId));
  }
}

export const SkyNovels = new SkyNovelsExtension();
