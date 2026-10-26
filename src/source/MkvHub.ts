import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import { DEAD_HUBCLOUD_HOSTS, Fetcher, filterHubHosts, getTmdbId, getTmdbNameAndYear, HUB_HOST_PATTERN, Id } from '../utils';
import { Source, SourceResult } from './Source';

interface DownloadTarget {
  href: string;
  height: number;
  parsedBytes: number | undefined;
  label: string;
}

const SIZE_RE = /([\d.]+)\s*(GB|MB)/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;

// Hoster URL patterns backed by an extractor in this add-on's registry.
//   - hubcloud / hubdrive / hubcdn  → HubExtractor (seekable FSL/FSLv2)
//   - gdflix.*/file/                 → Gdflix extractor (Google video-downloads CDN)
//   - gofile.io/d/                   → GoFile extractor
//   - send.cm / send.now             → SendCm extractor
//   - pixeldrain.com                 → PixelDrain extractor
//   - mega.nz / mega.co.nz           → Mega extractor
const VALID_HOSTER_RE = /hubcdn|hubcloud|hubdrive|gdflix\.|gofile|send\.cm|sendcm|send\.now|pixeldrain|mega\.nz|mega\.co\.nz/i;

/** Parse "1080p – 2.5GB" → { height: 1080, parsedBytes: ... }. 4K/2160p → 2160. */
const parseQuality = (text: string): { height: number; parsedBytes: number | undefined } => {
  let height = 0;
  if (/2160p|4k/i.test(text)) height = 2160;
  else if (/1080p/i.test(text)) height = 1080;
  else if (/720p/i.test(text)) height = 720;
  else if (/480p/i.test(text)) height = 480;

  let parsedBytes: number | undefined;
  const sizeMatch = text.match(SIZE_RE);
  if (sizeMatch) {
    parsedBytes = bytes.parse(`${sizeMatch[1]} ${sizeMatch[2]}`) ?? undefined;
  }
  return { height, parsedBytes };
};

/** Parse "(Ep 01-04)" → { start: 1, end: 4 }; "(Ep 08)" → { start: 8, end: 8 };
 *  "S03E01" → { start: 1, end: 1 }. */
