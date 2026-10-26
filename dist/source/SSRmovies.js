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
exports.SSRmovies = void 0;
const bytes_1 = __importDefault(require("bytes"));
const cheerio = __importStar(require("cheerio"));
const types_1 = require("../types");
const utils_1 = require("../utils");
const Source_1 = require("./Source");
const LINKSZILLA_SELECTOR = 'a[href*="linkszilla"]';
const SIZE_RE = /([\d.]+)\s*(GB|MB)/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
/** Parse "Watch & Download in 1080p - 2.2GB" → { height: 1080, bytes: ... }. 4K/2160p → 2160. */
const parseQuality = (text) => {
    let height = 0;
    if (/2160p|4k/i.test(text))
        height = 2160;
    else if (/1080p/i.test(text))
        height = 1080;
    else if (/720p/i.test(text))
        height = 720;
    else if (/480p/i.test(text))
        height = 480;
    let parsedBytes;
    const sizeMatch = text.match(SIZE_RE);
    if (sizeMatch) {
        parsedBytes = bytes_1.default.parse(`${sizeMatch[1]} ${sizeMatch[2]}`) ?? undefined;
    }
    return { height, bytes: parsedBytes };
};
class SSRmovies extends Source_1.Source {
    id = 'ssrmovies';
    label = 'SSRmovies';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi, types_1.CountryCode.hi];
    baseUrl = 'https://ssrmovies.com';
    fetcher;
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    async prewarm(ctx) {
        try {
            await this.fetcher.text(ctx, new URL(this.baseUrl));
            this.fetcher.getLogger().info('SSRmovies: pre-warm complete', ctx);
        }
        catch (error) {
            this.fetcher.getLogger().warn(`SSRmovies: pre-warm failed: ${error}`, ctx);
        }
    }
    clean(str) {
        return str.toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    async handleInternal(ctx, type, id) {
        if (type !== 'movie' && type !== 'series')
            return [];
        const tmdbId = await (0, utils_1.getTmdbId)(ctx, this.fetcher, id);
        const [name, year] = await (0, utils_1.getTmdbNameAndYear)(ctx, this.fetcher, tmdbId);
        if (!name)
            return [];
        const postUrl = await this.findPost(ctx, name, year, tmdbId.season);
        if (!postUrl) {
            this.logger.info(`SSRmovies: no post matched TMDB "${name}" ${year ?? ''}`, ctx);
            return [];
        }
        const html = await this.fetcher.text(ctx, postUrl, { headers: { Referer: this.baseUrl } });
        const $ = cheerio.load(html);
        // Series: only per-episode "Single Links" headings. "Complete ... Zip" packs are skipped
        // (a .zip is an archive — Stremio can't play it internally; would need a full download +
        // extract first). Movies: every linkszilla download button on the page.
        const targets = tmdbId.season
            ? this.collectEpisodeLinks($, tmdbId.season, tmdbId.episode)
            : this.collectMovieLinks($);
        const results = (await Promise.all(targets
            .filter(t => t.height === 2160 || t.height === 1080 || t.height === 720)
            .map(async (target) => {
            const hubUrl = await this.resolveHubcloud(ctx, target.href, postUrl);
            if (!hubUrl)
                return null;
            // No `referer` here: matching the 4KHDHub format. Setting meta.referer would make
            // StreamResolver attach proxyHeaders (Referer = ssrmovies post) to the lazy /extract URL,
            // forcing Stremio to wrap it through its internal proxy and forward that Referer to the
            // final HubCloud CDN link — which rejects the foreign Referer and playback stalls at 0:00.
            // HubCloud falls back to using the hubcloud URL itself as Referer (HubCloud.ts), which works.
            const meta = {
                countryCodes: this.countryCodes,
                height: target.height,
                title: target.label,
                ...(target.bytes && { bytes: target.bytes }),
                sourceLabel: this.label,
            };
            return { url: hubUrl, meta };
        }))).filter((r) => r !== null);
        return results;
    }
    /** Search the WP site and pick the post whose title starts with the name + matches the year (+ season). */
    async findPost(ctx, name, year, season) {
        const searchUrl = new URL(`/?s=${encodeURIComponent(name)}`, this.baseUrl);
        let html;
        try {
            html = await this.fetcher.text(ctx, searchUrl, { headers: { Referer: this.baseUrl } });
        }
        catch {
            return undefined;
        }
        const $ = cheerio.load(html);
        const nameClean = this.clean(name);
        const seasonRe = season ? new RegExp(`\\bS0?${season}\\b|\\bSeason\\s+${season}\\b`, 'i') : undefined;
        // Post pages live on a rotating content mirror (currently ssrmovies.surf)
        // while the search frontend is ssrmovies.com — accept both host families.
        const postHostOk = (href) => href.startsWith(`${this.baseUrl}/`) || /^https?:\/\/[a-z0-9.-]*ssrmovies\.[a-z.]+\//i.test(href);
        const candidates = [];
        $('a').each((_, el) => {
            const href = $(el).attr('href') ?? '';
            const title = $(el).text().trim();
            if (!postHostOk(href) || title.length < 4)
                return;
            if (href.includes('/page/') || href.includes('/category/') || href.includes('/wp-') || href.endsWith('/feed/'))
                return;
            // Post slugs have at least one path segment beyond the root.
            if (href.replace(/^https?:\/\/[^/]+\//, '').split('/').filter(Boolean).length < 1)
                return;
            candidates.push({ href, title });
        });
        for (const { href, title } of candidates) {
            if (!this.clean(title).startsWith(nameClean))
                continue;
            const yearMatch = title.match(YEAR_RE);
            if (year && yearMatch) {
                if (Math.abs(parseInt(yearMatch[0], 10) - year) > 1)
                    continue;
            }
            if (seasonRe && !seasonRe.test(title))
                continue;
            return new URL(href);
        }
        return undefined;
    }
    /** Movie post: every linkszilla download button. */
    collectMovieLinks($) {
        const links = [];
        $(LINKSZILLA_SELECTOR).each((_, el) => {
            const href = $(el).attr('href') ?? '';
            const text = $(el).text().trim();
            if (!href || !text)
                return;
            const { height, bytes } = parseQuality(text);
            links.push({ href, height, bytes, label: text });
        });
        return links;
    }
    /** Series post: linkszilla buttons that follow the heading for the requested S/E (until the next heading). */
    collectEpisodeLinks($, season, episode) {
        if (!episode)
            return [];
        const epRe = new RegExp(`\\bS0?${season}E0?${episode}\\b`, 'i');
        const epReAlt = new RegExp(`\\bSeason\\s+${season}\\b.*\\bEpisode\\s+${episode}\\b`, 'i');
        const heading = $('h2,h3,h4,h5,h6')
            .filter((_, el) => epRe.test($(el).text()) || epReAlt.test($(el).text()))
            .first();
        if (!heading.length)
            return [];
        const scope = heading.nextUntil('h2,h3,h4,h5,h6');
        const links = [];
        scope.find(LINKSZILLA_SELECTOR).each((_, el) => {
            const href = $(el).attr('href') ?? '';
            const text = $(el).text().trim();
            if (!href || !text)
                return;
            const { height, bytes } = parseQuality(text);
            links.push({ href, height, bytes, label: text });
        });
        return links;
    }
    /** Follow a linkszilla short link and pick the HubCloud hoster URL (fast, resumable, gdrive-backed; repo-extracted). */
    async resolveHubcloud(ctx, linkszillaUrl, postUrl) {
        let html;
        try {
            html = await this.fetcher.text(ctx, new URL(linkszillaUrl), { headers: { Referer: postUrl.href } });
        }
        catch (e) {
            this.logger.info(`SSRmovies: linkszilla resolve failed for ${linkszillaUrl}: ${e instanceof Error ? e.message : String(e)}`, ctx);
            return undefined;
        }
        const $ = cheerio.load(html);
        let hubUrl;
        $('a').each((_, el) => {
            if (hubUrl)
                return;
            const href = $(el).attr('href') ?? '';
            if (!href || !utils_1.HUB_HOST_PATTERN.test(href))
                return;
            try {
                const url = new URL(href);
                if (utils_1.DEAD_HUBCLOUD_HOSTS.has(url.hostname))
                    return;
                hubUrl = url;
            }
            catch {
                // skip invalid
            }
        });
        return hubUrl;
    }
    get logger() {
        return this.fetcher.getLogger();
    }
}
exports.SSRmovies = SSRmovies;
