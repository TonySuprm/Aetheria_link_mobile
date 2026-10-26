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
exports.HDEncode = void 0;
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck -- the Puppeteer page.evaluate callbacks execute in a browser context (document/window) which is not part of the Node tsconfig lib
const bytes_1 = __importDefault(require("bytes"));
const cheerio = __importStar(require("cheerio"));
const types_1 = require("../types");
const utils_1 = require("../utils");
const Source_1 = require("./Source");
const SIZE_RE = /([\d.]+)\s*(TB|GB|MB|KB)/i;
const parseSizeBytes = (text) => {
    const m = text.match(SIZE_RE);
    if (!m)
        return undefined;
    return bytes_1.default.parse(`${m[1]} ${m[2]}`) ?? undefined;
};
const normalize = (str) => str.toLowerCase()
    .replace(/\./g, ' ')
    .replace(/&/g, 'and')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
/** Revealed hoster links per post page, cached so repeat requests skip the
 *  expensive browser reveal (Turnstile solve + form submit). */
const revealedLinksCache = new Map();
const REVEALED_LINKS_TTL = 60 * 60 * 1000; // 1h
const MAX_REVEAL_POSTS = 3;
class HDEncode extends Source_1.Source {
    id = 'hdencode';
    label = 'HDEncode';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi, types_1.CountryCode.en];
    baseUrl = 'https://hdencode.org';
    category = 'debrid';
    domainKey = 'hdencode';
    fetcher;
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    async prewarm(ctx) {
        try {
            await this.fetcher.text(ctx, new URL(this.baseUrl));
            this.fetcher.getLogger().info('HDEncode: pre-warm complete', ctx);
        }
        catch (error) {
            this.fetcher.getLogger().warn(`HDEncode: pre-warm failed: ${error}`, ctx);
        }
    }
    async handleInternal(ctx, type, id) {
        if (!ctx.config.alldebridApiKey && !ctx.config.realdebridApiKey)
            return [];
        const tmdbId = await (0, utils_1.getTmdbId)(ctx, this.fetcher, id);
        const [name, year] = await (0, utils_1.getTmdbNameAndYear)(ctx, this.fetcher, tmdbId);
        if (!name)
            return [];
        const rss = await this.search(ctx, name);
        if (!rss)
            return [];
        const items = this.parseRss(rss, name, year, type, tmdbId.season, tmdbId.episode);
        if (items.length === 0) {
            this.fetcher.getLogger().info(`HDEncode: 0 matching releases for "${name}"`, ctx);
            return [];
        }
        // Prefer higher resolution, then larger file size — and only reveal the
        // download links for the best handful (each reveal is a browser round-trip).
        items.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bytes ?? 0) - (a.bytes ?? 0));
        const logger = this.fetcher.getLogger();
        const topItems = items.slice(0, MAX_REVEAL_POSTS);
        // Reveal sequentially — the Content Protector/Turnstile flow rate-limits
        // hard when several posts solve at once (parallel reveals all fail).
        // The stream deadline bounds how many posts we get through.
        const results = [];
        for (const item of topItems) {
            if (ctx.streamDeadline && Date.now() > ctx.streamDeadline - 8000) {
                logger.info(`HDEncode: deadline near — stopping reveal after ${results.length} result(s)`, ctx);
                break;
            }
            const urls = await this.revealPostLinks(ctx, item.postUrl).catch((error) => {
                logger.warn(`HDEncode: reveal failed for ${item.postUrl.pathname}: ${error instanceof Error ? error.message : String(error)}`, ctx);
                return [];
            });
            if (urls.length === 0)
                continue;
            const rapidgator = urls.find(u => u.host.includes('rapidgator') || u.host === 'rg.to');
            const nitroflare = urls.find(u => u.host.includes('nitroflare'));
            const best = rapidgator ?? nitroflare ?? (0, utils_1.pickBestHoster)(urls);
            if (!best)
                continue;
            const cleanTitle = item.title
                .replace(/\s*[-–]\s*[\d.]+\s*(?:GB|MB|KB|TB)\s*$/i, '')
                .replace(/\./g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const meta = {
                title: `[HDEncode] ${cleanTitle}`,
                height: item.height,
                bytes: item.bytes,
                countryCodes: this.countryCodes,
                sourceLabel: this.label,
                sourceId: this.id,
                season: tmdbId.season,
                episode: tmdbId.episode,
            };
            results.push({ url: best, meta });
            if (results.length >= 3)
                break;
        }
        this.fetcher.getLogger().info(`HDEncode: returning ${results.length} result(s) for "${name}"`, ctx);
        return results;
    }
    async search(ctx, query) {
        const slug = query.trim().split(/\s+/).map(encodeURIComponent).join('+');
        const pagePromises = [];
        for (let page = 1; page <= 3; page++) {
            const searchUrl = new URL(`/search/${slug}/feed/rss2/`, this.baseUrl);
            if (page > 1)
                searchUrl.searchParams.set('paged', String(page));
            pagePromises.push(this.fetcher.text(ctx, searchUrl, { timeout: 12000 })
                .catch(() => undefined));
        }
        const pages = await Promise.all(pagePromises);
        const combined = pages.filter((p) => !!p).join('\n');
        return combined || undefined;
    }
    /** Extract matching releases from the RSS search feed. The feed's <enclosure>
     *  hoster URLs were removed by the site in 2026 — download links now live
     *  behind a Content Protector + Cloudflare Turnstile form on each post page —
     *  so this returns the post URL per release and the caller reveals links. */
    parseRss(xml, name, year, type, season, episode) {
        const $ = cheerio.load(xml, { xmlMode: true });
        const nameClean = normalize(name);
        const groups = new Map();
        $('item').each((_i, el) => {
            const $item = $(el);
            const title = $item.find('title').text().trim();
            if (!title || !normalize(title).includes(nameClean))
                return;
            if (type === 'series' && season && episode) {
                const epMatch = title.match(/s0*(\d+)e0*(\d+)/i);
                if (!epMatch?.[1] || !epMatch?.[2]
                    || parseInt(epMatch[1], 10) !== season
                    || parseInt(epMatch[2], 10) !== episode) {
                    return;
                }
            }
            else if (type === 'movie') {
                if (/s0*\d+e0*\d+/i.test(title))
                    return;
                const yearMatch = title.match(/\b(19[89]\d|20\d{2})\b/);
                if (yearMatch && year && Math.abs(parseInt(yearMatch[0], 10) - year) > 1)
                    return;
            }
            let postUrl;
            try {
                postUrl = new URL($item.find('link').first().text().trim());
            }
            catch { /* invalid URL */ }
            if (!postUrl || !postUrl.href.startsWith(this.baseUrl))
                return;
            // Group by release title (without trailing size) so the same release
            // only produces one result even if it appears on multiple pages.
            const titleKey = normalize(title.replace(/\s*[-–]\s*[\d.]+\s*(?:GB|MB|KB|TB)\s*$/i, ''));
            if (!groups.has(titleKey)) {
                groups.set(titleKey, {
                    title,
                    postUrl,
                    height: (0, utils_1.findHeight)(title),
                    bytes: parseSizeBytes(title),
                });
            }
        });
        return [...groups.values()];
    }
    /** Load a post page in the headful browser, let Turnstile auto-solve, submit
     *  the Content Protector form and collect the revealed hoster links. */
    async revealPostLinks(ctx, postUrl) {
        const cached = revealedLinksCache.get(postUrl.href);
        if (cached && Date.now() - cached.ts < REVEALED_LINKS_TTL) {
            return cached.urls;
        }
        const logger = this.fetcher.getLogger();
        const browser = await (0, utils_1.getHeadfulBrowser)(logger);
        const page = await browser.newPage();
        try {
            await page.setViewport({ width: 1280, height: 900 });
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                // @ts-expect-error - window.chrome is not typed
                window.chrome = { runtime: {} };
            });
            await page.goto(postUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
            // Invisible Turnstile widget: wait until it has produced its token.
            try {
                await page.waitForFunction(() => {
                    const el = document.querySelector('input[name="cf-turnstile-response"]');
                    return !!el && !!el.value && el.value.length > 10;
                }, { timeout: 20000 });
            }
            catch { /* widget absent or slow — submit anyway, server decides */ }
            await page.evaluate(() => {
                const form = document.querySelector('form[id^="content-protector-access-form"]');
                const btn = form?.querySelector('input[type="submit"], button[type="submit"]');
                if (!btn)
                    throw new Error('content-protector form not found');
                btn.click();
            });
            await page.waitForFunction(() => /rapidgator\.net|nitroflare\.com|rg\.to|1fichier\.com|ddownload\.com|turbobit\.net|katfile\.com|uploadgig\.com/i.test(document.body.innerHTML), { timeout: 25000 });
            const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href));
            const urls = [];
            const seen = new Set();
            for (const href of hrefs) {
                try {
                    const url = new URL(href);
                    if (!(0, utils_1.isDebridHoster)(url.host) || seen.has(url.href))
                        continue;
                    seen.add(url.href);
                    urls.push(url);
                }
                catch { /* invalid URL */ }
            }
            if (urls.length > 0) {
                revealedLinksCache.set(postUrl.href, { urls, ts: Date.now() });
            }
            return urls;
        }
        finally {
            await page.close().catch(() => { });
        }
    }
}
exports.HDEncode = HDEncode;
