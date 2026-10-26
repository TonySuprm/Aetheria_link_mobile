import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import { buildMediaFlowProxyHlsUrl, Fetcher, getTmdbId, getTmdbNameAndYear, Id, supportsMediaFlowProxy } from '../utils';
import { Source, SourceResult } from './Source';

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

export class Animesalt extends Source {
  public readonly id = 'animesalt';
  public readonly label = 'AnimeSalt';
  public readonly contentTypes: ContentType[] = ['movie', 'series'];
  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.en, CountryCode.hi];
  public readonly baseUrl = 'https://animesalt.cx';
  public override readonly category = 'anime' as const;
  // FirePlayer m3u8 URLs expire ~6h (md5+expires query params). Use 1h cache so URL is always fresh.
  public override readonly ttl = 3600000; // 1h — m3u8 URLs expire ~6h

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  private get logger() {
    return this.fetcher.getLogger();
  }

  private clean(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  protected async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    if (type !== 'movie' && type !== 'series') return [];

    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (!name) return [];

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

    let html: string;
    try {
      html = await this.fetcher.text(ctx, pageUrl, { headers: { Referer: this.baseUrl } });
    } catch {
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

    const meta: Meta = {
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
  private async findPost(ctx: Context, name: string, year: number | undefined, type: ContentType): Promise<URL | undefined> {
    const searchName = name.replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    // WP search ranks loosely — the full TMDB name (subtitles et al.) can bury the
    // series post under same-name movies, so retry with the leading words.
    const words = searchName.split(' ').filter(Boolean);
    const queries = [searchName, words.slice(0, 2).join(' '), words[0] ?? ''].filter(
      (q, i, arr) => q && arr.indexOf(q) === i,
    );
    for (const q of queries) {
      const post = await this.findPostOnce(ctx, name, year, type, q);
      if (post) return post;
    }
    return undefined;
  }

  private async findPostOnce(ctx: Context, name: string, year: number | undefined, type: ContentType, searchName: string): Promise<URL | undefined> {
    const searchUrl = new URL(`/?s=${encodeURIComponent(searchName)}`, this.baseUrl);
    let html: string;
    try {
      html = await this.fetcher.text(ctx, searchUrl, { headers: { Referer: this.baseUrl } });
    } catch {
      return undefined;
    }

    const $ = cheerio.load(html);
    const pathPrefix = type === 'movie' ? '/movies/' : '/series/';

    const seen = new Set<string>();
    const candidates: { href: string; text: string }[] = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href.startsWith(`${this.baseUrl}${pathPrefix}`)) return;
      if (seen.has(href)) return;
      seen.add(href);
      candidates.push({ href, text: $(el).text() });
    });

    // Slugs are usually shorter than the full TMDB name ("demon-slayer" vs
    // "Demon Slayer: Kimetsu no Yaiba"), so require only the leading name words.
    const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    const primaryWords = words.slice(0, 2);

    for (const { href, text } of candidates) {
      const slug = decodeURIComponent(href.replace(`${this.baseUrl}${pathPrefix}`, '').replace(/\/+$/, ''));
      if (!slug || slug.includes('/')) continue;
      const combinedClean = this.clean(`${slug} ${text}`);
      const hit = primaryWords.length
        ? primaryWords.every(w => combinedClean.includes(this.clean(w)))
        : combinedClean.includes(this.clean(name));
      if (!hit) continue;

      const combined = `${slug} ${text}`;
      const yearMatch = combined.match(YEAR_RE);
      if (year && yearMatch?.[0] && Math.abs(parseInt(yearMatch?.[0], 10) - year) > 1) continue;

      return new URL(href);
    }

    return undefined;
  }

  /** On a series post, find the `/episode/<slug>-<S>x<E>/` link matching the requested episode. */
  private async findEpisode(ctx: Context, postUrl: URL, season: number | undefined, episode: number | undefined): Promise<URL | undefined> {
    if (season === undefined || episode === undefined) return undefined;
    let html: string;
    try {
      html = await this.fetcher.text(ctx, postUrl, { headers: { Referer: this.baseUrl } });
    } catch {
      return undefined;
    }

    const $ = cheerio.load(html);
    let found: URL | undefined;
    $('a').each((_, el) => {
      if (found) return;
      const href = $(el).attr('href') ?? '';
      if (!href.startsWith(`${this.baseUrl}/episode/`)) return;
      const slug = decodeURIComponent(href.replace(`${this.baseUrl}/episode/`, '').replace(/\/+$/, ''));
      const m = slug.match(/-(\d+)x(\d+)$/i);
      if (!m?.[1] || !m?.[2]) return;
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
  private async resolveVideoSource(ctx: Context, hash: string, playerBase: string): Promise<URL | undefined> {
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
      const data = JSON.parse(response) as { videoSource?: string };
      if (!data?.videoSource) return undefined;
      return new URL(data.videoSource);
    } catch {
      return undefined;
    }
  }

  /**
   * Build the playable URL: HLS via MediaFlow proxy (if configured), else the raw m3u8.
   * StreamResolver attaches proxyHeaders (Referer) from meta.referer so Stremio proxies it.
   */
  private buildStreamUrl(ctx: Context, m3u8Url: URL, playerHost: string): URL {
    if (supportsMediaFlowProxy(ctx)) {
      return buildMediaFlowProxyHlsUrl(ctx, m3u8Url, {
        Referer: `${playerHost}/`,
      }, true);
    }
    return m3u8Url;
  }
}
