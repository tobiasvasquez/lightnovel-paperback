import {
  CACHE_VERSION,
  CHAPTER_CACHE_CHUNK_SIZE,
} from "./models";

export type SkyNovelsSerializedChapter = {
  chapterId: string;
  chapNum: number;
  title?: string;
  volume?: number;
  publishDate?: string;
  sortingIndex: number;
};

export type SkyNovelsChapterCache = {
  version: number;
  complete: boolean;
  fetchedPages: number[];
  totalPages?: number;
  totalChapters?: number;
  chapters: SkyNovelsSerializedChapter[];
  updatedAt: string;
};

type SkyNovelsChapterCacheMetadata = Omit<SkyNovelsChapterCache, "chapters"> & {
  chunkCount: number;
};

export type SkyNovelsCacheScope =
  | { kind: "volume"; novelId: string; volumeId: number }
  | { kind: "fallback"; novelId: string };

function cachePrefix(scope: SkyNovelsCacheScope): string {
  return scope.kind === "volume"
    ? `skynovels:chapters:v${CACHE_VERSION}:${scope.novelId}:volume:${scope.volumeId}`
    : `skynovels:chapters:v${CACHE_VERSION}:${scope.novelId}:fallback`;
}

function cacheKey(scope: SkyNovelsCacheScope): string {
  return cachePrefix(scope);
}

function cacheChunkKey(scope: SkyNovelsCacheScope, chunkIndex: number): string {
  return `${cachePrefix(scope)}:chunk:${chunkIndex}`;
}

function isSerializedChapter(value: unknown): value is SkyNovelsSerializedChapter {
  if (!value || typeof value !== "object") {
    return false;
  }

  const chapter = value as Partial<SkyNovelsSerializedChapter>;
  return (
    typeof chapter.chapterId === "string" &&
    typeof chapter.chapNum === "number" &&
    typeof chapter.sortingIndex === "number"
  );
}

function normalizeCache(cache: SkyNovelsChapterCache): SkyNovelsChapterCache {
  const chapters = [...cache.chapters].sort((left, right) => {
    if (left.chapNum !== right.chapNum) {
      return left.chapNum - right.chapNum;
    }

    return left.sortingIndex - right.sortingIndex;
  });
  const fetchedPages = [...new Set(cache.fetchedPages)].sort((left, right) => left - right);
  const complete = cache.totalPages !== undefined
    ? Array.from({ length: cache.totalPages }, (_, index) => fetchedPages.includes(index + 1)).every(Boolean)
    : cache.complete;

  return {
    ...cache,
    complete,
    fetchedPages,
    chapters,
  };
}

export function readChapterCache(scope: SkyNovelsCacheScope): SkyNovelsChapterCache | undefined {
  const state = Application.getState(cacheKey(scope));
  if (!state || typeof state !== "object") {
    return undefined;
  }

  const metadata = state as Partial<SkyNovelsChapterCacheMetadata>;
  if (
    metadata.version !== CACHE_VERSION ||
    !Array.isArray(metadata.fetchedPages) ||
    typeof metadata.chunkCount !== "number"
  ) {
    return undefined;
  }

  const chapters: SkyNovelsSerializedChapter[] = [];
  for (let chunkIndex = 0; chunkIndex < metadata.chunkCount; chunkIndex += 1) {
    const chunk = Application.getState(cacheChunkKey(scope, chunkIndex));
    if (!Array.isArray(chunk)) {
      return undefined;
    }

    chapters.push(...chunk.filter(isSerializedChapter));
  }

  return normalizeCache({
    version: CACHE_VERSION,
    complete: Boolean(metadata.complete),
    fetchedPages: metadata.fetchedPages.filter((page): page is number => typeof page === "number"),
    totalPages: typeof metadata.totalPages === "number" ? metadata.totalPages : undefined,
    totalChapters: typeof metadata.totalChapters === "number" ? metadata.totalChapters : undefined,
    chapters,
    updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : new Date(0).toISOString(),
  });
}

export function writeChapterCache(scope: SkyNovelsCacheScope, cache: SkyNovelsChapterCache): SkyNovelsChapterCache {
  const normalizedCache = normalizeCache(cache);
  const chunks: SkyNovelsSerializedChapter[][] = [];
  for (let index = 0; index < normalizedCache.chapters.length; index += CHAPTER_CACHE_CHUNK_SIZE) {
    chunks.push(normalizedCache.chapters.slice(index, index + CHAPTER_CACHE_CHUNK_SIZE));
  }

  const previousState = Application.getState(cacheKey(scope));
  const previousChunkCount =
    previousState && typeof previousState === "object" &&
    typeof (previousState as Partial<SkyNovelsChapterCacheMetadata>).chunkCount === "number"
      ? (previousState as SkyNovelsChapterCacheMetadata).chunkCount
      : 0;

  for (const [index, chunk] of chunks.entries()) {
    Application.setState(chunk, cacheChunkKey(scope, index));
  }

  for (let index = chunks.length; index < previousChunkCount; index += 1) {
    Application.setState([], cacheChunkKey(scope, index));
  }

  const metadata: SkyNovelsChapterCacheMetadata = {
    ...normalizedCache,
    chunkCount: chunks.length,
  };
  Application.setState(metadata, cacheKey(scope));

  return normalizedCache;
}

export function mergeChapterCache(
  scope: SkyNovelsCacheScope,
  cache: SkyNovelsChapterCache | undefined,
  chapters: SkyNovelsSerializedChapter[],
  fetchedPage?: number,
  totalChapters?: number,
  totalPages?: number,
): SkyNovelsChapterCache {
  const workingCache = cache ?? {
    version: CACHE_VERSION,
    complete: false,
    fetchedPages: [],
    chapters: [],
    updatedAt: new Date(0).toISOString(),
  } satisfies SkyNovelsChapterCache;
  const merged = new Map<string, SkyNovelsSerializedChapter>();

  for (const chapter of workingCache.chapters) {
    merged.set(chapter.chapterId, chapter);
  }

  for (const chapter of chapters) {
    merged.set(chapter.chapterId, chapter);
  }

  const fetchedPages = new Set(workingCache.fetchedPages);
  if (fetchedPage !== undefined) {
    fetchedPages.add(fetchedPage);
  }

  const resolvedTotalPages = totalPages ?? workingCache.totalPages;
  const complete = resolvedTotalPages !== undefined
    ? Array.from({ length: resolvedTotalPages }, (_, index) => fetchedPages.has(index + 1)).every(Boolean)
    : workingCache.complete;
  return writeChapterCache(scope, {
    ...workingCache,
    complete,
    fetchedPages: [...fetchedPages],
    totalPages: resolvedTotalPages,
    totalChapters: totalChapters ?? workingCache.totalChapters,
    chapters: [...merged.values()],
    updatedAt: new Date().toISOString(),
  });
}

export function serializeChapter(chapter: {
  chapterId: string;
  chapNum: number;
  title?: string;
  volume?: number;
  publishDate?: Date;
  sortingIndex?: number;
}): SkyNovelsSerializedChapter {
  return {
    chapterId: chapter.chapterId,
    chapNum: chapter.chapNum,
    title: chapter.title,
    volume: chapter.volume,
    publishDate: chapter.publishDate?.toISOString(),
    sortingIndex: chapter.sortingIndex ?? 0,
  };
}
