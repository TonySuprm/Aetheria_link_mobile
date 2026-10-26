"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VidVault = void 0;
const types_1 = require("../types");
const utils_1 = require("../utils");
const Source_1 = require("./Source");
class VidVault extends Source_1.Source {
    id = 'vidvault';
    label = 'VidVault';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi, types_1.CountryCode.ru];
    // vidvault.ru 301s here since ~Oct 2026; only the API host matters (no web frontend).
    baseUrl = 'https://vidvault.to';
    fetcher;
    UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    get logger() {
        return this.fetcher.getLogger();
    }
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    async handleInternal(ctx, type, id) {
        if (type !== 'movie' && type !== 'series')
            return [];
        const tmdbIdInfo = await (0, utils_1.getTmdbId)(ctx, this.fetcher, id);
        const tmdbId = tmdbIdInfo.id;
        if (!tmdbId)
            return [];
        const [name, year] = await (0, utils_1.getTmdbNameAndYear)(ctx, this.fetcher, tmdbIdInfo);
        this.logger.info(`VidVault: Starting lookup for ${name} (${year}) ep ${id.episode || 1}`, ctx);
        try {
            // 1. Fetch CSRF verification token
            const tokenResText = await this.fetcher.text(ctx, new URL(`${this.baseUrl}/api/get-token`), {
                headers: { 'User-Agent': this.UA, 'Referer': `${this.baseUrl}/` }
            });
            const tokenRes = JSON.parse(tokenResText);
            const token = tokenRes?.t;
            if (!token) {
                this.logger.warn(`VidVault: Missing CSRF deployment token`, ctx);
                return [];
            }
            // 2. Transmit TMDB payload and extract internal video links
            const payload = {
                type: type === 'series' ? 'tv' : 'movie',
                tmdbId: tmdbId.toString(),
                season: type === 'series' ? (id.season || 1) : null,
                episode: type === 'series' ? (id.episode || 1) : null,
            };
            const streamResText = await this.fetcher.text(ctx, new URL(`${this.baseUrl}/api/download-proxy`), {
                method: 'POST',
                headers: {
                    'User-Agent': this.UA,
                    'Referer': type === 'series' ? `${this.baseUrl}/tv/${tmdbId}/season/${payload.season}` : `${this.baseUrl}/movie/${tmdbId}`,
                    'Origin': this.baseUrl,
                    'x-request-token': token,
                    'Content-Type': 'application/json',
                },
                data: JSON.stringify(payload),
            });
            const streamRes = JSON.parse(streamResText);
            const mp4Data = streamRes?.mp4Data?.data?.data || streamRes?.mp4Data?.downloadInfo?.data || streamRes?.mp4Data?.data || streamRes?.mp4Data;
            const results = [];
            if (!mp4Data)
                return [];
            const arrays = [mp4Data?.streams, mp4Data?.downloads].filter(Boolean);
            const suffix = type === 'series' ? `S${payload.season}E${payload.episode}` : '';
            for (const arr of arrays) {
                if (Array.isArray(arr)) {
                    for (const item of arr) {
                        if (!item.url || typeof item.url !== 'string')
                            continue;
                        const sizeStr = item.size ? (Number(item.size) / (1024 * 1024)).toFixed(0) + ' MB' : '';
                        const sizeBadge = sizeStr ? `⬇️ ${sizeStr}` : '';
                        const resBadge = item.resolution ? `${item.resolution}p` : 'Unknown';
                        results.push({
                            url: item.url,
                            notWebReady: false,
                            meta: {
                                title: `[VidVault]\n${name} ${suffix} - ${resBadge} ${sizeBadge}`,
                                sourceLabel: 'VidVault',
                                countryCodes: this.countryCodes,
                                ...(item.size && { bytes: Number(item.size) }),
                                ...(item.resolution && { height: Number(item.resolution) }),
                            }
                        });
                    }
                }
            }
            return results;
        }
        catch (e) {
            this.logger.info(`VidVault: Failed to extract streaming payload: ${e.message}`, ctx);
            return [];
        }
    }
}
exports.VidVault = VidVault;
