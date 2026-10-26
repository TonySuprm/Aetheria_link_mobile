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
exports.KissAsianTV = void 0;
const cheerio = __importStar(require("cheerio"));
const types_1 = require("../types");
const utils_1 = require("../utils");
const Source_1 = require("./Source");
class KissAsianTV extends Source_1.Source {
    id = 'kissasiantv';
    label = 'KissAsianTV';
    contentTypes = ['movie', 'series'];
    countryCodes = [types_1.CountryCode.multi, types_1.CountryCode.ko, types_1.CountryCode.ja];
    baseUrl = 'https://kissasiantv.my';
    category = 'asiandrama';
    fetcher;
    constructor(fetcher) {
        super();
        this.fetcher = fetcher;
    }
    async handleInternal(ctx, _type, id) {
        const tmdbId = await (0, utils_1.getTmdbId)(ctx, this.fetcher, id);
        const [name, _year, _original_name, original_language] = await (0, utils_1.getTmdbNameAndYear)(ctx, this.fetcher, tmdbId);
        // Strict Origin Lock: Prevent KissAsian from polluting English search queries natively.
        // By restricting execution to known SE Asian TMDB definitions, we guarantee it only runs on target media,
        // solving the pollution bug while letting it eagerly activate regardless of user language checkboxes.
        const asianLanguages = new Set(['ko', 'ja', 'zh', 'cn', 'th', 'vi']);
        if (original_language && !asianLanguages.has(original_language.toLowerCase())) {
            return [];
        }
        if (!name)
            return [];
        const searchUrl = new URL(this.baseUrl);
        searchUrl.searchParams.set('s', name);
        try {
            const searchHtml = await this.fetcher.text(ctx, searchUrl, { noProxyHeaders: true });
            const $ = cheerio.load(searchHtml);
            const firstResult = $('a[href*="/series/"]').first().attr('href');
            if (!firstResult) {
                return [];
            }
            const slug = new URL(firstResult).pathname.split('/').filter(Boolean).pop();
            if (!slug)
                return [];
            const targetEpNumber = tmdbId.episode || 1;
            // Reconstruct episode URL dynamically bypassing missing series page links
            const targetHref = `${this.baseUrl}/${slug}-ep-${targetEpNumber}-eng-sub/`;
            const episodeUrl = new URL(targetHref);
            const episodeHtml = await this.fetcher.text(ctx, episodeUrl, { noProxyHeaders: true, validateStatus: () => true });
            const $ep = cheerio.load(episodeHtml);
            const fetchedIframes = [];
            // 1. Direct iframes on episode page
            $ep('iframe').each((_, el) => {
                const src = $ep(el).attr('src')?.trim();
                if (src)
                    fetchedIframes.push(src);
            });
            // 2. data-urls targeting kisskh spaces
            const dataHrefs = [];
            $ep('[data-url], [data-video], [data-src], [data-link]').each((_, el) => {
                const d = ($ep(el).attr('data-url') || $ep(el).attr('data-video') || $ep(el).attr('data-src') || $ep(el).attr('data-link'))?.trim();
                if (d && d.includes('http'))
                    dataHrefs.push(d);
            });
            await Promise.all(dataHrefs.map(async (dUrl) => {
                try {
                    const dHtml = await this.fetcher.text(ctx, new URL(dUrl), { noProxyHeaders: true });
                    const $d = cheerio.load(dHtml);
                    $d('iframe').each((_, el) => {
                        const s = $d(el).attr('src')?.trim();
                        if (s)
                            fetchedIframes.push(s);
                    });
                    // Embedded server-list players (e.g. zumivids) expose each host as a
                    // <li data-video="..."> option, not an iframe.
                    $d('[data-video]').each((_, el) => {
                        const s = $d(el).attr('data-video')?.trim();
                        if (s && /^https?:/.test(s))
                            fetchedIframes.push(s);
                    });
                }
                catch (e) { }
            }));
            const distinctIframes = Array.from(new Set(fetchedIframes));
            if (!distinctIframes.length) {
                return [];
            }
            return distinctIframes.map(embedUrl => ({
                url: new URL(embedUrl.startsWith('//') ? `https:${embedUrl}` : embedUrl),
                meta: { title: `${name}`, referer: episodeUrl.href, countryCodes: this.countryCodes }
            }));
        }
        catch (e) {
            return [];
        }
    }
}
exports.KissAsianTV = KissAsianTV;
