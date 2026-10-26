"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Kitsu = void 0;
const types_1 = require("../types");
const utils_1 = require("../utils");
const Source_1 = require("./Source");
class Kitsu extends Source_1.Source {
    id = 'kitsu';
    label = 'Kitsu';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi];
    baseUrl = 'https://kitsu.io';
    category = 'anime';
    fetcher;
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    async searchAnime(ctx, name) {
        try {
            const url = new URL('/api/edge/anime', this.baseUrl);
            url.searchParams.append('filter[text]', name);
            url.searchParams.append('page[limit]', '5');
            const response = await this.fetcher.json(ctx, url);
            if (!response.data || response.data.length === 0) {
                return null;
            }
            return response.data[0];
        }
        catch {
            return null;
        }
    }
    async getEpisodes(ctx, animeId, season) {
        try {
            const url = new URL(`/api/edge/anime/${animeId}/episodes`, this.baseUrl);
            // API rejects page[limit] > 20 (400) since ~Oct 2026; follow links.next instead.
            url.searchParams.append('page[limit]', '20');
            const episodes = [];
            let urlToFetch = url;
            let pages = 0;
            while (urlToFetch && pages < 10) {
                pages++;
                const response = await this.fetcher.json(ctx, urlToFetch);
                for (const episode of response.data) {
                    if (season && episode.attributes.seasonNumber !== undefined && episode.attributes.seasonNumber !== season)
                        continue;
                    episodes.push(`/api/edge/anime/${animeId}/episodes/${episode.id}`);
                }
                urlToFetch = response.links.next ? new URL(response.links.next) : null;
            }
            return episodes;
        }
        catch {
            return [];
        }
    }
    async handleInternal(ctx, _type, id) {
        let anime = null;
        let season;
        if (id instanceof utils_1.KitsuId) {
            // Use the Kitsu ID directly: the title search based on a TMDB-converted name often fails
            // for anime because Kitsu canonical titles differ from TMDB names.
            anime = await (0, utils_1.getKitsuAnimeMeta)(ctx, this.fetcher, id);
            season = id.episode !== undefined ? 1 : undefined;
        }
        else {
            const tmdbId = await (0, utils_1.getTmdbId)(ctx, this.fetcher, id);
            const [name] = await (0, utils_1.getTmdbNameAndYear)(ctx, this.fetcher, tmdbId);
            season = tmdbId.season;
            anime = await this.searchAnime(ctx, name);
        }
        if (!anime) {
            return [];
        }
        const animeId = anime.id;
        const episodeUrls = await this.getEpisodes(ctx, animeId, season);
        if (episodeUrls.length === 0) {
            return [];
        }
        return episodeUrls.map(url => ({
            url: new URL(url, this.baseUrl),
            meta: {
                title: anime.attributes.canonicalTitle,
                countryCodes: [types_1.CountryCode.multi],
            },
        }));
    }
}
exports.Kitsu = Kitsu;
