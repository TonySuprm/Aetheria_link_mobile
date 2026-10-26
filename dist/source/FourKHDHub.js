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
exports.FourKHDHub = void 0;
const bytes_1 = __importDefault(require("bytes"));
const cheerio = __importStar(require("cheerio"));
const fuse_js_1 = __importDefault(require("fuse.js"));
const types_1 = require("../types");
const utils_1 = require("../utils");
const hd_hub_helper_1 = require("./hd-hub-helper");
const Source_1 = require("./Source");
const PIXEL_PATTERNS = /pixel\.(hubcdn|rohitkiskk)/;
const hostPriority = (url) => {
    if (/hubdrive/.test(url.hostname))
        return 3;
    if (/hubcloud/.test(url.hostname))
        return 2;
    if (/hubcdn/.test(url.hostname))
        return 1;
    return 0;
};
/** Deduplicate host mirrors of the same encode (same title, height and file size).
 *  Keeps the highest-priority host mirror so the stream list doesn't show duplicate
 *  cards for what is effectively the same file on hubcloud/hubdrive/hubcdn. */
const deduplicateSourceResults = (results) => {
    const groups = new Map();
    results.forEach((r) => {
        const key = `${r.meta.height ?? 0}|${r.meta.bytes ?? ''}|${r.meta.title ?? ''}`;
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(r);
    });
    return Array.from(groups.values()).map((group) => {
        if (group.length === 1)
            return group[0];
        return group.sort((a, b) => hostPriority(b.url) - hostPriority(a.url))[0];
    });
};
class FourKHDHub extends Source_1.Source {
    id = '4khdhub';
    label = '4KHDHub';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi, types_1.CountryCode.hi, types_1.CountryCode.ta, types_1.CountryCode.te];
    baseUrl = 'https://4khdhub.link';
    domainKey = '4kHDHub';
    FALLBACK_CANDIDATES = [
        'https://4khdhub.one',
        'https://4khdhub.link',
        'https://4khdhub.click',
        'https://4khdhub.ink',
        'https://4khdhub.to',
        'https://4khdhub.cc',
    ];
    fetcher;
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    async prewarm(ctx) {
        try {
            await this.fetcher.text(ctx, new URL(this.baseUrl));
            this.fetcher.getLogger().info('4KHDHub: pre-warm complete', ctx);
        }
        catch (error) {
            this.fetcher.getLogger().warn(`4KHDHub: pre-warm failed: ${error}`, ctx);
        }
    }
    async handleInternal(ctx, _type, id) {
        const tmdbId = await (0, utils_1.getTmdbId)(ctx, this.fetcher, id);
        const pageUrl = await this.fetchPageUrl(ctx, tmdbId);
        if (!pageUrl) {
            return [];
        }
        const html = await this.fetcher.text(ctx, pageUrl);
        const $ = cheerio.load(html);
        if (tmdbId.season) {
            const results = await Promise.all($(`.episode-item`)
                .filter((_i, el) => $('.episode-title', el).text().includes(`S${String(tmdbId.season).padStart(2, '0')}`))
                .map((_i, el) => ({
                countryCodes: [types_1.CountryCode.multi, ...(0, utils_1.findCountryCodes)($(el).html())],
                downloadItem: $('.episode-download-item', el)
                    .filter((_i, el) => $(el).text().includes(`Episode-${String(tmdbId.episode).padStart(2, '0')}`))
                    .get(0),
            })).filter((_i, { downloadItem }) => downloadItem !== undefined)
                .map(async (_id, { countryCodes, downloadItem }) => await this.extractSourceResults(ctx, $, downloadItem, countryCodes))
                .toArray());
            // HubCloud mirrors only (see filterHubHosts) — the source's other mirrors are
            // slow/dead and dragged it past the first-response deadline.
            return (0, utils_1.filterHubHosts)(deduplicateSourceResults(results.flat()));
        }
        const results = await Promise.all($(`.download-item`)
            .map(async (_i, el) => await this.extractSourceResults(ctx, $, el, [types_1.CountryCode.multi, ...(0, utils_1.findCountryCodes)($(el).html())]))
            .toArray());
        // HubCloud mirrors only (see filterHubHosts) — the source's other mirrors are
        // slow/dead and dragged it past the first-response deadline.
        return (0, utils_1.filterHubHosts)(deduplicateSourceResults(results.flat()));
    }
    ;
    fetchPageUrl = async (ctx, tmdbId) => {
        const [name, year] = await (0, utils_1.getTmdbNameAndYear)(ctx, this.fetcher, tmdbId);
        const searchUrl = new URL(`/?s=${encodeURIComponent(name)}`, await this.getBaseUrl(ctx));
        const html = await this.fetcher.text(ctx, searchUrl);
        const $ = cheerio.load(html);
        const typeSlug = tmdbId.season ? '-series-' : '-movie-';
        return $(`.movie-card`)
            .filter((_i, el) => {
            const href = String($(el).attr('href'));
            return href.includes(typeSlug);
        })
            .filter((_i, el) => {
            const movieCardYear = parseInt($('.movie-card-meta', el).text());
            return Math.abs(movieCardYear - year) <= 1;
        })
            .filter((_i, el) => {
            const movieCardTitle = $('.movie-card-title', el)
                .text()
                .replace(/\[.*?]/, '')
                .trim();
            const fuse = new fuse_js_1.default([movieCardTitle], { threshold: 0.3 });
            return fuse.search(name).length > 0;
        })
            .map(async (_i, el) => new URL($(el).attr('href'), await this.getBaseUrl(ctx)))
            .get(0);
    };
    extractSourceResults = async (ctx, $, el, countryCodes) => {
        const localHtml = $(el).html();
        const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/);
        const heightMatch = localHtml.match(/\d{3,}p/);
        const meta = {
            countryCodes: [...new Set([...countryCodes, ...(0, utils_1.findCountryCodes)(localHtml)])],
            height: parseInt(heightMatch[0]),
            title: $('.file-title, .episode-file-title', el).text().trim(),
            ...(sizeMatch && { bytes: bytes_1.default.parse(sizeMatch[1]) }),
        };
        const urls = [];
        const seenUrls = new Set();
        // 4KHDHub wraps its hub links in greenmotors.club/?id=<b64> redirect pages
        // (decodable via resolveRedirectUrl) — accept those alongside direct hub links.
        $('a', el)
            .filter((_i, a) => {
            const href = $(a).attr('href');
            return !!href && (utils_1.HUB_HOST_PATTERN.test(href.toLowerCase()) || /greenmotors\./.test(href.toLowerCase()));
        })
            .each((_i, a) => {
            const href = $(a).attr('href');
            try {
                const url = new URL(href);
                if (seenUrls.has(url.href))
                    return;
                seenUrls.add(url.href);
                if (utils_1.DEAD_HUBCLOUD_HOSTS.has(url.hostname))
                    return;
                if (PIXEL_PATTERNS.test(url.href))
                    return;
                urls.push(url);
            }
            catch {
                // skip invalid URLs
            }
        });
        return Promise.all(urls.map(async (url) => ({
            url: await this.resolveIfRedirect(ctx, url),
            meta,
        })));
    };
    resolveIfRedirect = async (ctx, url) => {
        if (utils_1.HUB_HOST_PATTERN.test(url.hostname)) {
            return url;
        }
        try {
            return await (0, hd_hub_helper_1.resolveRedirectUrl)(ctx, this.fetcher, url);
        }
        catch {
            return url;
        }
    };
    getBaseUrl = async (ctx) => {
        return this.probeBaseUrl(ctx, this.fetcher, this.domainKey, this.FALLBACK_CANDIDATES);
    };
}
exports.FourKHDHub = FourKHDHub;
