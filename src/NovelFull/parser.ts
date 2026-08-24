import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type SearchResultItem,
  type SourceManga,
} from "@paperback/types";
import * as cheerio from "cheerio";

import {
  CHAPTERS_PER_PAGE,
  absoluteUrl,
  chapterIdFromHref,
  mangaUrl,
  novelCoverUrl,
  novelSlugFromHref,
  type ChapterPageInfo,
  type NovelPageInfo,
  type SearchNovel,
} from "./models";

const ADULT_GENRES = new Set(["adult", "ecchi", "lolicon", "mature", "nsfw", "smut"]);

export class NovelFullParser {
  parseSearchPage(html: string): SearchNovel[] {
    const $ = cheerio.load(html);
    if (!$("#list-page").length) {
      throw new Error("Could not locate NovelFull search results");
    }

    const rows = $("#list-page > .col-truyen-main.archive > .list.list-truyen > .row");

    return rows
      .map((_, element) => {
        const row = $(element);
        const titleLink = row.find("h3.truyen-title > a, .col-title h3 > a").first();
        const title = this.normalizeWhitespace(titleLink.text());
        const slug = novelSlugFromHref(titleLink.attr("href"));
        const image = row.find("img.cover").first();
        const latestChapterLink = row.find(".col-xs-2.text-info > div > a, .col-chap > a").first();
        const genres = row
          .find(".col-cat a")
          .map((__, genre) => this.normalizeWhitespace($(genre).text()))
          .get()
          .filter(Boolean);

        if (!title || !slug) {
          return undefined;
        }

        return {
          title,
          author: this.normalizeWhitespace(row.find("span.author, .author").first().text()),
          slug,
          coverPath: image.attr("src") ?? image.attr("data-src") ?? image.attr("data-original"),
          genres,
          latestChapterNumber: this.parseChapterNumber(latestChapterLink.text() || latestChapterLink.attr("title")),
        } satisfies SearchNovel;
      })
      .get()
      .filter((result): result is NonNullable<typeof result> => Boolean(result));
  }

  parseSearchResults(results: SearchNovel[]): SearchResultItem[] {
    return results.map((result) => ({
      mangaId: result.slug,
      title: result.title,
      subtitle: result.author || undefined,
      imageUrl: novelCoverUrl(result.coverPath),
      contentRating: this.inferContentRating(result.genres ?? []),
    }));
  }

  parseNovelPage(mangaId: string, html: string): SourceManga {
    const details = this.parseNovelPageInfo(html);
    const additionalInfo = Object.fromEntries(
      [
        ["source", details.source],
        ["totalPages", details.totalPages ? String(details.totalPages) : ""],
        ["totalChapters", details.totalChapters ? String(details.totalChapters) : ""],
        ["ratingCount", details.ratingCount ? String(details.ratingCount) : ""],
      ].filter(([, value]) => Boolean(value)),
    );

    return {
      mangaId,
      mangaInfo: {
        thumbnailUrl: details.cover,
        synopsis: details.synopsis,
        primaryTitle: details.title,
        secondaryTitles: details.alternativeTitles,
        contentRating: details.contentRating,
        contentType: "novel",
        author: details.author || undefined,
        status: details.status,
        rating: details.rating,
        tagGroups: details.genres.length
          ? [
              {
                id: "genres",
                title: "Genres",
                tags: details.genres.map((genre) => ({
                  id: this.slugifyTag(genre),
                  title: genre,
                })),
              },
            ]
          : undefined,
        artworkUrls: details.cover ? [details.cover] : undefined,
        additionalInfo: Object.keys(additionalInfo).length > 0 ? additionalInfo : undefined,
        shareUrl: mangaUrl(mangaId),
      },
    };
  }