const parseEpisodeRange = (text: string): { start: number; end: number } | undefined => {
  // (Ep 01-04) or (Ep 08) format
  const rangeMatch = text.match(/Ep(?:isode)?\s*(\d{1,2})\s*[-\u2013\u2014]\s*(\d{1,2})/i);
  if (rangeMatch?.[1] && rangeMatch?.[2]) {
    return { start: parseInt(rangeMatch[1], 10), end: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = text.match(/Ep(?:isode)?\s*(\d{1,2})/i);
  if (singleMatch?.[1]) {
    const ep = parseInt(singleMatch[1], 10);
    return { start: ep, end: ep };
  }
  // S03E01 format (separate episode heading, e.g. "|| Download S03E01 via Single Links ||")
  const sxxEyyMatch = text.match(/S\d{1,2}E(\d{1,2})/i);
  if (sxxEyyMatch?.[1]) {
    const ep = parseInt(sxxEyyMatch[1], 10);
    return { start: ep, end: ep };
  }
  return undefined;
};

const cleanHeading = (text: string): string =>
  text.replace(/^\s*\|+\s*/, '').replace(/\s*\|+\s*$/, '').replace(/\s+/g, ' ').trim();

const hostLabel = (url: URL): string => {
  const host = url.hostname;
  if (/hubcdn|hubcloud|hubdrive/i.test(host)) return 'HubCloud';
  if (/gdflix/i.test(host)) return 'GDFlix';
  if (/gofile/i.test(host)) return 'GoFile';
  if (/send\.cm|sendcm|send\.now/i.test(host)) return 'SendCm';
  if (/pixeldrain/i.test(host)) return 'PixelDrain';
  if (/mega\./i.test(host)) return 'Mega';
  return host;
};

export class MkvHub extends Source {
  public readonly id = 'mkvhub';
  public readonly label = 'MkvHub';
  public readonly contentTypes: ContentType[] = ['movie', 'series'];
  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.hi];
  public readonly baseUrl = 'https://mkvhub.com';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  private clean(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private get logger() {
    return this.fetcher.getLogger();
  }

  protected async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    if (type !== 'movie' && type !== 'series') return [];

    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (!name) return [];

    const postUrl = await this.findPost(ctx, name, year, tmdbId.season);
    if (!postUrl) {
      this.logger.info(`MkvHub: no post matched TMDB "${name}" ${year ?? ''}`, ctx);
      return [];
    }

    const html = await this.fetcher.text(ctx, postUrl, { headers: { Referer: this.baseUrl } });
    const $ = cheerio.load(html);

    const isSeries = type === 'series' && !!tmdbId.season;
    const targets = this.collectLinks($, isSeries, tmdbId.episode);

    const results = (await Promise.all(
      targets
        .filter(t => t.height === 2160 || t.height === 1080 || t.height === 720)
        .map(async (target): Promise<SourceResult[]> => {
          const hosterUrls = await this.resolveShortLink(ctx, target.href, postUrl);
          return hosterUrls.map((hosterUrl) => {
            const meta: Meta = {
              countryCodes: this.countryCodes,
              height: target.height,
              title: `${cleanHeading(target.label)} \u2014 ${hostLabel(hosterUrl)}`,
              ...(target.parsedBytes && { bytes: target.parsedBytes }),
              sourceLabel: this.label,
            };
            return { url: hosterUrl, meta };
          });
        }),
    )).flat();

    // HubCloud mirrors only: this source's other hosters (gofile — premium-gated, send.now —
    // Turnstile-walled) never resolve for players and their extraction dragged the source past
    // the stream-response deadline, so MkvHub often missed the first response entirely.
    return filterHubHosts(results);
  }

  /**
   * Search the WP site and pick the post whose slug starts with the name, followed by a
   * year or season marker (filters out spinoffs like "stranger-things-tales-from-85").
   * Series: season must match the slug's S<n> marker. Movies: year ±1 if present in slug.
   */
  private async findPost(ctx: Context, name: string, year: number | undefined, season: number | undefined): Promise<URL | undefined> {
    const searchName = name.replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    const searchUrl = new URL(`/?s=${encodeURIComponent(searchName)}`, this.baseUrl);
    let html: string;
    try {
      html = await this.fetcher.text(ctx, searchUrl, { headers: { Referer: this.baseUrl } });
    } catch {
      return undefined;
    }

    const $ = cheerio.load(html);
    const nameClean = this.clean(name);
    const seasonRe = season ? new RegExp(`\\bs0?${season}\\b`, 'i') : undefined;

    // Post pages live on a rotating content mirror (currently mkvhub.loan)
    // while the search frontend is mkvhub.com — accept the whole host family.
    const postHostOk = (href: string): boolean =>
      href.startsWith(`${this.baseUrl}/`) || /^https?:\/\/[a-z0-9.-]*mkvhub\.[a-z.]+\//i.test(href);

    const candidates: { href: string; slug: string }[] = [];
    const seen = new Set<string>();
    $('a').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!postHostOk(href)) return;
      if (href.includes('/page/') || href.includes('/category/') || href.includes('/wp-') || href.endsWith('/feed/') || href.includes('/search/')) return;
      const slug = decodeURIComponent(href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/+$/, ''));
      if (!slug || slug.includes('.') || slug.includes('/')) return;
      if (seen.has(href)) return;
      seen.add(href);
      candidates.push({ href, slug });
    });

    for (const { href, slug } of candidates) {
      const slugClean = this.clean(slug);
      if (!slugClean.startsWith(nameClean)) continue;

      // Ensure title boundary: after the name, the slug should continue with a year (19xx/20xx)
      // or season marker (s0?N) — not another word (filters spinoffs).
      const afterName = slugClean.slice(nameClean.length);
      if (afterName.length > 0 && !/^(19|20)\d{2}|^s\d/.test(afterName)) continue;
      const yearMatch = slug.match(YEAR_RE);
      if (year && yearMatch) {
        // For series the slug year is the season's release year, not the show's first-air year,
        // so allow a wide range. For movies ±1 is standard.
        const maxDiff = season ? 15 : 1;
        if (Math.abs(parseInt(yearMatch[0], 10) - year) > maxDiff) continue;
      }

      if (seasonRe && !seasonRe.test(slug)) continue;

      return new URL(href);
    }

    return undefined;
  }

  /**
   * Walk headings (h2/h3/h4) and download buttons (a.dbuttn.blue) in document order.
   * Two heading patterns are supported:
   *  - **Combined** (ST S5 style): a single heading carries both episode + quality,
   *    e.g. "|| Download (Ep 08) 1080p – 2.5GB ||".
   *  - **Two-level** (HOTD S3 style): an episode heading "|| Download S03E01 via Single Links ||"
   *    is followed by separate quality sub-headings "|| Download 720p HD via Single Links Size: 595MB ||".
   *
   * Movies: every quality heading's download buttons are collected.
   * Series: zip packs are skipped (archives — Stremio can't play them); only headings whose
   * episode range includes the requested episode are kept.
   */
  private collectLinks($: cheerio.CheerioAPI, isSeries: boolean, episode: number | undefined): DownloadTarget[] {
    const links: DownloadTarget[] = [];
    let currentEpisode = '';
    let currentQuality = '';

    $('h2, h3, h4, a.dbuttn.blue').each((_, el) => {
      const $el = $(el);

      if (!$el.is('a')) {
        const text = $el.text().trim();
        const hasQuality = /\d{3,4}p|4k/i.test(text);
        const hasEpisode = !!parseEpisodeRange(text);

        if (hasQuality) {
          currentQuality = text;
          // Combined heading (ST S5 style): episode info is in the same heading
          if (hasEpisode) {
            currentEpisode = text;
          }
        } else if (hasEpisode) {
          // Separate episode heading (HOTD S3 style)
          currentEpisode = text;
        }
        return;
      }

      // Download button
      const href = $el.attr('href') ?? '';
      if (!href || !currentQuality) return;

      const { height, parsedBytes } = parseQuality(currentQuality);
      if (!height) return;

      if (isSeries) {
        if (/\bzip\b/i.test(currentQuality)) return;
        // Check episode from the current episode heading, or from the quality heading itself
        const epSource = currentEpisode || currentQuality;
        const epRange = parseEpisodeRange(epSource);
        if (!epRange || !episode || episode < epRange.start || episode > epRange.end) return;
      }

      links.push({ href, height, parsedBytes, label: currentQuality });
    });

    const seen = new Set<string>();
    return links.filter((l) => {
      if (seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    });
  }

  /**
   * Follow a linkszilla / linkomark short link and collect all supported hoster URLs
   * (HubCloud, GDFlix, GoFile, SendCm, PixelDrain, Mega). Each becomes a separate
   * SourceResult so the user gets multiple mirrors per quality.
   */
  private async resolveShortLink(ctx: Context, shortLinkUrl: string, postUrl: URL): Promise<URL[]> {
    let html: string;
    try {
      html = await this.fetcher.text(ctx, new URL(shortLinkUrl), { headers: { Referer: postUrl.href } });
    } catch (e) {
      this.logger.info(`MkvHub: short-link resolve failed for ${shortLinkUrl}: ${e instanceof Error ? e.message : String(e)}`, ctx);
      return [];
    }

    const $ = cheerio.load(html);
    const hosterUrls: URL[] = [];
    const seen = new Set<string>();

    $('a').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href || !VALID_HOSTER_RE.test(href)) return;
      try {
        const url = new URL(href);
        if (HUB_HOST_PATTERN.test(url.hostname) && DEAD_HUBCLOUD_HOSTS.has(url.hostname)) return;
        if (seen.has(url.href)) return;
        seen.add(url.href);
        hosterUrls.push(url);
      } catch {
        // skip invalid
      }
    });

    return hosterUrls;
  }
}
