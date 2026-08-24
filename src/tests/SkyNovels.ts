import { expect } from "chai";
import type { TestLogger } from "@paperback/types";

import { readChapterCache, mergeChapterCache } from "../SkyNovels/cache.js";
import {
  blockMangaId,
  getBlockRange,
  novelCoverUrl,
  parseSegmentMangaId,
  volumeMangaId,
  type SkyNovelsVolumeChapter,
} from "../SkyNovels/models.js";
import { SkyNovelsParser } from "../SkyNovels/parser.js";
import { TestSuite } from "./suite.js";

export async function runTests(logger: TestLogger): Promise<void> {
  const suite = new TestSuite("SkyNovels tests", logger);

  suite.test("volume and block IDs remain stable", async () => {
    expect(parseSegmentMangaId(volumeMangaId("179", 647))).to.deep.equal({
      kind: "volume",
      novelId: "179",
      volumeId: 647,
    });
    expect(parseSegmentMangaId(blockMangaId("179", 2))).to.deep.equal({
      kind: "block",
      novelId: "179",
      blockNumber: 2,
    });
    expect(getBlockRange(2)).to.deep.equal({ rangeStart: 501, rangeEnd: 1000 });
  });

  suite.test("WebP covers use the Paperback-compatible JPEG proxy", async () => {
    const coverUrl = novelCoverUrl("c43cad7c-ea0d-4bfa-9f76-54e2bbaab112.webp");
    expect(coverUrl).to.contain("https://images.weserv.nl/");
    expect(coverUrl).to.contain("output=jpg");
    expect(coverUrl).to.contain(encodeURIComponent("https://api.skynovels.net/api/get-image/c43cad7c-ea0d-4bfa-9f76-54e2bbaab112.webp/novels/false"));
  });

  suite.test("chapters preserve global numbers and volume numbers", async () => {
    const parser = new SkyNovelsParser();
    const sourceManga = {
      mangaId: "179::volume:892",
      mangaInfo: {
        primaryTitle: "Esclavo de las Sombras",
        contentType: "novel",
      },
    } as never;
    const volume = { id: 892, vlm_title: "Volumen 2: Demonio del Cambio" };
    const rawChapters: SkyNovelsVolumeChapter[] = [
      {
        id: 1,
        chp_index_title: "SS - Capítulo 96",
        chp_title: "Capítulo 96: Exilio",
        chp_number: 96,
      },
    ];

    const [chapter] = parser.parseChapters(sourceManga, [{ volume, chapters: rawChapters }]);
    expect(chapter?.chapNum).to.equal(96);
    expect(chapter?.volume).to.equal(2);
    expect(chapter?.title).to.equal("Exilio");
  });

  suite.test("HTML content is sanitized instead of escaped as visible text", async () => {
    const parser = new SkyNovelsParser();
    const sourceManga = {
      mangaId: "179::volume:647",
      mangaInfo: {
        primaryTitle: "Esclavo de las Sombras",
        contentType: "novel",
      },
    } as never;
    const chapter = {
      chapterId: "1",
      sourceManga,
      langCode: "es",
      chapNum: 1,
    } as never;

    const details = parser.parseChapterDetails(chapter, {
      id: 1,
      chp_content: "<p>Texto</p><p><em>Énfasis</em></p><script>alert(1)</script><a href=\"javascript:alert(1)\">enlace</a>",
    });

    expect(details.html).to.contain("<p>Texto</p>");
    expect(details.html).to.contain("<em>Énfasis</em>");
    expect(details.html).not.to.contain("&lt;p&gt;");
    expect(details.html).not.to.contain("<script");
    expect(details.html).not.to.contain("javascript:");
  });

  suite.test("chapter cache survives a read/write round trip", async () => {
    const scope = { kind: "volume", novelId: "179", volumeId: 647 } as const;
    mergeChapterCache(
      scope,
      undefined,
      [
        {
          chapterId: "52491",
          chapNum: 1,
          title: "Comienza la Pesadilla",
          volume: 1,
          sortingIndex: 0,
        },
      ],
      1,
      1,
      1,
    );

    const cache = readChapterCache(scope);
    expect(cache?.complete).to.equal(true);
    expect(cache?.chapters[0]?.chapterId).to.equal("52491");
  });

  await suite.run();
}