  parseNovelPageInfo(html: string): NovelPageInfo {
    const $ = cheerio.load(html);
    const title = this.normalizeWhitespace($(".info-holder .books .desc > h3.title, .col-info-desc > .desc > h3.title").first().text());
    if (!title || !$("#truyen").length) {
      throw new Error("Could not locate NovelFull novel details");
    }

    const cover = novelCoverUrl(
      $(".info-holder .books .book > img").first().attr("src") ??
        $(".info-holder .books .book > img").first().attr("data-src"),
    );
    const authorRow = this.getInfoRow($, "Author");
    const alternativeNamesRow = this.getInfoRow($, "Alternative names");
    const genreRow = this.getInfoRow($, "Genre");
    const sourceRow = this.getInfoRow($, "Source");
    const statusRow = this.getInfoRow($, "Status");
    const genres = genreRow
      ? $(genreRow)
          .find("a")
          .map((_, element) => this.toTitleCase(this.normalizeWhitespace($(element).text())))
          .get()
          .filter(Boolean)
      : [];
    const primaryTitle = title;
    const alternativeTitles = alternativeNamesRow
      ? this.extractRowText($, alternativeNamesRow)
          .split(",")
          .map((value) => this.normalizeWhitespace(value))
          .filter((value, index, values) => Boolean(value) && value !== primaryTitle && values.indexOf(value) === index)
      : [];
    const ratingText = $("#rateVal").first().attr("value") ?? "";
    const rating = Number(ratingText);
    const ratingSummary = this.normalizeWhitespace($(".col-info-desc .small").first().text());
    const ratingCountMatch = ratingSummary.match(/from\s+([\d,]+)\s+ratings/i);
    const ratingCount = ratingCountMatch ? Number(ratingCountMatch[1].replaceAll(",", "")) : undefined;
    const totalPages = this.parseTotalPages($);
    const pageChapterCount = $("#list-chapter ul.list-chapter > li > a").length;

    return {
      title,
      author: authorRow ? this.normalizeWhitespace($(authorRow).find("a").first().text()) : "",
      alternativeTitles,
      cover,
      synopsis: this.normalizeWhitespace($("#truyen .desc-text").first().text()),
      genres,
      source: sourceRow ? this.normalizeWhitespace($(sourceRow).find("a").first().text()) || undefined : undefined,
      status: statusRow ? this.normalizeWhitespace($(statusRow).find("a").first().text()) || undefined : undefined,
      rating: Number.isFinite(rating) ? rating : undefined,
      ratingCount: Number.isFinite(ratingCount) ? ratingCount : undefined,
      totalPages,
      pageChapterCount,
      totalChapters: totalPages === 1 ? pageChapterCount : undefined,
      contentRating: this.inferContentRating(genres),
    };
  }

  parseChapterListPage(sourceManga: SourceManga, html: string, page: number): ChapterPageInfo {
    const $ = cheerio.load(html);
    if (!$("#list-chapter").length) {
      throw new Error(`Could not locate NovelFull chapter list for page ${page}`);
    }

    const chapters = $("#list-chapter ul.list-chapter > li > a")
      .map((index, element) => {
        const link = $(element);
        const chapterId = chapterIdFromHref(link.attr("href"));
        const rawTitle = this.normalizeWhitespace(link.find(".chapter-text").text() || link.attr("title") || link.text());
        const chapterNumber = this.parseChapterNumber(rawTitle);

        if (!chapterId) {
          return undefined;
        }

        return {
          chapterId,
          sourceManga,
          langCode: "en",
          chapNum: chapterNumber ?? (page - 1) * CHAPTERS_PER_PAGE + index + 1,
          title: this.cleanChapterTitle(rawTitle),
          sortingIndex: (page - 1) * CHAPTERS_PER_PAGE + index,
        } satisfies Chapter;
      })
      .get()
      .filter((chapter): chapter is NonNullable<typeof chapter> => Boolean(chapter));

    return {
      totalPages: this.parseTotalPages($),
      chapters,
    };
  }

