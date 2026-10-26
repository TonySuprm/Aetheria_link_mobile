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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Animesalt = void 0;
const cheerio = __importStar(require("cheerio"));
const types_1 = require("../types");
const utils_1 = require("../utils");
const Source_1 = require("./Source");
// Animesalt (animesalt.ac) — WordPress anime site (Hindi / English / Japanese multi-audio). Series
// posts `/series/<slug>/` list per-episode links `/episode/<slug>-<S>x<E>/`; movie posts
// `/movies/<slug>/` serve the player directly.
//
// Each episode/movie page embeds a FirePlayer iframe: `https://as-cdn21.top/video/<hash>`. The
// FirePlayer backend exposes a POST API at `/player/index.php?data=<hash>&do=getVideo` that
// returns a JSON object with `videoSource` — a time-limited HLS m3u8 URL on as-cdn21.top (with
// md5 + expires query params, ~6h TTL). The m3u8 is multi-audio (Hindi/Tamil/Telugu/English/Japanese).
//
// Chain:
//   WP search `?s=<name>` -> match `/series/<slug>/` (series) or `/movies/<slug>/` (movie) by slug
//   series -> fetch post -> find `/episode/<slug>-<S>x<E>/` matching the requested season+episode
//   fetch episode page (series) or movie page (movie) -> extract `as-cdnXX.top/video/<hash>` from iframe
//   POST `https://as-cdn21.top/player/index.php?data=<hash>&do=getVideo` -> JSON -> `videoSource` m3u8
//   HLS m3u8 -> MediaFlow HLS proxy (if configured), else raw url with Referer (Stremio proxies it)
const YEAR_RE = /\b(19|20)\d{2}\b/;
// FirePlayer embed host rotates (as-cdn21.top → ravok.buzz → …); the /video/<hash>
// shape and /player/index.php API stay identical on whichever host serves the iframe.
const VIDEO_HASH_RE = /https?:\/\/([a-z0-9-]+\.[a-z.]+)\/video\/([a-f0-9]+)/i;
class Animesalt extends Source_1.Source {
    id = 'animesalt';
    label = 'AnimeSalt';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi, types_1.CountryCode.en, types_1.CountryCode.hi];
    baseUrl = 'https://animesalt.cx';
    category = 'anime';
    // FirePlayer m3u8 URLs expire ~6h (md5+expires query params). Use 1h cache so URL is always fresh.
    ttl = 3600000; // 1h — m3u8 URLs expire ~6h
    fetcher;
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    get logger() {
        return this.fetcher.getLogger();
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
        const postUrl = await this.findPost(ctx, name, year, type);
        if (!postUrl) {
            this.logger.info(`Animesalt: no post matched TMDB "${name}" ${year ?? ''}`, ctx);
            return [];
        }
        let pageUrl = postUrl;
        if (type === 'series') {
            const episodeUrl = await this.findEpisode(ctx, postUrl, tmdbId.season, tmdbId.episode);
            if (!episodeUrl) {
                this.logger.info(`Animesalt: no episode matched S${tmdbId.season ?? '?'}E${tmdbId.episode ?? '?'} on ${postUrl.pathname}`, ctx);
                return [];
            }
            pageUrl = episodeUrl;
        }
        let html;
        try {
            html = await this.fetcher.text(ctx, pageUrl, { headers: { Referer: this.baseUrl } });
        }
        catch {
            return [];
        }
        const hashMatch = html.match(VIDEO_HASH_RE);
        if (!hashMatch?.[2]) {
            this.logger.info(`Animesalt: no video hash on ${pageUrl.pathname}`, ctx);
            return [];
        }
        const playerHost = `https://${hashMatch[1]}`;
        const m3u8Url = await this.resolveVideoSource(ctx, hashMatch[2], playerHost);
        if (!m3u8Url) {
            this.logger.info(`Animesalt: no video source for hash ${hashMatch[2]}`, ctx);
            return [];
        }
        const label = type === 'series'
            ? `[AnimeSalt] ${name} S${tmdbId.season ?? 1}E${tmdbId.episode ?? 1} [Multi-Audio]`
            : `[AnimeSalt] ${name} [Multi-Audio]`;
        const meta = {
            countryCodes: this.countryCodes,
            height: 1080,
            title: label,
            sourceLabel: this.label,
            referer: `${playerHost}/`,
            ...(tmdbId.season && { season: tmdbId.season }),
            ...(tmdbId.episode && { episode: tmdbId.episode }),
        };
        return [{ url: this.buildStreamUrl(ctx, m3u8Url, playerHost), meta, notWebReady: false }];
    }
    /** Search the WP site and pick the post whose slug contains the cleaned name (+ loose year). */
    async findPost(ctx, name, year, type) {
        const searchName = name.replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
        // WP search ranks loosely — the full TMDB name (subtitles et al.) can bury the
        // series post under same-name movies, so retry with the leading words.
        const words = searchName.split(' ').filter(Boolean);
        const queries = [searchName, words.slice(0, 2).join(' '), words[0] ?? ''].filter((q, i, arr) => q && arr.indexOf(q) === i);
        for (const q of queries) {
            const post = await this.findPostOnce(ctx, name, year, type, q);
            if (post)
                return post;
        }
        return undefined;
    }
    async findPostOnce(ctx, name, year, type, searchName) {
        const searchUrl = new URL(`/?s=${encodeURIComponent(searchName)}`, this.baseUrl);
        let html;
        try {
            html = await this.fetcher.text(ctx, searchUrl, { headers: { Referer: this.baseUrl } });
        }
        catch {
            return undefined;
        }
        const $ = cheerio.load(html);
        const pathPrefix = type === 'movie' ? '/movies/' : '/series/';
        const seen = new Set();
        const candidates = [];
        $('a').each((_, el) => {
            const href = $(el).attr('href') ?? '';
            if (!href.startsWith(`${this.baseUrl}${pathPrefix}`))
                return;
            if (seen.has(href))
                return;
            seen.add(href);
            candidates.push({ href, text: $(el).text() });
        });
        // Slugs are usually shorter than the full TMDB name ("demon-slayer" vs
        // "Demon Slayer: Kimetsu no Yaiba"), so require only the leading name words.
        const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
        const primaryWords = words.slice(0, 2);
        for (const { href, text } of candidates) {
            const slug = decodeURIComponent(href.replace(`${this.baseUrl}${pathPrefix}`, '').replace(/\/+$/, ''));
            if (!slug || slug.includes('/'))
                continue;
            const combinedClean = this.clean(`${slug} ${text}`);
            const hit = primaryWords.length
                ? primaryWords.every(w => combinedClean.includes(this.clean(w)))
                : combinedClean.includes(this.clean(name));
            if (!hit)
                continue;
            const combined = `${slug} ${text}`;
            const yearMatch = combined.match(YEAR_RE);
            if (year && yearMatch?.[0] && Math.abs(parseInt(yearMatch?.[0], 10) - year) > 1)
                continue;
            return new URL(href);
        }
        return undefined;
    }
    /** On a series post, find the `/episode/<slug>-<S>x<E>/` link matching the requested episode. */
    async findEpisode(ctx, postUrl, season, episode) {
        if (season === undefined || episode === undefined)
            return undefined;
        let html;
        try {
            html = await this.fetcher.text(ctx, postUrl, { headers: { Referer: this.baseUrl } });
        }
        catch {
            return undefined;
        }
        const $ = cheerio.load(html);
        let found;
        $('a').each((_, el) => {
            if (found)
                return;
            const href = $(el).attr('href') ?? '';
            if (!href.startsWith(`${this.baseUrl}/episode/`))
                return;
            const slug = decodeURIComponent(href.replace(`${this.baseUrl}/episode/`, '').replace(/\/+$/, ''));
            const m = slug.match(/-(\d+)x(\d+)$/i);
            if (!m?.[1] || !m?.[2])
                return;
            if (parseInt(m[1], 10) === season && parseInt(m[2], 10) === episode) {
                found = new URL(href);
            }
        });
        return found;
    }
    /**
     * POST to the FirePlayer backend to resolve a video hash into a time-limited HLS m3u8 URL.
     * The API returns JSON with `videoSource` (m3u8), `hls` (boolean), and `securedLink`.
     */
    async resolveVideoSource(ctx, hash, playerBase) {
        try {
            const apiUrl = new URL(`${playerBase}/player/index.php?data=${hash}&do=getVideo`);
            const body = `hash=${hash}&r=${encodeURIComponent(this.baseUrl + '/')}`;
            const response = await this.fetcher.textPost(ctx, apiUrl, body, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': `${playerBase}/video/${hash}`,
                    'Origin': playerBase,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                timeout: 10000,
            });
            const data = JSON.parse(response);
            if (!data?.videoSource)
                return undefined;
            return new URL(data.videoSource);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Build the playable URL: HLS via MediaFlow proxy (if configured), else the raw m3u8.
     * StreamResolver attaches proxyHeaders (Referer) from meta.referer so Stremio proxies it.
     */
    buildStreamUrl(ctx, m3u8Url, playerHost) {
        if ((0, utils_1.supportsMediaFlowProxy)(ctx)) {
            return (0, utils_1.buildMediaFlowProxyHlsUrl)(ctx, m3u8Url, {
                Referer: `${playerHost}/`,
            }, true);
        }
        return m3u8Url;
    }
}
exports.Animesalt = Animesalt;
