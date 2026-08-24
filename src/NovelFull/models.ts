import type { Chapter, ContentRating } from "@paperback/types";

export const DOMAIN = "https://novelfull.com";
export const CHAPTERS_PER_PAGE = 50;
export const CACHE_VERSION = 1;
export const CHAPTER_CACHE_CHUNK_SIZE = 500;
export const SPLIT_THRESHOLD = 1000;
export const PART_SIZE = 500;
export const LANGUAGE = "en";

export type SearchNovel = {
  title: string;
  author: string;
  slug: string;
  coverPath?: string;
  genres?: string[];
  latestChapterNumber?: number;
};

export type SerializedChapter = {
  chapterId: string;
  chapNum: number;
  title?: string;
  sortingIndex: number;
};

export type ChapterCache = {
  version: number;
  complete: boolean;
  fetchedPages: number[];
  totalPages?: number;
  totalChapters?: number;
  chapters: SerializedChapter[];
  updatedAt: string;
};

export type ChapterCacheMetadata = Omit<ChapterCache, "chapters"> & {
  chunkCount: number;
};

export type SplitPartInfo = {
  baseSlug: string;
  partNumber: number;
  rangeStart: number;
  rangeEnd: number;
};

export type NovelPageInfo = {
  title: string;
  author: string;
  alternativeTitles: string[];
  cover: string;
  synopsis: string;
  genres: string[];
  source?: string;
  status?: string;
  rating?: number;
  ratingCount?: number;
  totalPages: number;
  pageChapterCount: number;
  totalChapters?: number;
  contentRating: ContentRating;
};

export type ChapterPageInfo = {
  totalPages: number;
  chapters: Chapter[];
};

function joinUrl(base: string, path: string): string {
  if (!path) {
    return base;
  }

  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  if (path.startsWith("//")) {
    return `https:${path}`;
  }

  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function absoluteUrl(url: string | undefined | null): string {
  if (!url) {
    return "";
  }

  return joinUrl(DOMAIN, url);
}

export function searchUrl(query: string, page = 1): string {
  const params = `keyword=${encodeURIComponent(query)}${page > 1 ? `&page=${encodeURIComponent(String(page))}` : ""}`;
  return `${DOMAIN}/search?${params}`;
}

export function mangaUrl(mangaId: string, page = 1): string {
  const baseUrl = `${DOMAIN}/${encodeURIComponent(mangaId)}.html`;
  return page > 1 ? `${baseUrl}?page=${encodeURIComponent(String(page))}` : baseUrl;
}

export function chapterUrl(mangaId: string, chapterId: string): string {
  const chapterPath = chapterId.replace(/^\/+/, "").replace(/\.html$/i, "");
  return `${DOMAIN}/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapterPath)}.html`;
}

export function novelSlugFromHref(href: string | undefined): string {
  if (!href) {
    return "";
  }

  let pathname = href;
  try {
    pathname = new URL(href, DOMAIN).pathname;
  } catch {
    pathname = href.split("?")[0] ?? href;
  }

  const slug = pathname.split("/").filter(Boolean).at(-1) ?? "";
  return decodeURIComponent(slug).replace(/\.html$/i, "");
}

export function chapterIdFromHref(href: string | undefined): string {
  if (!href) {
    return "";
  }

  let pathname = href;
  try {
    pathname = new URL(href, DOMAIN).pathname;
  } catch {
    pathname = href.split("?")[0] ?? href;
  }

  const chapterId = pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(chapterId).replace(/\.html$/i, "");
  } catch {
    return chapterId.replace(/\.html$/i, "");
  }
}

export function cacheKey(mangaId: string): string {
  return `novelfull:chapters:v${CACHE_VERSION}:${mangaId}`;
}

export function cacheChunkKey(mangaId: string, chunkIndex: number): string {
  return `${cacheKey(mangaId)}:chunk:${chunkIndex}`;
}

export function shouldSplitTitle(totalChapters: number | undefined): totalChapters is number {
  return typeof totalChapters === "number" && totalChapters > SPLIT_THRESHOLD;
}

export function getPartCount(totalChapters: number): number {
  return Math.max(1, Math.ceil(totalChapters / PART_SIZE));
}

export function getSplitPart(baseSlug: string, partNumber: number): SplitPartInfo {
  const rangeStart = (partNumber - 1) * PART_SIZE + 1;
  return {
    baseSlug,
    partNumber,
    rangeStart,
    rangeEnd: rangeStart + PART_SIZE - 1,
  };
}

export function createPartMangaId(baseSlug: string, partNumber: number): string {
  return `${baseSlug}::part:${partNumber}`;
}

export function parsePartMangaId(mangaId: string): SplitPartInfo | undefined {
  const match = mangaId.match(/^(.*)::part:(\d+)$/);
  if (!match) {
    return undefined;
  }

  const [, baseSlug, rawPartNumber] = match;
  const partNumber = Number(rawPartNumber);
  if (!baseSlug || !Number.isInteger(partNumber) || partNumber < 1) {
    return undefined;
  }

  return getSplitPart(baseSlug, partNumber);
}

export function buildPartTitle(title: string, partNumber: number): string {
  return `${title} Part ${String(partNumber).padStart(2, "0")}`;
}

export function formatPartRange(part: SplitPartInfo, totalChapters?: number): string {
  const rangeEnd = totalChapters ? Math.min(totalChapters, part.rangeEnd) : part.rangeEnd;
  return `${part.rangeStart}-${rangeEnd}`;
}

export function getVisiblePartChapterCount(part: SplitPartInfo, totalChapters: number): number {
  if (totalChapters < part.rangeStart) {
    return 0;
  }

  return Math.max(0, Math.min(totalChapters, part.rangeEnd) - part.rangeStart + 1);
}
