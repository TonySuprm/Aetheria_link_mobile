import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { CheerioAPI } from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import { Fetcher, getTmdbId, getTmdbNameAndYear, Id } from '../utils';
import { Source, SourceResult } from './Source';

// UHDMovies (uhdmovies.casa) — WordPress Hindi/English movie & series site. Searches `?s=<name>`,
// matches a post by cleaned-title + year (±1), then collects the per-quality "Download (G-Drive)"
// SID links (`cloud.unblockedgames.world/?sid=<base64>`). Each SID link is returned as a
// SourceResult; the UHDMovies extractor resolves it (SID → driveleech → file page → Google-Drive
// direct URL) lazily at play time. Ported from the project's uhdmovies.js reference.
//
// Search results: `article.gridlove-post` cards, each with an `a[href*="/download-"]` (title in the
// `title` attr / inner `h1.sanket`). Download page: quality headers in `<p>`/`<strong>` (e.g.
// "1080p x264 UHD", "4k 2160p SDR") followed by `maxbutton`/`<a>` anchors pointing to the SID link.
// Series: scoped within a "SEASON N" block, episode links matched by `Episode <N>` text.

interface SidLink {
  url: URL;
  height: number;
  bytes: number | undefined;
  label: string;
}

const SIZE_RE = /\[?\s*([\d.]+)\s*(GB|MB)\s*\]?/i;
const YEAR_RE = /\b(19[89]\d|20\d{2})\b/g;
const YEAR_RANGE_RE = /\((\d{4})\s*-\s*(\d{4})\)/;
const SID_HOST = 'thenaukriadda.in';

const clean = (str: string): string => str.toLowerCase().replace(/\s*&\s*/g, 'and').replace(/[^a-z0-9]/g, '');

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

// Reject spinoff/collection noise the search returns alongside the real title.
const SPINOFF_KEYWORDS = ['challenge', 'conversation', 'story', 'inconversation'];

// Match a search result against the wanted title + year. Mirrors the reference's compareMedia:
//   1. Title: cleaned result must contain cleaned wanted (result is always longer — "Download ..."
//      prefix + quality specs). Falls back to collection (duology/trilogy/…) containing the main
//      title segment (before "and"). No length-ratio guard — it rejects short names like "Dune".
//   2. Spinoff rejection: "challenge"/"conversation"/"story" in result but not in wanted title.
//   3. Year: if the result contains ANY year, at least one must match ±1 (or fall in a year range).
const compareMedia = (resultTitle: string, wantedTitle: string, year: number | undefined, type: ContentType): boolean => {
  const normalizedResult = clean(resultTitle);
  const normalizedWanted = clean(wantedTitle);

  if (normalizedWanted.length < 3 || !normalizedResult.includes(normalizedWanted)) {
    const mainTitle = normalizedWanted.split('and')[0] ?? '';
    const isCollection = /duology|trilogy|quadrilogy|collection|saga/.test(normalizedResult);
    if (!(isCollection && mainTitle.length >= 3 && normalizedResult.includes(mainTitle))) {
      return false;
    }
  }

  const wantedLower = wantedTitle.toLowerCase();
  if (SPINOFF_KEYWORDS.some(kw => normalizedResult.includes(clean(kw)) && !wantedLower.includes(kw))) {
    return false;
  }

  if (year) {
    const years = (resultTitle.match(YEAR_RE) ?? []).map(y => parseInt(y, 10));
    const rangeMatch = resultTitle.match(YEAR_RANGE_RE);
    let hasMatchingYear = years.some(y => Math.abs(y - year) <= 1);
    if (!hasMatchingYear && rangeMatch) {
      const start = parseInt(rangeMatch[1] ?? '0', 10);
      const end = parseInt(rangeMatch[2] ?? '0', 10);
      hasMatchingYear = year >= start - 1 && year <= end + 1;
    }
    if ((years.length > 0 || rangeMatch) && !hasMatchingYear) return false;
  }

  if (type === 'movie' && /season\s+\d/i.test(resultTitle)) {
    return false;
  }

  return true;
};

