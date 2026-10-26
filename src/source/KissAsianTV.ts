import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, getTmdbId, getTmdbNameAndYear, Id } from '../utils';
import { Source, SourceResult } from './Source';

export class KissAsianTV extends Source {
    public override readonly id = 'kissasiantv';
    public override readonly label = 'KissAsianTV';

    public override readonly contentTypes: ContentType[] = ['movie', 'series'];
    public override readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.ko, CountryCode.ja];
    public override readonly baseUrl = 'https://kissasiantv.my';
    public override readonly category = 'asiandrama' as const;

    private readonly fetcher: Fetcher;

    public constructor(fetcher: Fetcher) {
        super();
        this.fetcher = fetcher;
    }

    public override async handleInternal(ctx: Context, _type: string, id: Id): Promise<SourceResult[]> {
        const tmdbId = await getTmdbId(ctx, this.fetcher, id);
        const [name, _year, _original_name, original_language] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);

        // Strict Origin Lock: Prevent KissAsian from polluting English search queries natively.
        // By restricting execution to known SE Asian TMDB definitions, we guarantee it only runs on target media,
        // solving the pollution bug while letting it eagerly activate regardless of user language checkboxes.
        const asianLanguages = new Set(['ko', 'ja', 'zh', 'cn', 'th', 'vi']);
        if (original_language && !asianLanguages.has(original_language.toLowerCase())) {
            return [];
        }

        if (!name) return [];

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
            if (!slug) return [];

            const targetEpNumber = tmdbId.episode || 1;

            // Reconstruct episode URL dynamically bypassing missing series page links
            const targetHref = `${this.baseUrl}/${slug}-ep-${targetEpNumber}-eng-sub/`;
            const episodeUrl = new URL(targetHref);

            const episodeHtml = await this.fetcher.text(ctx, episodeUrl, { noProxyHeaders: true, validateStatus: () => true });
            const $ep = cheerio.load(episodeHtml);

            const fetchedIframes: string[] = [];

            // 1. Direct iframes on episode page
            $ep('iframe').each((_, el) => {
                const src = $ep(el).attr('src')?.trim();
                if (src) fetchedIframes.push(src);
            });

            // 2. data-urls targeting kisskh spaces
            const dataHrefs: string[] = [];
            $ep('[data-url], [data-video], [data-src], [data-link]').each((_, el) => {
                const d = ($ep(el).attr('data-url') || $ep(el).attr('data-video') || $ep(el).attr('data-src') || $ep(el).attr('data-link'))?.trim();
                if (d && d.includes('http')) dataHrefs.push(d);
            });

            await Promise.all(dataHrefs.map(async (dUrl) => {
                try {
                    const dHtml = await this.fetcher.text(ctx, new URL(dUrl), { noProxyHeaders: true });
                    const $d = cheerio.load(dHtml);
                    $d('iframe').each((_, el) => {
                        const s = $d(el).attr('src')?.trim();
                        if (s) fetchedIframes.push(s);
                    });
                    // Embedded server-list players (e.g. zumivids) expose each host as a
                    // <li data-video="..."> option, not an iframe.
                    $d('[data-video]').each((_, el) => {
                        const s = $d(el).attr('data-video')?.trim();
                        if (s && /^https?:/.test(s)) fetchedIframes.push(s);
                    });
                } catch (e) { }
            }));

            const distinctIframes = Array.from(new Set(fetchedIframes));

            if (!distinctIframes.length) {
                return [];
            }

            return distinctIframes.map(embedUrl => ({
                url: new URL(embedUrl.startsWith('//') ? `https:${embedUrl}` : embedUrl),
                meta: { title: `${name}`, referer: episodeUrl.href, countryCodes: this.countryCodes }
            }));

        } catch (e) {
            return [];
        }
    }
}
