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
exports.Animexin = void 0;
const cheerio = __importStar(require("cheerio"));
const types_1 = require("../types");
const utils_1 = require("../utils");
const Source_1 = require("./Source");
const clean = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
class Animexin extends Source_1.Source {
    id = 'animexin';
    label = 'Animexin';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi, types_1.CountryCode.ja];
    baseUrl = 'https://animexin.dev';
    category = 'anime';
    fetcher;
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    async handleInternal(ctx, type, id) {
        const tmdbId = await (0, utils_1.getTmdbId)(ctx, this.fetcher, id);
        const [name, year] = await (0, utils_1.getTmdbNameAndYear)(ctx, this.fetcher, tmdbId);
        let title = name;
        if (tmdbId.season) {
            title += ` ${tmdbId.formatSeasonAndEpisode()}`;
        }
        else {
            title += ` (${year})`;
        }
        const seriesPageUrl = await this.fetchSeriesPageUrl(ctx, name, type);
        if (!seriesPageUrl) {
            return [];
        }
        // Series: resolve the specific episode page. Movies: the series/movie page already carries the
        // embeds (no episode list), so use it directly.
        let episodePageUrl = seriesPageUrl;
        if (type === 'series') {
            const epUrl = await this.fetchEpisodePageUrl(ctx, seriesPageUrl, tmdbId);
            if (!epUrl) {
                return [];
            }
            episodePageUrl = epUrl;
        }
        const embedUrls = await this.extractEmbedUrls(ctx, episodePageUrl);
        if (embedUrls.length === 0) {
            return [];
        }
        return embedUrls.map(embedUrl => ({ url: embedUrl, meta: { title, countryCodes: [types_1.CountryCode.ja, types_1.CountryCode.multi] } }));
    }
    ;
    fetchSeriesPageUrl = async (ctx, name, type) => {
        const searchUrl = new URL(`/?s=${encodeURIComponent(name)}`, this.baseUrl);
        let html;
        try {
            html = await this.fetcher.text(ctx, searchUrl);
        }
        catch {
            return undefined;
        }
        const $ = cheerio.load(html);
        const nameClean = clean(name);
        const wantMovie = type === 'movie';
        const candidates = [];
        // Real search results live in `.listupd > article.bs > .bsx > a.tip` (title in the `title`
        // attr / inner h2; type in `.typez` — "Movie" vs "ONA"/"TV"). The old selectors only matched the
        // sidebar popular widget and couldn't distinguish a same-name Movie from the Series.
        $('.listupd .bsx, .listupd article').each((_, el) => {
            const $el = $(el);
            const anchor = $el.find('a').first();
            const href = anchor.attr('href') ?? '';
            if (!href.startsWith(this.baseUrl))
                return;
            const title = (anchor.attr('title') || $el.find('h2').first().text() || anchor.text()).trim();
            if (!title)
                return;
            const typez = $el.find('.typez').first().text().trim().toLowerCase();
            // .typez misses some same-name movie posts; the slug says it too
            // ("perfect-world-movie-..." vs "anime/perfect-world-wanmei-shijie").
            const movieish = typez === 'movie' || /-movie-|-movies?\/|movie-part/.test(href);
            candidates.push({ href, title, isMovie: movieish, exact: clean(title) === nameClean });
        });
        // Fallback: sidebar popular widget (`a.series` / `.leftseries a`) for when the theme renders no
        // `.listupd` results list.
        if (candidates.length === 0) {
            $('a.series, .leftseries a').each((_, el) => {
                const href = $(el).attr('href') ?? '';
                const title = $(el).text().trim();
                if (href.startsWith(this.baseUrl) && title) {
                    candidates.push({ href, title, isMovie: false, exact: clean(title) === nameClean });
                }
            });
        }
        const scored = candidates
            .filter((c) => {
            const t = clean(c.title);
            return t.includes(nameClean) || nameClean.includes(t);
        })
            .sort((a, b) => {
            if (a.exact !== b.exact)
                return a.exact ? -1 : 1;
            const aTypeOk = a.isMovie === wantMovie ? 0 : 1;
            const bTypeOk = b.isMovie === wantMovie ? 0 : 1;
            return aTypeOk - bTypeOk;
        });
        const best = scored[0];
        return best ? new URL(best.href) : undefined;
    };
    fetchEpisodePageUrl = async (ctx, seriesPageUrl, tmdbId) => {
        const html = await this.fetcher.text(ctx, seriesPageUrl);
        const $ = cheerio.load(html);
        if (tmdbId.episode) {
            // Find all episode links and match the exact episode number to avoid substring matching
            // e.g., "episode-1" shouldn't match "episode-145"
            const allLinks = $('.eplister a[href*="-episode-"], .eplister a[href*="-ep-"]').toArray();
            for (const el of allLinks) {
                const href = $(el).attr('href');
                if (href) {
                    const match = href.match(/-episode-(\d+)/) || href.match(/-ep-(\d+)/) || $(el).text().trim().match(/episode\s*(\d+)/i);
                    if (match && match[1] && parseInt(match[1], 10) === tmdbId.episode) {
                        try {
                            return new URL(href, seriesPageUrl.href);
                        }
                        catch { /* invalid href */ }
                    }
                }
            }
        }
        // Fallback: For anime with continuous numbering or if episode not specified
        const links = $('.eplister a[href*="-episode-"], .eplister a[href*="-ep-"]');
        if (links.length > 0) {
            const href = links.first().attr('href');
            if (href) {
                try {
                    return new URL(href, seriesPageUrl.href);
                }
                catch { /* invalid href */ }
            }
        }
        // Ultimate fallback
        const link = $('.eplister a, .episode a, a[href*="/episode-"]').first().attr('href');
        try {
            return link ? new URL(link, seriesPageUrl.href) : undefined;
        }
        catch {
            return undefined;
        }
    };
    extractEmbedUrls = async (ctx, episodePageUrl) => {
        const html = await this.fetcher.text(ctx, episodePageUrl);
        const $ = cheerio.load(html);
        const urls = [];
        const selectOptions = $('select option[value]');
        selectOptions.each((_, el) => {
            const value = $(el).attr('value');
            if (!value)
                return;
            try {
                const decoded = Buffer.from(value, 'base64').toString('utf-8');
                const iframeMatch = decoded.match(/src=["']([^"']+)["']/);
                let src = iframeMatch?.[1];
                if (src) {
                    if (src.startsWith('//')) {
                        src = 'https:' + src;
                    }
                    urls.push(new URL(src));
                }
            }
            catch {
                // ignore invalid base64
            }
        });
        if (urls.length === 0) {
            $('iframe').each((_, el) => {
                let src = $(el).attr('src');
                if (src) {
                    if (src.startsWith('//')) {
                        src = 'https:' + src;
                    }
                    try {
                        urls.push(new URL(src));
                    }
                    catch { /* invalid src */ }
                }
            });
        }
        const blacklistedHosts = ['rumble.com', 'doods.pro', 'doodstream', 'playmogo.com'];
        return [...new Set(urls.map(u => u.href))]
            .map(u => new URL(u))
            .filter(u => !blacklistedHosts.some(host => u.host.includes(host)));
    };
}
exports.Animexin = Animexin;
