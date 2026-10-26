import bytes from 'bytes';
import { ContentType } from 'stremio-addon-sdk';
import winston from 'winston';
import { Context, CountryCode, Meta } from '../types';
import { Fetcher, getClosestResolution, getTmdbId, getTmdbNameAndYear, Id } from '../utils';
import { Source, SourceResult } from './Source';

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

interface SearchResult {
  title: string;
  url: string;
  image?: string;
}

interface QualityItem {
  title: string;
  url: string;
  episodesUrl: string;
  batchUrl: string;
  quality: string;
}

interface EpisodeItem {
  title: string;
  link: string;
}

interface QualityResponse {
  sourceQualityList: QualityItem[];
  meta?: {
    imdbId?: string;
    type?: string;
    mainTitle?: string;
    title?: string;
  };
}

interface SourceUrlResponse {
  sourceUrl: string;
}

const SIZE_RE = /\[?\s*([\d.]+)\s*(GB|MB)\s*\]?/i;
const YEAR_RE = /\b(19[89]\d|20\d{2})\b/;
const SEASON_RE = /season\s*(\d+)/i;

const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const parseHeight = (text: string): number => {
  if (/2160p|4k/i.test(text)) return 2160;
  if (/1080p/i.test(text)) return 1080;
  if (/720p/i.test(text)) return 720;
  if (/480p/i.test(text)) return 480;
  return 0;
};

const parseSize = (text: string): number | undefined => {
  const m = text.match(SIZE_RE);
  if (!m) return undefined;
  return bytes.parse(`${m[1]} ${m[2]}`) ?? undefined;
};

export class AcerMovies extends Source {
  public readonly id = 'acermovies';
  public readonly label = 'AcerMovies';
  public readonly contentTypes: ContentType[] = ['movie', 'series'];
  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.hi, CountryCode.en];
  public readonly baseUrl = 'https://acermovies.fun';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  private get logger(): winston.Logger {
    return this.fetcher.getLogger();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async postJson(ctx: Context, path: string, body: Record<string, unknown>): Promise<any> {
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

  protected async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    if (type !== 'movie' && type !== 'series') return [];

    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (!name) return [];

    let searchRes: { searchResult?: SearchResult[] };
    try {
      searchRes = await this.postJson(ctx, '/api/search', { searchQuery: name });
    } catch (e) {
      this.logger.info(`AcerMovies: search failed: ${e instanceof Error ? e.message : e}`, ctx);
      return [];
    }

    const results = searchRes.searchResult ?? [];
    if (!results.length) {
      this.logger.info(`AcerMovies: no search results for "${name}"`, ctx);
      return [];
    }

    const target = clean(name);
    const yearOf = (r: SearchResult): number | undefined => {
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

    let qualityRes: QualityResponse;
    try {
      qualityRes = await this.postJson(ctx, '/api/sourceQuality', { url: matched.url });
    } catch (e) {
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
  private async postWithRetry(ctx: Context, path: string, body: Record<string, unknown>): Promise<any> {
    try {
      return await this.postJson(ctx, path, body);
    } catch {
      await new Promise((res) => setTimeout(res, 1200));
      return this.postJson(ctx, path, body);
    }
  }

  private async handleMovie(ctx: Context, qualityList: QualityItem[]): Promise<SourceResult[]> {
    const results: SourceResult[] = [];
    const seenHeights = new Set<number>();
    const filtered = qualityList.filter((q) => {
      const h = parseHeight(q.title);
      if (h !== 720 && h !== 1080) return false;
      if (seenHeights.has(h)) return false;
      seenHeights.add(h);
      return true;
    });

    const resolved = await Promise.allSettled(
      filtered.map(q => this.postWithRetry(ctx, '/api/sourceUrl', { url: q.url, seriesType: 'movie' })),
    );

    for (let i = 0; i < filtered.length; i++) {
      const q = filtered[i];
      if (!q) continue;
      const r = resolved[i];
      if (!r || r.status !== 'fulfilled') continue;

      const sourceUrl = (r.value as SourceUrlResponse).sourceUrl;
      if (!sourceUrl) continue;

      const height = parseHeight(q.title);
      const sizeBytes = parseSize(q.title);
      const fileLabel = q.title.replace(/\s*\[.*?\]\s*/g, ' ').trim();

      const relayUrl = new URL('/relay/movie.mkv', ctx.hostUrl);
      relayUrl.searchParams.set('url', sourceUrl);

      const resBadge = height ? getClosestResolution(height) : 'Unknown';
      const sizeBadge = sizeBytes ? `⬇️ ${(sizeBytes / 1e9).toFixed(1)} GB` : '';

      const meta: Meta = {
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

  private async handleSeries(
    ctx: Context,
    qualityList: QualityItem[],
    season: number,
    episode: number,
  ): Promise<SourceResult[]> {
    const seasonItems = qualityList.filter((q) => {
      const sMatch = q.title.match(SEASON_RE);
      if (!sMatch?.[1] || parseInt(sMatch[1], 10) !== season) return false;
      const h = parseHeight(q.title);
      return h === 720 || h === 1080;
    });

    if (!seasonItems.length) {
      this.logger.info(`AcerMovies: no quality items for S${season}`, ctx);
      return [];
    }

    const episodeResponses = await Promise.allSettled(
      seasonItems.map(q => this.postWithRetry(ctx, '/api/sourceEpisodes', { url: q.episodesUrl })),
    );

    const results: SourceResult[] = [];

    for (let i = 0; i < seasonItems.length; i++) {
      const q = seasonItems[i];
      if (!q) continue;
      const r = episodeResponses[i];
      if (!r || r.status !== 'fulfilled') continue;

      const episodes: EpisodeItem[] = r.value?.sourceEpisodes ?? [];
      const epItem = episodes.find((e) => {
        const m = e.title.match(/episode\s*(\d+)/i);
        return m?.[1] && parseInt(m[1], 10) === episode;
      });

      if (!epItem || !epItem.link) continue;

      const height = parseHeight(q.title);
      const sizeBytes = parseSize(q.title);
      const fileLabel = q.title.replace(/\s*\[.*?\]\s*/g, ' ').trim();

      const sidUrl = new URL(epItem.link);

      const resBadge = height ? getClosestResolution(height) : 'Unknown';
      const sizeBadge = sizeBytes ? `⬇️ ${(sizeBytes / 1e9).toFixed(1)} GB` : '';

      const meta: Meta = {
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
