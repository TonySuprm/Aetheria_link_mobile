"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcerMovies = void 0;
const bytes_1 = __importDefault(require("bytes"));
const types_1 = require("../types");
const utils_1 = require("../utils");
const Source_1 = require("./Source");
/**
 * AcerMovies (acermovies.fun) source.
 *
 * acermovies.fun is a SPA frontend that proxies moviesmod.at. Its backend API at
 * api2.acermovies.fun provides:
 *   POST /api/search         { searchQuery } → { searchResult: [{ title, url, image }] }
 *   POST /api/sourceQuality  { url }         → { sourceQualityList, meta: { imdbId, type } }
 *   POST /api/sourceEpisodes { url }         → { sourceEpisodes: [{ title: "Episode N", link }] }
 *   POST /api/sourceUrl      { url, seriesType } → { sourceUrl: <direct CDN URL> }
 *
 * Movies: each quality item has a `url` (links.modpro.blog/archives/<id>). We call /api/sourceUrl
 * eagerly to resolve to a video-downloads.googleusercontent.com direct URL, then route through
 * /relay (the relay allow-list already includes that host). 720p/1080p only.
 *
 * Series: each quality item has an `episodesUrl` (episodes.modpro.blog/archives/<id>). We call
 * /api/sourceEpisodes to get episode links, which are cloud.unblockedgames.world/?sid=<base64> URLs
 * — the UHDMovies extractor resolves those lazily at play time. Season is parsed from the quality
 * title (e.g. "Season 1 {Hindi-English} 1080p x264"). 720p/1080p only.
 */
