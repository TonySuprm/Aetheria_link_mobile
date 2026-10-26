"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HubCloud = void 0;
const bytes_1 = __importDefault(require("bytes"));
const cheerio = __importStar(require("cheerio"));
const types_1 = require("../types");
const utils_1 = require("../utils");
const Extractor_1 = require("./Extractor");
/** Delay before retrying Hop 1 after a failed Hop 2 (ms). */
const RETRY_DELAY_MS = 2500;
/**
 * Server categories matched by button text, ordered from highest to lowest quality.
 * Higher priority = more reliable / supports HTTP Range (seekable).
 * Non-seekable categories (10Gbps, PDL, DF) are deduped when a seekable alternative exists.
 */
const SERVER_CATEGORIES = [
    { buttonIncludes: 'FSLv2', buttonExcludes: '', label: 'HubCloud (FSLv2)', extractorId: 'hubcloud_fslv2', priority: 4, seekable: true },
    { buttonIncludes: 'FSL', buttonExcludes: 'FSLv2', label: 'HubCloud (FSL)', extractorId: 'hubcloud_fsl', priority: 5, seekable: true },
    { buttonIncludes: '10Gbps', buttonExcludes: '', label: 'HubCloud (10Gbps)', extractorId: 'hubcloud_fast', priority: 2, seekable: false },
    { buttonIncludes: 'PixelServer', buttonExcludes: '', label: 'HubCloud (PxlSrv)', extractorId: 'hubcloud_pixelserver', priority: 3, seekable: true },
    { buttonIncludes: 'PDL', buttonExcludes: '', label: 'HubCloud (PDL)', extractorId: 'hubcloud_pdl', priority: 1, seekable: false },
    { buttonIncludes: 'Download File', buttonExcludes: '', label: 'HubCloud (DF)', extractorId: 'hubcloud_direct', priority: 0, seekable: false },
];
const LABEL_TO_SEEKABLE = new Map(SERVER_CATEGORIES.map(c => [c.label, c.seekable]));
const REDIRECT_STRATEGIES = [
    html => html.match(/var url\s*=\s*['"](.*?)['"]/)?.[1] ?? null,
    html => html.match(/window\.location(?:\.href)?\s*=\s*['"](.*?)['"]/)?.[1] ?? null,
    html => html.match(/location\.replace\(['"](.*?)['"]\)/)?.[1] ?? null,
    html => html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?\d+;\s*url=(.*?)["']/i)?.[1] ?? null,
    html => html.match(/document\.location(?:\.href)?\s*=\s*['"](.*?)['"]/)?.[1] ?? null,
    html => html.match(/location\.href\s*=\s*['"](.*?)['"]/)?.[1] ?? null,
    html => html.match(/location\.assign\(['"](.*?)['"]\)/)?.[1] ?? null,
    html => html.match(/window\.open\(['"](.*?)['"]/)?.[1] ?? null,
    html => html.match(/data-(?:url|href|link)\s*=\s*['"](.*?)['"]/)?.[1] ?? null,
    (html) => {
        const m = html.match(/<iframe[^>]+src\s*=\s*['"](.*?)['"]/);
        if (m?.[1] && (m[1].includes('hubcloud') || m[1].includes('gamerxyt')))
            return m[1];
        return null;
    },
    (html) => {
        const m = html.match(/var\s+\w+\s*=\s*['"]([^'"]*(?:hubcloud|gamerxyt|hubdrive|hubcdn)[^'"]*)['"]/);
        return m?.[1] ?? null;
    },
    (html) => {
        const m = html.match(/https?:\/\/(?:hubcloud\.[a-z.]+|hubdrive\.[a-z.]+|gamerxyt\.com|hubcdn)[^\s'"<>)]+/);
        return m?.[0] ?? null;
    },
];
class HubCloud extends Extractor_1.Extractor {
    id = 'hubcloud';
    label = 'HubCloud';
    cacheVersion = 13;
    ttl = utils_1.HUBCLOUD_CACHE_TTL;
    supports(_ctx, url) {
        return utils_1.HUB_HOST_PATTERN.test(url.hostname);
    }
    async extractInternal(ctx, url, meta) {
        // search-recover.php is now a JavaScript SPA — results load via a JSON API call, not a server
        // redirect. The old redirect-strategy extraction finds nothing in the SPA shell and returns [].
        // Call the search API directly, then resolve each hit's /drive/<id> URL (which still uses the
        // old-style var-url redirect that the code below handles).
        if (url.pathname.includes('search-recover')) {
            return this.extractViaSearchApi(ctx, url, meta);
        }
        const headers = { Referer: meta.referer ?? url.href };
        const redirectHtml = await this.fetcher.text(ctx, url, { headers });
        const rawRedirectUrl = this.extractRedirectUrl(redirectHtml);
        if (!rawRedirectUrl) {
            return [];
        }
        const redirectUrl = rawRedirectUrl.startsWith('http') ? rawRedirectUrl : `${url.origin}${rawRedirectUrl}`;
        const cookieName = this.extractCookieName(redirectHtml);
        if (cookieName) {
            this.fetcher.setCookie(redirectUrl, `${cookieName}=s4t`);
        }
        let linksHtml = await this.fetcher.text(ctx, new URL(redirectUrl), { headers: { Referer: url.href } });
        let $ = cheerio.load(linksHtml);
        // If the download links page doesn't contain expected content (e.g., no #size element
        // and no download links), it may be a token-expired error page. Retry once.
        if (!this.hasValidDownloadContent($)) {
            // Wait a moment, then re-fetch Hop 1 to get a fresh token
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            const retryHtml = await this.fetcher.text(ctx, url, { headers });
            const rawRetryRedirectUrl = this.extractRedirectUrl(retryHtml);
            if (rawRetryRedirectUrl) {
                const retryRedirectUrl = rawRetryRedirectUrl.startsWith('http') ? rawRetryRedirectUrl : `${url.origin}${rawRetryRedirectUrl}`;
                const retryCookieName = this.extractCookieName(retryHtml);
                if (retryCookieName) {
                    this.fetcher.setCookie(retryRedirectUrl, `${retryCookieName}=s4t`);
                }
                linksHtml = await this.fetcher.text(ctx, new URL(retryRedirectUrl), { headers: { Referer: url.href } });
                $ = cheerio.load(linksHtml);
            }
            // If still no valid content after retry, return empty (don't cache a failure)
            if (!this.hasValidDownloadContent($)) {
                return [];
            }
        }
        const title = $('title').text().trim();
        const countryCodes = [...new Set([...meta.countryCodes ?? [], ...(0, utils_1.findCountryCodes)(title)])];
        const height = meta.height ?? (0, utils_1.findHeight)(title);
        const fileSize = bytes_1.default.parse($('#size').text());
        // Collect all download links and classify them by button text
        const allLinks = $('a').toArray();
        const classified = [];
        const matchedIndices = new Set();
        // Pass 1: Match links by button text in priority order
        for (const category of SERVER_CATEGORIES) {
            for (const [i, el] of allLinks.entries()) {
                if (matchedIndices.has(i))
                    continue;
                const text = $(el).text();
                const href = $(el).attr('href');
                if (!href || href.toLowerCase().includes('.zip'))
                    continue;
                if (text.includes(category.buttonIncludes) && (category.buttonExcludes === '' || !text.includes(category.buttonExcludes))) {
                    matchedIndices.add(i);
                    // PixelServer: special handling — convert /u/ → /api/file/?download= and HEAD check
                    if (category.buttonIncludes === 'PixelServer') {
                        try {
                            const userUrl = new URL(href.replace('/api/file/', '/u/'));
                            const apiUrl = new URL(userUrl.href.replace('/u/', '/api/file/'));
                            apiUrl.searchParams.set('download', '');
                            await this.fetcher.head(ctx, apiUrl, { headers: { Referer: userUrl.href } });
                            classified.push({
                                url: apiUrl,
                                format: types_1.Format.unknown,
                                ttl: utils_1.HUBCLOUD_CACHE_TTL,
                                label: category.label,
                                meta: { ...meta, bytes: fileSize, extractorId: category.extractorId, countryCodes, height, title },
                                requestHeaders: { Referer: userUrl.href },
                            });
                        }
                        catch {
                            // PixelServer link is dead — skip it
                        }
                    }
                    else {
                        classified.push({
                            url: new URL(href),
                            format: types_1.Format.unknown,
                            ttl: utils_1.HUBCLOUD_CACHE_TTL,
                            label: category.label,
                            meta: {
                                ...meta,
                                bytes: fileSize,
                                extractorId: category.extractorId,
                                countryCodes,
                                height,
                                title: category.seekable ? title : `${title} ⚠️ no seek`,
                            },
                        });
                    }
                }
            }
        }
        // Priority-based dedup: if same file exists via both seekable and non-seekable,
        // drop the non-seekable duplicate. Keep both FSL and FSLv2 (both seekable).
        const seekableResults = classified.filter(r => LABEL_TO_SEEKABLE.get(r.label) === true);
        if (seekableResults.length > 0) {
            // Compare by bytes only — titles differ (non-seekable have "⚠️ no seek" suffix)
            const hasSeekableForFile = (result) => seekableResults.some(s => s.meta?.bytes === result.meta?.bytes);
            return classified.filter((r) => {
                if (LABEL_TO_SEEKABLE.get(r.label) === true)
                    return true;
                // Drop non-seekable if a seekable alternative exists for the same file
                return !hasSeekableForFile(r);
            });
        }
        // Fallback: the gamerxyt.com download page has changed — FSL/FSLv2/PixelServer buttons are
        // no longer present. Instead, the page embeds a PixelDrain download link via JavaScript
        // (`var pxl = "https://pixeldrain.dev/u/..."`) and may include a direct workers.dev CDN URL
        // in an <a> tag. Extract these so HubCloud links don't return empty (0:00 stall).
        if (classified.length === 0) {
            // 1. PixelDrain link set via JavaScript: var pxl = "https://pixeldrain.dev/u/..."
            const pxlMatch = linksHtml.match(/var\s+pxl\s*=\s*["']([^"']+)["']/);
            if (pxlMatch?.[1]) {
                try {
                    const pxlUrl = new URL(pxlMatch[1]);
                    const id = pxlUrl.pathname.split('/').pop();
                    if (id) {
                        // Use pixeldrain.com (relay allow-listed) instead of pixeldrain.dev
                        const apiUrl = new URL(`https://pixeldrain.com/api/file/${id}?download=`);
                        const relayUrl = new URL('/relay', ctx.hostUrl);
                        relayUrl.searchParams.set('url', apiUrl.href);
                        relayUrl.searchParams.set('referer', 'https://pixeldrain.com');
                        classified.push({
                            url: relayUrl,
                            format: types_1.Format.unknown,
                            ttl: utils_1.HUBCLOUD_CACHE_TTL,
                            label: 'HubCloud (PixelDrain)',
                            meta: { ...meta, bytes: fileSize, extractorId: 'hubcloud_pixeldrain', countryCodes, height, title },
                        });
                    }
                }
                catch { /* skip invalid */ }
            }
            // 2. PixelDrain link in #pxl-1 element (initial href before JS override)
            if (classified.length === 0) {
                const pxlHref = $('#pxl-1').attr('href');
                if (pxlHref && /pixeldrain/.test(pxlHref)) {
                    try {
                        const pxlUrl = new URL(pxlHref);
                        const id = pxlUrl.pathname.split('/').pop();
                        if (id) {
                            const apiUrl = new URL(`https://pixeldrain.com/api/file/${id}?download=`);
                            const relayUrl = new URL('/relay', ctx.hostUrl);
                            relayUrl.searchParams.set('url', apiUrl.href);
                            relayUrl.searchParams.set('referer', 'https://pixeldrain.com');
                            classified.push({
                                url: relayUrl,
                                format: types_1.Format.unknown,
                                ttl: utils_1.HUBCLOUD_CACHE_TTL,
                                label: 'HubCloud (PixelDrain)',
                                meta: { ...meta, bytes: fileSize, extractorId: 'hubcloud_pixeldrain', countryCodes, height, title },
                            });
                        }
                    }
                    catch { /* skip invalid */ }
                }
            }
            // 3. Direct CDN link (workers.dev) in an <a> tag
            if (classified.length === 0) {
                $('a').each((_, el) => {
                    if (classified.length > 0)
                        return;
                    const href = $(el).attr('href') ?? '';
                    if (/workers\.dev/.test(href)) {
                        try {
                            classified.push({
                                url: new URL(href),
                                format: types_1.Format.unknown,
                                ttl: utils_1.HUBCLOUD_CACHE_TTL,
                                label: 'HubCloud (CDN)',
                                meta: { ...meta, bytes: fileSize, extractorId: 'hubcloud_cdn', countryCodes, height, title },
                            });
                        }
                        catch { /* skip invalid */ }
                    }
                });
            }
        }
        return classified;
    }
    /** Resolve a search-recover.php SPA URL via its JSON search API.
     *  The page embeds a base64-encoded query (`q`) and an access token (`from_ac`). The SPA calls
     *  `?api=search&q=<decoded>&page=1&from_ac=<token>` returning JSON hits, each with a
     *  `/drive/<id>` URL that still uses the old-style var-url redirect. We filter hits by quality
     *  and episode (from the decoded `q`), then resolve each via the normal extractInternal flow. */
    async extractViaSearchApi(ctx, url, meta) {
        const fromAc = url.searchParams.get('from_ac');
        const q = url.searchParams.get('q');
        if (!fromAc || !q) {
            return [];
        }
        let query;
        try {
            query = Buffer.from(q, 'base64').toString('utf8').trim();
        }
        catch {
            return [];
        }
        const apiUrl = new URL(url.pathname, url.origin);
        apiUrl.searchParams.set('api', 'search');
        apiUrl.searchParams.set('q', query);
        apiUrl.searchParams.set('page', '1');
        apiUrl.searchParams.set('from_ac', fromAc);
        let response;
        try {
            response = await this.fetcher.json(ctx, apiUrl, {
                headers: { Accept: 'application/json', Referer: url.href },
            });
        }
        catch {
            return [];
        }
        const hits = response.hits ?? [];
        if (hits.length === 0)
            return [];
        // Exclude .zip archives — Stremio cannot play them.
        let filtered = hits.filter(h => !h.file_name.toLowerCase().endsWith('.zip'));
        // Filter by quality extracted from the decoded query (e.g. "1080p").
        const qualityMatch = query.match(/\b(2160p|1080p|720p|480p|4k)\b/i);
        const quality = qualityMatch?.[1]?.toLowerCase();
        if (quality) {
            const byQuality = filtered.filter(h => h.file_name.toLowerCase().includes(quality));
            if (byQuality.length > 0)
                filtered = byQuality;
        }
        // Match the episode number from the query (e.g. "Episode 5" → 5) against episode ranges in
        // file names (e.g. "Ep.05-07"). Stranger Things S05 is released in batches, so Episode 5 lives
        // inside the Ep.05-07 pack.
        const epMatch = query.match(/(?:episode|ep\.?)\s*0*(\d+)/i);
        const epNum = epMatch?.[1] ? parseInt(epMatch[1], 10) : undefined;
        if (epNum !== undefined) {
            const epMatches = filtered.filter((h) => {
                const name = h.file_name.toLowerCase();
                const rangeMatch = name.match(/ep?\.?\s*0*(\d+)\s*[-\u2013]\s*0*(\d+)/);
                if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
                    return epNum >= parseInt(rangeMatch[1], 10) && epNum <= parseInt(rangeMatch[2], 10);
                }
                const singleMatch = name.match(/ep?\.?\s*0*(\d+)/);
                return singleMatch?.[1] ? parseInt(singleMatch[1], 10) === epNum : false;
            });
            if (epMatches.length > 0)
                filtered = epMatches;
        }
        // Limit to avoid flooding the stream list with too many mirrors.
        const selected = filtered.slice(0, 3);
        const allResults = await Promise.all(selected.map(async (hit) => {
            try {
                const driveUrl = new URL(hit.url);
                const hitMeta = {
                    ...meta,
                    ...(hit.size && { bytes: bytes_1.default.parse(hit.size) }),
                    ...(hit.file_name && { title: hit.file_name }),
                };
                return await this.extractInternal(ctx, driveUrl, hitMeta);
            }
            catch {
                return [];
            }
        }));
        return allResults.flat();
    }
    extractRedirectUrl(html) {
        for (const strategy of REDIRECT_STRATEGIES) {
            const result = strategy(html);
            if (result) {
                if (strategy === REDIRECT_STRATEGIES[REDIRECT_STRATEGIES.length - 1]) {
                    this.logger.warn(`Brute-force URL extraction used — redirect strategy array may need updating. Extracted: ${result}`);
                }
                return result;
            }
        }
        return null;
    }
    extractCookieName(html) {
        const cookieMatch = html.match(/stck\(\s*['"](\w+)['"]\s*,/);
        return cookieMatch ? cookieMatch[1] : null;
    }
    hasValidDownloadContent($) {
        if ($('#size').length > 0 || $('a:contains("FSL")').length > 0 || $('a:contains("PixelServer")').length > 0) {
            return true;
        }
        const extendedSelectors = [
            'a#download',
            'a[href*="hubcloud.php"]',
            'a[href*="gamerxyt.com"]',
            'a[href*="hubcloud.one"]',
            'a[href*="workers.dev"]',
            'a[href*="hubcdn"]',
            '.download-btn',
            'a[href*="download"]',
            'a.btn.btn-primary',
            '.btn-success',
            '.btn-danger',
        ];
        for (const selector of extendedSelectors) {
            if ($(selector).length > 0) {
                return true;
            }
        }
        return false;
    }
}
exports.HubCloud = HubCloud;
