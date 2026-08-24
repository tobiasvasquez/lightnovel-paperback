import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "NovelFull",
  description: "Paperback 0.9 source for novelfull.com with cached and split novel chapter lists.",
  version: "0.1.0",
  icon: "icon.svg",
  language: "en",
  contentRating: ContentRating.MATURE,
  capabilities: [
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
  badges: [
    {
      label: "Novel",
      textColor: "#ffffff",
      backgroundColor: "#7c3aed",
    },
  ],
  developers: [
    {
      name: "tob",
    },
  ],
} satisfies ExtensionInfo;
