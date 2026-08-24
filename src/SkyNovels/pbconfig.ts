import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "SkyNovels",
  description: "Paperback 0.9 source for skynovels.net using the public API.",
  version: "0.2.2",
  icon: "icon.svg",
  language: "es",
  contentRating: ContentRating.MATURE,
  capabilities: [SourceIntents.SEARCH_RESULT_PROVIDING, SourceIntents.CHAPTER_PROVIDING],
  badges: [
    {
      label: "Novel",
      textColor: "#ffffff",
      backgroundColor: "#d32f2f",
    },
  ],
  developers: [
    {
      name: "tob",
    },
  ],
} satisfies ExtensionInfo;
