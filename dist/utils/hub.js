"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterHubHosts = exports.HUBCLOUD_CACHE_TTL = exports.HUB_HOST_PATTERN = exports.DEAD_HUBCLOUD_HOSTS = void 0;
exports.DEAD_HUBCLOUD_HOSTS = new Set([
    'hubcloud.ink',
    'hubcloud.co',
    'hubcloud.cc',
    'hubcloud.me',
    'hubcloud.xyz',
]);
exports.HUB_HOST_PATTERN = /hubcdn|hubcloud|hubdrive/;
exports.HUBCLOUD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
/**
 * Keep only hub-family (HubCloud / HubDrive / HubCDN) results. Sources whose other mirrors
 * (gofile, send.now, gdflix, …) are dead or slow-extracting use this so their fast, reliably
 * playable HubCloud links make it into the FIRST stream response instead of dragging the
 * whole source past the response deadline.
 */
const filterHubHosts = (results) => results.filter(result => exports.HUB_HOST_PATTERN.test(result.url.hostname));
exports.filterHubHosts = filterHubHosts;