export class UHDMovies extends Source {
  public readonly id = 'uhdmovies';
  public readonly label = 'UHDMovies';
  public readonly contentTypes: ContentType[] = ['movie', 'series'];
  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.hi, CountryCode.en];
  public readonly baseUrl = 'https://uhdmovies.us.org';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public override async prewarm(ctx: Context): Promise<void> {
    try {
      await this.fetcher.text(ctx, new URL(this.baseUrl));
      this.fetcher.getLogger().info('UHDMovies: pre-warm complete', ctx);
    } catch (error) {
      this.fetcher.getLogger().warn(`UHDMovies: pre-warm failed: ${error}`, ctx);
    }
  }

  private get logger() {
    return this.fetcher.getLogger();
  }

  protected async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    if (type !== 'movie' && type !== 'series') return [];

    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (!name) return [];

    const postUrl = await this.findPost(ctx, name, year, type);
    if (!postUrl) {
      this.logger.info(`UHDMovies: no post matched TMDB "${name}" ${year ?? ''}`, ctx);
      return [];
    }

    const html = await this.fetcher.text(ctx, postUrl, { headers: { Referer: this.baseUrl } });
    const $ = cheerio.load(html);

    const sidLinks = type === 'series'
      ? this.collectSeriesLinks($, tmdbId.season ?? 1, tmdbId.episode ?? 1)
      : this.collectMovieLinks($);

    const results: SourceResult[] = [];
    for (const link of sidLinks) {
      // 4K + 1080p + 720p only (480p dropped, matching sibling sources).
      if (link.height !== 2160 && link.height !== 1080 && link.height !== 720) continue;

      const meta: Meta = {
        countryCodes: this.countryCodes,
        height: link.height,
        title: link.label,
        sourceLabel: this.label,
        ...(link.bytes && { bytes: link.bytes }),
        ...(type === 'series' && { season: tmdbId.season, episode: tmdbId.episode }),
      };

      results.push({ url: link.url, meta });
    }

    return results;
  }

  /** Search the WP site and pick the post whose slug/text matches the name + year. */
  private async findPost(ctx: Context, name: string, year: number | undefined, type: ContentType): Promise<URL | undefined> {
    const searchName = name.replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    const searchUrl = new URL(`/?s=${encodeURIComponent(searchName)}`, this.baseUrl);
    let html: string;
    try {
      html = await this.fetcher.text(ctx, searchUrl, { headers: { Referer: this.baseUrl } });
    } catch {
      return undefined;
    }

    const $ = cheerio.load(html);
    const candidates: { href: string; title: string }[] = [];

    $('article.gridlove-post, article').each((_, el) => {
      const $el = $(el);
      const anchor = $el.find('a[href*="/download-"]').first();
      const href = anchor.attr('href') ?? '';
      if (!href) return;
      const title = (anchor.attr('title') || $el.find('h1.sanket, h2, h3').first().text() || anchor.text()).trim();
      if (!title) return;
      candidates.push({ href: href.startsWith('http') ? href : `${this.baseUrl}${href}`, title });
    });

    // Fallback: any /download- link if the grid cards didn't render.
    if (candidates.length === 0) {
      $('a[href*="/download-"]').each((_, el) => {
        const href = $(el).attr('href') ?? '';
        const title = $(el).attr('title') || $(el).text().trim();
        if (href && title) candidates.push({ href: href.startsWith('http') ? href : `${this.baseUrl}${href}`, title });
      });
    }

    for (const { href, title } of candidates) {
      if (compareMedia(title, name, year, type)) return new URL(href);
    }

    return undefined;
  }

  /** Movie page: walk .entry-content, track the last quality header, attach the next SID link.
   *  Inline SID links inside <strong> (G-Drive section) are skipped — they resolve to a broken
   *  uhdmovies.mov "Coming Soon" challenge page. Only standalone "Download (G-Drive)" maxbutton
   *  anchors (outside <strong>) are collected; they resolve to driveseed.org (working). */
  private collectMovieLinks($: CheerioAPI): SidLink[] {
    const links: SidLink[] = [];
    let lastQuality = '';
    let lastSize = '';
    const seen = new Set<string>();

    $('.entry-content').find('*').each((_, el) => {
      const $el = $(el);
      const tag = el.tagName;
      const text = $el.text().trim().replace(/\s+/g, ' ');

      // Quality header: p/strong/h with a resolution marker. Always sets lastQuality for the
      // next SID anchor — never pushes a SID directly from inside a header element.
      if (/^(p|strong|h[2-4])$/.test(tag) && /2160p|1080p|720p|4k|hevc|x265|x264|60fps/i.test(text) && text.length < 140) {
        lastQuality = text;
        lastSize = '';
        return;
      }

      // Size is sometimes on a separate line/element below the quality header; capture it so
      // it can be paired with the next SID anchor even when the quality header itself has no
      // size bracket.
      if (/^(p|strong|h[2-4])$/.test(tag) && /size|\[?\s*[\d.]+\s*(GB|MB|TB)\s*\]?/i.test(text) && text.length < 80) {
        lastSize = text;
        return;
      }

      // Direct SID link anchor — only collect "Download (G-Drive)" maxbutton anchors (class
      // contains "maxbutton"). Inline G-Drive section links (no class, short quality text like
      // "2160p UHD" / "HEVC" / "UHDMOVIES") are skipped — they resolve to a broken uhdmovies.mov
      // "Coming Soon" page. The working maxbutton anchors resolve to driveseed.org.
      const href = $el.attr('href') ?? '';
      if (href.includes(SID_HOST) && href.includes('sid=') && ($el.attr('class') ?? '').includes('maxbutton')) {
        this.pushSid(links, seen, href, lastQuality, lastSize);
      }
    });

    return this.deduplicateSidLinks(links);
  }

  /** Series page: scope within the "SEASON N" block, match the episode link by `Episode <N>`. */
  private collectSeriesLinks($: CheerioAPI, season: number, episode: number): SidLink[] {
    const links: SidLink[] = [];
    const seen = new Set<string>();
    // Default true: single-season posts (e.g. "FROM (2022) Season 04") have no "SEASON N" header —
    // the entire page IS the requested season. Multi-season posts set inSeason explicitly via their
    // "SEASON N" headers, overriding this default.
    let inSeason = true;
    let lastQuality = '';
    let lastSize = '';
    const epRegex = new RegExp(`^Episode\\s+0*${episode}(?!\\d)`, 'i');

    $('.entry-content').find('*').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim().replace(/\s+/g, ' ');
      const seasonMatch = text.match(/^SEASON\s+(\d+)/i);

      if (seasonMatch) {
        inSeason = parseInt(seasonMatch[1] ?? '0', 10) === season;
        return;
      }
      if (!inSeason) return;

      // Track quality headers within the season block.
      if (/^(p|strong|h[2-4])$/.test(el.tagName) && /2160p|1080p|720p|4k|hevc|x265|x264/i.test(text) && text.length < 140) {
        lastQuality = text;
        lastSize = '';
        return;
      }

      // Capture size when it sits on its own element near the quality header.
      if (/^(p|strong|h[2-4])$/.test(el.tagName) && /size|\[?\s*[\d.]+\s*(GB|MB|TB)\s*\]?/i.test(text) && text.length < 80) {
        lastSize = text;
        return;
      }

      // Episode link: maxbutton-gdrive-episode (.mb-text) or a SID anchor whose text matches "Episode N".
      const sidAnchor = $el.is('a') && $el.attr('href')?.includes(SID_HOST)
        ? $el
        : $el.find(`a[href*="${SID_HOST}"]`).first();
      const href = sidAnchor.attr('href') ?? '';
      if (href.includes(SID_HOST) && href.includes('sid=') && (sidAnchor.attr('class') ?? '').includes('maxbutton')) {
        const epText = sidAnchor.find('.mb-text').text().trim() || sidAnchor.text().trim();
        if (epRegex.test(epText)) {
          this.pushSid(links, seen, href, lastQuality || epText, lastSize);
        }
      }
    });

    return this.deduplicateSidLinks(links);
  }

  private pushSid(links: SidLink[], seen: Set<string>, href: string, qualityText: string, sizeText = ''): void {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const height = parseHeight(qualityText);
    if (!height) return;
    const combinedText = `${qualityText} ${sizeText}`.trim();
    const label = `${this.label} ${qualityText.replace(/\s+/g, ' ').trim()}`.slice(0, 120);
    links.push({ url, height, bytes: parseSize(combinedText) ?? parseSize(sizeText), label });
  }

  /** Collapse duplicate SID links that point to the same quality/size encode (e.g. multiple
   *  "Download (G-Drive)" buttons for the same file). The first occurrence wins. */
  private deduplicateSidLinks(links: SidLink[]): SidLink[] {
    const seen = new Map<string, SidLink>();
    links.forEach((link) => {
      const key = `${link.height}|${link.bytes ?? ''}|${link.label}`;
      if (!seen.has(key)) seen.set(key, link);
    });
    return Array.from(seen.values());
  }
}