  parseChapterDetails(chapter: Chapter, html: string): ChapterDetails {
    const $ = cheerio.load(html);
    const content = $("#chapter-content.chapter-c, #chapter-content").first();

    if (!content.length) {
      throw new Error(`Could not locate chapter content for ${chapter.chapterId}`);
    }

    content.find("script, style, noscript, iframe, object, embed, form, input, button, textarea, select, video, audio, canvas, svg").remove();
    content.find(".chapter-nav, #chapter-nav-top, #chapter-nav-bottom, #chapter_error, .box-notice").remove();
    content
      .find("div")
      .filter((_, element) => {
        const node = $(element);
        const text = this.normalizeWhitespace(node.text());
        return (
          node.find('a[href*="freegames.click"], [src*="freegames.click"]').length > 0 ||
          /if you find any errors|report chapter/i.test(text)
        );
      })
      .remove();
    content
      .find("h3")
      .filter((_, element) => /^chapter\b/i.test(this.normalizeWhitespace($(element).text())))
      .remove();

    content.find("[src]").each((_, element) => {
      const src = this.safeContentUrl($(element).attr("src"));
      if (src) {
        $(element).attr("src", src);
      } else {
        $(element).removeAttr("src");
      }
    });
    content.find("[href]").each((_, element) => {
      const href = this.safeContentUrl($(element).attr("href"));
      if (href) {
        $(element).attr("href", href);
      } else {
        $(element).removeAttr("href");
      }
    });
    content.find("*").each((_, element) => {
      for (const attribute of Object.keys(element.attribs ?? {})) {
        if (
          /^on[a-z-]+$/i.test(attribute) ||
          /^data-/i.test(attribute) ||
          /^(?:action|background|formaction|poster|style|xlink:href)$/i.test(attribute)
        ) {
          $(element).removeAttr(attribute);
        }
      }
    });

    const chapterHtml = (content.html() ?? "")
      .replaceAll(/\s+data-protected=(['"]).*?\1/gi, "")
      .replaceAll(/\s+on[a-z-]+=(['"]).*?\1/gi, "")
      .trim();

    if (!chapterHtml) {
      throw new Error(`Chapter content was empty for ${chapter.chapterId}`);
    }

    return {
      type: "html",
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      html: `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8" /></head><body>${chapterHtml}</body></html>`,
    };
  }

  private getInfoRow($: cheerio.CheerioAPI, label: string) {
    return $(".info-holder .info > div").toArray().find((element) => {
      const heading = this.normalizeWhitespace($(element).find("h3").first().text()).replace(/:$/, "");
      return heading.toLowerCase() === label.toLowerCase();
    });
  }

  private extractRowText($: cheerio.CheerioAPI, row: ReturnType<NovelFullParser["getInfoRow"]>) {
    const clone = $(row).clone();
    clone.find("h3").remove();
    return this.normalizeWhitespace(clone.text());
  }

  private parseTotalPages($: cheerio.CheerioAPI): number {
    const hiddenTotal = Number($("#total-page").first().attr("value"));
    if (Number.isFinite(hiddenTotal) && hiddenTotal > 0) {
      return hiddenTotal;
    }

    const inputMax = Number($("#page_jump input[name='page']").first().attr("max"));
    if (Number.isFinite(inputMax) && inputMax > 0) {
      return inputMax;
    }

    let highestPage = 1;
    $("#list-chapter .pagination a[href]").each((_, element) => {
      const href = $(element).attr("href") ?? "";
      const match = href.match(/[?&]page=(\d+)/i);
      if (match) {
        highestPage = Math.max(highestPage, Number(match[1]));
      }
    });
    return highestPage;
  }

  private parseChapterNumber(input: string | undefined): number | undefined {
    const text = this.normalizeWhitespace(input);
    if (!text) {
      return undefined;
    }

    const match = text.match(/\bchapter\s+(\d+(?:[.,]\d+)?)/i);
    if (!match) {
      return undefined;
    }

    const parsed = Number(match[1].replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private cleanChapterTitle(input: string): string | undefined {
    const title = this.normalizeWhitespace(input);
    if (!title) {
      return undefined;
    }

    const cleaned = title
      .replace(/^Book\s+\d+\s*[-:]\s*/i, "")
      .replace(/^Chapter\s+\d+(?:[.,]\d+)?\s*[-:,\u2013\u2014]+\s*/i, "")
      .trim();
    return cleaned || title;
  }

  private inferContentRating(genres: string[]): ContentRating {
    return genres.some((genre) => ADULT_GENRES.has(this.normalizeWhitespace(genre).toLowerCase()))
      ? ContentRating.MATURE
      : ContentRating.EVERYONE;
  }

  private normalizeWhitespace(input: string | undefined | null): string {
    return (input ?? "").replace(/\s+/g, " ").trim();
  }

  private slugifyTag(input: string): string {
    return this.normalizeWhitespace(input).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  private toTitleCase(input: string): string {
    return input.toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
  }

  private safeContentUrl(input: string | undefined): string {
    const value = this.normalizeWhitespace(input);
    if (!value || /^(?:javascript|data|vbscript):/i.test(value)) {
      return "";
    }

    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:/i.test(value)) {
      return "";
    }

    return absoluteUrl(value);
  }
}
