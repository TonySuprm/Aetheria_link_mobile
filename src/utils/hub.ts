export const DEAD_HUBCLOUD_HOSTS = new Set([
  'hubcloud.ink',
  'hubcloud.co',
  'hubcloud.cc',
  'hubcloud.me',
  'hubcloud.xyz',
]);

export const HUB_HOST_PATTERN = /hubcdn|hubcloud|hubdrive/;

export const HUBCLOUD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Keep only hub-family (HubCloud / HubDrive / HubCDN) results. Sources whose other mirrors
 * (gofile, send.now, gdflix, …) are dead or slow-extracting use this so their fast, reliably
 * playable HubCloud links make it into the FIRST stream response instead of dragging the
 * whole source past the response deadline.
 */
export const filterHubHosts = <T extends { url: URL }>(results: T[]): T[] =>
  results.filter(result => HUB_HOST_PATTERN.test(result.url.hostname));