const API_BASE = 'https://api2.acermovies.fun';
const ORIGIN = 'https://acermovies.fun';
const SIZE_RE = /\[?\s*([\d.]+)\s*(GB|MB)\s*\]?/i;
const YEAR_RE = /\b(19[89]\d|20\d{2})\b/;
const SEASON_RE = /season\s*(\d+)/i;
const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const parseHeight = (text) => {
    if (/2160p|4k/i.test(text))
        return 2160;
    if (/1080p/i.test(text))
        return 1080;
    if (/720p/i.test(text))
        return 720;
    if (/480p/i.test(text))
        return 480;
    return 0;
};
const parseSize = (text) => {
    const m = text.match(SIZE_RE);
    if (!m)
        return undefined;
    return bytes_1.default.parse(`${m[1]} ${m[2]}`) ?? undefined;
};
class AcerMovies extends Source_1.Source {
    id = 'acermovies';
    label = 'AcerMovies';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi, types_1.CountryCode.hi, types_1.CountryCode.en];
    baseUrl = 'https://acermovies.fun';
    fetcher;
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    get logger() {
        return this.fetcher.getLogger();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async postJson(ctx, path, body) {
        const url = new URL(path, API_BASE);
        const data = JSON.stringify(body);
        const text = await this.fetcher.textPost(ctx, url, data, {
            headers: {
                'Content-Type': 'application/json',
                'Origin': ORIGIN,
                'Referer': `${ORIGIN}/`,
            },
        });
        return JSON.parse(text);
    }
    async handleInternal(ctx, type, id) {
        if (type !== 'movie' && type !== 'series')
            return [];
        const tmdbId = await (0, utils_1.getTmdbId)(ctx, this.fetcher, id);
        const [name, year] = await (0, utils_1.getTmdbNameAndYear)(ctx, this.fetcher, tmdbId);
        if (!name)
            return [];
        let searchRes;
        try {
            searchRes = await this.postJson(ctx, '/api/search', { searchQuery: name });
        }
        catch (e) {
            this.logger.info(`AcerMovies: search failed: ${e instanceof Error ? e.message : e}`, ctx);
            return [];
        }
        const results = searchRes.searchResult ?? [];
        if (!results.length) {
            this.logger.info(`AcerMovies: no search results for "${name}"`, ctx);
            return [];
        }
        const target = clean(name);
        const yearOf = (r) => {
            const m = r.title.match(YEAR_RE);
            return m?.[1] ? parseInt(m[1], 10) : undefined;
        };
        const candidates = results.filter((r) => clean(r.title).includes(target));
        if (!candidates.length) {
            this.logger.info(`AcerMovies: no title match for "${name}" ${year ?? ''}`, ctx);
            return [];
        }
        // Prefer a candidate whose year matches the requested title — the search index
        // mixes in same-name entries without a year (e.g. "My Adventures with Superman"
        // when searching the Superman movie), which otherwise win by list order and
        // yield no playable qualities.
        const matched = (year
            ? candidates.find((r) => { const y = yearOf(r); return y !== undefined && Math.abs(y - year) <= 1; })
            : undefined)
            ?? candidates[0];
        if (!matched) {
            this.logger.info(`AcerMovies: no title match for "${name}" ${year ?? ''}`, ctx);
            return [];
        }
        let qualityRes;
        try {
            qualityRes = await this.postJson(ctx, '/api/sourceQuality', { url: matched.url });
        }
        catch (e) {
            this.logger.info(`AcerMovies: sourceQuality failed: ${e instanceof Error ? e.message : e}`, ctx);
            return [];
        }
        const qualityList = qualityRes.sourceQualityList ?? [];
        if (!qualityList.length) {
            this.logger.info(`AcerMovies: no quality list for ${matched.url}`, ctx);
            return [];
        }
        if (type === 'movie') {
            return this.handleMovie(ctx, qualityList);
        }
        return this.handleSeries(ctx, qualityList, tmdbId.season ?? 1, tmdbId.episode ?? 1);
    }
    // The API occasionally drops one of several parallel POSTs; a single spaced retry
    // recovers it.
    async postWithRetry(ctx, path, body) {
        try {
            return await this.postJson(ctx, path, body);
        }
        catch {
            await new Promise((res) => setTimeout(res, 1200));
            return this.postJson(ctx, path, body);
        }
    }
    async handleMovie(ctx, qualityList) {
        const results = [];
        const seenHeights = new Set();
        const filtered = qualityList.filter((q) => {
            const h = parseHeight(q.title);
            if (h !== 720 && h !== 1080)
                return false;
            if (seenHeights.has(h))
                return false;
            seenHeights.add(h);
            return true;
        });
        const resolved = await Promise.allSettled(filtered.map(q => this.postWithRetry(ctx, '/api/sourceUrl', { url: q.url, seriesType: 'movie' })));
        for (let i = 0; i < filtered.length; i++) {
            const q = filtered[i];
            if (!q)
                continue;
            const r = resolved[i];
            if (!r || r.status !== 'fulfilled')
                continue;
            const sourceUrl = r.value.sourceUrl;
            if (!sourceUrl)
                continue;
            const height = parseHeight(q.title);
            const sizeBytes = parseSize(q.title);
            const fileLabel = q.title.replace(/\s*\[.*?\]\s*/g, ' ').trim();
            const relayUrl = new URL('/relay/movie.mkv', ctx.hostUrl);
            relayUrl.searchParams.set('url', sourceUrl);
            const resBadge = height ? (0, utils_1.getClosestResolution)(height) : 'Unknown';
            const sizeBadge = sizeBytes ? `⬇️ ${(sizeBytes / 1e9).toFixed(1)} GB` : '';
            const meta = {
                title: `[AcerMovies] ${resBadge} ${fileLabel} ${sizeBadge}`,
                ...(height && { height }),
                ...(sizeBytes && { bytes: sizeBytes }),
                sourceLabel: this.label,
                countryCodes: this.countryCodes,
            };
            results.push({ url: relayUrl, notWebReady: true, meta });
        }
        return results;
    }
    async handleSeries(ctx, qualityList, season, episode) {
        const seasonItems = qualityList.filter((q) => {
            const sMatch = q.title.match(SEASON_RE);
            if (!sMatch?.[1] || parseInt(sMatch[1], 10) !== season)
                return false;
            const h = parseHeight(q.title);
            return h === 720 || h === 1080;
        });
        if (!seasonItems.length) {
            this.logger.info(`AcerMovies: no quality items for S${season}`, ctx);
            return [];
        }
        const episodeResponses = await Promise.allSettled(seasonItems.map(q => this.postWithRetry(ctx, '/api/sourceEpisodes', { url: q.episodesUrl })));
        const results = [];
        for (let i = 0; i < seasonItems.length; i++) {
            const q = seasonItems[i];
            if (!q)
                continue;
            const r = episodeResponses[i];
            if (!r || r.status !== 'fulfilled')
                continue;
            const episodes = r.value?.sourceEpisodes ?? [];
            const epItem = episodes.find((e) => {
                const m = e.title.match(/episode\s*(\d+)/i);
                return m?.[1] && parseInt(m[1], 10) === episode;
            });
            if (!epItem || !epItem.link)
                continue;
            const height = parseHeight(q.title);
            const sizeBytes = parseSize(q.title);
            const fileLabel = q.title.replace(/\s*\[.*?\]\s*/g, ' ').trim();
            const sidUrl = new URL(epItem.link);
            const resBadge = height ? (0, utils_1.getClosestResolution)(height) : 'Unknown';
            const sizeBadge = sizeBytes ? `⬇️ ${(sizeBytes / 1e9).toFixed(1)} GB` : '';
            const meta = {
                title: `[AcerMovies] S${season}E${episode} ${resBadge} ${fileLabel} ${sizeBadge}`,
                ...(height && { height }),
                ...(sizeBytes && { bytes: sizeBytes }),
                sourceLabel: this.label,
                countryCodes: this.countryCodes,
                season,
                episode,
            };
            results.push({ url: sidUrl, meta });
        }
        return results;
    }
}
exports.AcerMovies = AcerMovies;
