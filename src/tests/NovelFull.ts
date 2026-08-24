import { expect } from "chai";
import type { TestLogger } from "@paperback/types";

import { novelCoverUrl } from "../NovelFull/models.js";
import { NovelFullParser } from "../NovelFull/parser.js";
import { TestSuite } from "./suite.js";

export async function runTests(logger: TestLogger): Promise<void> {
  const suite = new TestSuite("NovelFull tests", logger);

  suite.test("WebP covers use the Paperback-compatible JPEG proxy", async () => {
    const coverUrl = novelCoverUrl("/uploads/webp/novel/shadow-slave-ab66830263.webp");
    expect(coverUrl).to.contain("https://images.weserv.nl/");
    expect(coverUrl).to.contain("output=jpg");
    expect(coverUrl).to.contain(encodeURIComponent("https://novelfull.com/uploads/webp/novel/shadow-slave-ab66830263.webp"));
  });

  suite.test("search results use the compatible cover URL", async () => {
    const parser = new NovelFullParser();
    const [result] = parser.parseSearchResults([
      {
        title: "Shadow Slave",
        author: "Guiltythree",
        slug: "shadow-slave",
        coverPath: "/uploads/webp/novel/shadow-slave-ab66830263.webp",
      },
    ]);

    expect(result?.imageUrl).to.contain("output=jpg");
  });

  await suite.run();
}
