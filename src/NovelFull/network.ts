import { BasicRateLimiter, CloudflareError } from "@paperback/types";

import { DOMAIN } from "./models";

const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export const mainRateLimiter = new BasicRateLimiter("main", {
  numberOfRequests: 4,
  bufferInterval: 1,
  ignoreImages: true,
});

async function getUserAgent(): Promise<string> {
  try {
    return (await Application.getDefaultUserAgent()) || FALLBACK_USER_AGENT;
  } catch {
    return FALLBACK_USER_AGENT;
  }
}

async function getHeaders(referer?: string): Promise<Record<string, string>> {
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: referer ?? `${DOMAIN}/`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": await getUserAgent(),
  };
}

async function request(url: string, referer?: string): Promise<string> {
  const headers = await getHeaders(referer);
  const [response, data] = await Application.scheduleRequest({
    url,
    method: "GET",
    headers,
  });

  if (response.status === 403) {
    throw new CloudflareError({
      url,
      method: "GET",
      headers,
    });
  }

  if (response.status >= 400) {
    throw new Error(`Request failed with status ${response.status}: ${url}`);
  }

  return Application.arrayBufferToUTF8String(data);
}

export async function fetchHTML(url: string, referer?: string): Promise<string> {
  return request(url, referer);
}
