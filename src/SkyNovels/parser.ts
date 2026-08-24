import {
  type Chapter,
  type ChapterDetails,
  type SearchResultItem,
  type SourceManga,
} from "@paperback/types";
import * as cheerio from "cheerio";

import {
  LANGUAGE,
  absoluteSkyNovelsUrl,
  cleanChapterTitle,
  inferContentRating,
  mapNovelStatus,
  normalizeWhitespace,
  novelCoverUrl,
  searchCoverUrl,
  novelUrl,
  parseChapterNumber,
  parseVolumeNumber,
  slugifyTag,
  type SkyNovelsChapterDetails,
  type SkyNovelsGenre,
  type SkyNovelsNovelBase,
  type SkyNovelsNovelSummary,
  type SkyNovelsStatsResponse,
  type SkyNovelsVolume,
  type SkyNovelsVolumeChapter,
} from "./models";

export type VolumeChapterSet = {
  volume: SkyNovelsVolume;
  chapters: SkyNovelsVolumeChapter[];
};

const INVISIBLE_CHARACTERS_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const ESCAPED_MARKDOWN_REGEX = /\\([\\`*_{}\[\]()#+\-.!>])/g;
const HTML_TAG_REGEX = /<\/?(?:a|blockquote|br|div|em|h[1-6]|hr|img|li|ol|p|span|strong|ul)\b[^>]*>/i;
const HTML_REMOVE_SELECTOR = "script,style,noscript,iframe,object,embed,form,input,button,textarea,select,video,audio,canvas,svg";
const HTML_ALLOWED_TAGS = new Set(["a", "blockquote", "br", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "li", "ol", "p", "span", "strong", "ul"]);

export class SkyNovelsParser {
  parseSearchResults(results: SkyNovelsNovelSummary[]): SearchResultItem[] {
    return results.map((result) => ({
      mangaId: String(result.id),
      title: normalizeWhitespace(result.nvl_title),
      subtitle: normalizeWhitespace(result.nvl_writer) || undefined,
      imageUrl: searchCoverUrl(result.image),
    }));
  }

  parseNovelDetails(
    novelId: string,
    base: SkyNovelsNovelBase,
    genres: SkyNovelsGenre[],
    stats?: SkyNovelsStatsResponse,
  ): SourceManga {
    const genreNames = genres.map((genre) => normalizeWhitespace(genre.genre_name)).filter(Boolean);
    const secondaryTitles = [base.nvl_titlealternative, base.nvl_acronym]
      .map((title) => normalizeWhitespace(title))
      .filter((title, index, titles): title is string => Boolean(title) && titles.indexOf(title) === index);
    const coverUrl = novelCoverUrl(base.image);

    const additionalInfo = Object.fromEntries(
      [
        ["origen", normalizeWhitespace(base.nvl_origin)],
        ["traductor", normalizeWhitespace(base.nvl_translator)],
        ["totalChapters", stats?.nvl_chapters ? String(stats.nvl_chapters) : ""],
        ["followers", stats?.nvl_bookmarks_count ? String(stats.nvl_bookmarks_count) : ""],
        ["lastUpdate", normalizeWhitespace(stats?.nvl_last_update)],
      ].filter(([, value]) => Boolean(value)),
    );

    return {
      mangaId: novelId,
      mangaInfo: {
        thumbnailUrl: coverUrl,
        synopsis: (base.nvl_content ?? "").trim(),
        primaryTitle: normalizeWhitespace(base.nvl_title),
        secondaryTitles,
        contentRating: inferContentRating(genreNames),
        contentType: "novel",
        author: normalizeWhitespace(base.nvl_writer) || undefined,
        status: mapNovelStatus(base.nvl_status),
        rating: Number.isFinite(stats?.nvl_rating) ? Number(stats?.nvl_rating) : undefined,
        tagGroups: genreNames.length
          ? [
              {
                id: "genres",
                title: "Generos",
                tags: genreNames.map((genre) => ({
                  id: slugifyTag(genre),
                  title: genre,
                })),
              },
            ]
          : undefined,
        artworkUrls: coverUrl ? [coverUrl] : undefined,
        additionalInfo: Object.keys(additionalInfo).length > 0 ? additionalInfo : undefined,
        shareUrl: novelUrl(novelId, base.nvl_name),
      },
    };
  }

  parseChapters(sourceManga: SourceManga, volumeSets: VolumeChapterSet[], sortingIndexOffset = 0): Chapter[] {
    const chapters: Chapter[] = [];
    let sortingIndex = sortingIndexOffset;

    for (const { volume, chapters: volumeChapters } of volumeSets) {
      const volumeNumber = parseVolumeNumber(volume.vlm_title);
      for (const volumeChapter of volumeChapters) {
        const chapterNumber = parseChapterNumber(volumeChapter) ?? sortingIndex + 1;

        chapters.push({
          chapterId: String(volumeChapter.id),
          sourceManga,
          langCode: LANGUAGE,
          chapNum: chapterNumber,
          title: cleanChapterTitle(volumeChapter.chp_title ?? volumeChapter.chp_index_title),
          volume: volumeNumber,
          publishDate: volumeChapter.createdAt ? new Date(volumeChapter.createdAt) : undefined,
          sortingIndex: Number.isFinite(chapterNumber) ? Math.max(0, chapterNumber - 1) : sortingIndex,
        });
        sortingIndex += 1;
      }
    }

    return chapters;
  }

  parseChapterDetails(chapter: Chapter, details: SkyNovelsChapterDetails): ChapterDetails {
    const chapterHtml = this.renderContent((details.chp_content ?? "").trim());
    if (!chapterHtml) {
      throw new Error(`Chapter content was empty for ${chapter.chapterId}`);
    }

    return {
      type: "html",
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      html:
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8" />` +
        `<style>body{line-height:1.65;font-size:1em;}img{max-width:100%;height:auto;}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #cccccc;}hr{border:none;border-top:1px solid #cccccc;margin:1.5em 0;}</style>` +
        `</head><body>${chapterHtml}</body></html>`,
    };
  }

  private renderContent(content: string): string {
    const normalizedContent = content.replace(/\r\n?/g, "\n").replace(INVISIBLE_CHARACTERS_REGEX, "").trim();
    if (!normalizedContent) {
      return "";
    }

    return HTML_TAG_REGEX.test(normalizedContent)
      ? this.sanitizeHtml(normalizedContent)
      : this.renderMarkdown(normalizedContent);
  }

  private sanitizeHtml(content: string): string {
    const $ = cheerio.load(`<div id="skynovels-content">${content}</div>`, undefined, false);
    const root = $("#skynovels-content");
    root.find(HTML_REMOVE_SELECTOR).remove();

    root.find("*").each((_, element) => {
      const node = $(element);
      const tagName = element.tagName.toLowerCase();
      if (!HTML_ALLOWED_TAGS.has(tagName)) {
        node.replaceWith(node.contents());
        return;
      }

      for (const attribute of Object.keys(element.attribs ?? {})) {
        if (
          !["href", "src", "alt", "title"].includes(attribute.toLowerCase()) ||
          /^on[a-z-]+$/i.test(attribute) ||
          /^data-/i.test(attribute) ||
          /^(?:style|srcdoc|formaction|action|background|poster|xlink:href)$/i.test(attribute)
        ) {
          node.removeAttr(attribute);
        }
      }

      for (const attribute of ["href", "src"]) {
        const value = node.attr(attribute);
        if (value === undefined) {
          continue;
        }

        const safeUrl = this.safeContentUrl(value);
        if (safeUrl) {
          node.attr(attribute, safeUrl);
        } else {
          node.removeAttr(attribute);
        }
      }
    });

    return root.html()?.trim() ?? "";
  }

  private renderMarkdown(markdown: string): string {
    const normalizedMarkdown = markdown.replace(/\r\n?/g, "\n").replace(INVISIBLE_CHARACTERS_REGEX, "").trim();
    if (!normalizedMarkdown) {
      return "";
    }

    const lines = normalizedMarkdown.split("\n");
    const blocks: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trimEnd() ?? "";
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      const structuralLine = trimmedLine.replace(/\\([*_ -])/g, "$1");
      if (/^[-*_]{3,}$/.test(structuralLine)) {
        blocks.push("<hr />");
        continue;
      }

      const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        blocks.push(`<h${level}>${this.renderInline(headingMatch[2])}</h${level}>`);
        continue;
      }

      if (/^>\s?/.test(trimmedLine)) {
        const quoteLines = [trimmedLine.replace(/^>\s?/, "")];
        while (index + 1 < lines.length && /^>\s?/.test((lines[index + 1] ?? "").trim())) {
          index += 1;
          quoteLines.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        }
        blocks.push(`<blockquote><p>${quoteLines.map((part) => this.renderInline(part)).join("<br />")}</p></blockquote>`);
        continue;
      }

      if (/^[-*]\s+/.test(trimmedLine)) {
        const listItems = [trimmedLine.replace(/^[-*]\s+/, "")];
        while (index + 1 < lines.length && /^[-*]\s+/.test((lines[index + 1] ?? "").trim())) {
          index += 1;
          listItems.push((lines[index] ?? "").trim().replace(/^[-*]\s+/, ""));
        }

        blocks.push(`<ul>${listItems.map((item) => `<li>${this.renderInline(item)}</li>`).join("")}</ul>`);
        continue;
      }

      if (/^\d+[.)]\s+/.test(trimmedLine)) {
        const listItems = [trimmedLine.replace(/^\d+[.)]\s+/, "")];
        while (index + 1 < lines.length && /^\d+[.)]\s+/.test((lines[index + 1] ?? "").trim())) {
          index += 1;
          listItems.push((lines[index] ?? "").trim().replace(/^\d+[.)]\s+/, ""));
        }

        blocks.push(`<ol>${listItems.map((item) => `<li>${this.renderInline(item)}</li>`).join("")}</ol>`);
        continue;
      }

      const paragraphLines = [line];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1] ?? "";
        const nextTrimmed = nextLine.trim();
        if (
          !nextTrimmed ||
          /^[-*_]{3,}$/.test(nextTrimmed) ||
          /^(#{1,6})\s+/.test(nextTrimmed) ||
          /^>\s?/.test(nextTrimmed) ||
          /^[-*]\s+/.test(nextTrimmed) ||
          /^\d+[.)]\s+/.test(nextTrimmed)
        ) {
          break;
        }

        index += 1;
        paragraphLines.push(nextLine.trimEnd());
      }

      blocks.push(`<p>${paragraphLines.map((part) => this.renderInline(part.trim())).join("<br />")}</p>`);
    }

    return blocks.join("");
  }

  private renderInline(input: string): string {
    const escapeTokens: Array<{ token: string; value: string }> = [];
    const escapedMarkdown = input.replace(ESCAPED_MARKDOWN_REGEX, (_, value: string) => {
      const token = `@@ESC${escapeTokens.length}@@`;
      escapeTokens.push({ token, value: this.escapeHtml(value) });
      return token;
    });

    let html = this.escapeHtml(escapedMarkdown);

    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, url: string) => {
      const imageUrl = this.escapeAttribute(this.safeContentUrl(url.trim()));
      const altText = this.escapeAttribute(alt);
      return imageUrl ? `<img src="${imageUrl}" alt="${altText}" />` : altText;
    });

    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) => {
      const href = this.escapeAttribute(this.safeContentUrl(url.trim()));
      return href ? `<a href="${href}">${text}</a>` : text;
    });

    html = html.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
    html = html.replace(/_([^_]+?)_/g, "<em>$1</em>");
    html = html.replace(/\*([^*]+?)\*/g, "<em>$1</em>");

    for (const { token, value } of escapeTokens) {
      html = html.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), value);
    }

    return html;
  }

  private escapeHtml(input: string): string {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private escapeAttribute(input: string): string {
    return this.escapeHtml(input).replace(/'/g, "&#39;");
  }

  private safeContentUrl(input: string): string {
    const value = normalizeWhitespace(input);
    if (!value || /^(?:javascript|data|vbscript):/i.test(value)) {
      return "";
    }

    const absoluteUrl = absoluteSkyNovelsUrl(value);
    try {
      const parsedUrl = new URL(absoluteUrl);
      return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:" ? parsedUrl.href : "";
    } catch {
      return "";
    }
  }
}
