import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import { Fetcher, getTmdbId, getTmdbNameAndYear, Id } from '../utils';
import { Source, SourceResult } from './Source';

interface DownloadLink {
  href: string;
  height: number;
  bytes: number | undefined;
  label: string;
}

const SIZE_RE = /([\d.]+)\s*(GB|MB)/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
// Short-link portals that list per-quality hosters (movies) or per-episode hosters (series).
// The portal rotates TLDs (linkos.site → linkos.club, 2026) — accept the family.
const SHORT_LINK_RE = /linkos\.(?:site|club)|epios\.(?:site|club)/i;
// MultiCloud is the only hoster on these portals that renders server-side and exposes a direct,
// Range-enabled .mkv (verified: HTTP 206 + Accept-Ranges: bytes) — seekable & resumable in Stremio.
const MULTICLOUD_VIEW_RE = /multicloudlinks\.com\/view\//i;
const DIRECT_FILE_RE = /\.(mkv|mp4|webm)$/i;
// MultiCloud "Turbo Download" CDN. Serves the real MKV (incl. 1080p/4K) via plain GET, but is
// referer-locked to the MultiCloud view page (403 otherwise) and tokenized (~5.5h validity).
// Does NOT honour Range (500) — routed through /relay (plain-GET + local-slice profile).
const DR1_RE = /multidownload\.shop\/d\//i;
// GoFile hoster (`gofile.io/d/<id>`) — handed to the GoFile extractor, which resolves it to a
// Range-enabled CDN URL (fast, seekable & resumable). Present on most MultiCloud view pages
// alongside dr1; preferred over dr1's no-Range relay when the stable bdl1 direct mirror is absent.
const GOFILE_RE = /gofile\.io\/d\//i;
// GDFlix hoster (`gdflix.dev/file/<id>`) — listed on linkos pages alongside MultiCloud. Resolved by
// the GDFlix extractor to a Google video-downloads CDN URL (fast, no-Range → relay). Used as the
// 4K fallback: the 4K MultiCloud view page renders a JS "Generating Secure Links…" loader with no
// server-side hoster anchors, so resolveMultiCloud returns [] and the GDFlix hoster is used instead.
const GDFLIX_RE = /gdflix\.[a-z]+\/file\//i;

/** Parse "Dunkirk 2017 [Hindi-English] HDRip 720p AAC ESub [800Mb]" → { height: 720, bytes: ... }. */
const parseQuality = (text: string): { height: number; bytes: number | undefined } => {
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
  return { height, bytes: parsedBytes };
};

export class WorldFree4u extends Source {
  public readonly id = 'worldfree4u';
  public readonly label = 'WorldFree4u';
  public readonly contentTypes: ContentType[] = ['movie', 'series'];
  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.hi];
  public readonly baseUrl = 'https://worldfree4u.capetown';
  // dr1 "Turbo" download tokens are regenerated per MultiCloud page load and valid ~5.5h. Keep
  // cached results well inside that window so a cached /relay URL never carries an expired token.
  public override readonly ttl = 3600000; // 1h

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public override async prewarm(ctx: Context): Promise<void> {
    try {
      await this.fetcher.text(ctx, new URL(this.baseUrl));
      this.fetcher.getLogger().info('WorldFree4u: pre-warm complete', ctx);
    } catch (error) {
      this.fetcher.getLogger().warn(`WorldFree4u: pre-warm failed: ${error}`, ctx);
    }
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
      this.logger.info(`WorldFree4u: no post matched TMDB "${name}" ${year ?? ''}`, ctx);
      return [];
    }

    const html = await this.fetcher.text(ctx, postUrl, { headers: { Referer: this.baseUrl } });
    const $ = cheerio.load(html);

    const targets = this.collectQualityLinks($);

    const results: SourceResult[] = [];
    for (const target of targets) {
      // 4K (2160p) + 1080p + 720p only; 480p dropped (matching SSRmovies). Users can still exclude a
      // resolution via the add-on's "Exclude resolution" config (StreamResolver honours it downstream).
      if (target.height !== 2160 && target.height !== 1080 && target.height !== 720) continue;

      // A quality may resolve to more than one hoster URL (e.g. GoFile + dr1). Returning both lets
      // the always-alive dr1 relay floor a quality when the faster GoFile CDN is unreachable, so a
      // dead GoFile extraction never loses the whole quality.
      const fileUrls = tmdbId.season
        ? await this.resolveEpisode(ctx, target.href, postUrl, tmdbId.episode)
        : await this.resolveMovie(ctx, target.href, postUrl);

      const meta: Meta = {
        countryCodes: this.countryCodes,
        height: target.height,
        title: target.label,
        ...(target.bytes && { bytes: target.bytes }),
        sourceLabel: this.label,
      };

      for (const fileUrl of fileUrls) {
        results.push({ url: fileUrl, meta });
      }
    }

    return results;
  }

  /**
   * Search the WP site and pick the post whose URL slug starts with the name + matches the year (+ season).
   *
   * Matching uses the slug (e.g. "dunkirk-2017") rather than the card's visible text: each card's
   * `<a>` text begins with a rotated year badge ("2017") before the title, so a `startsWith` check on
   * the text would never match. The slug is clean and also discriminates "dunkirk-2017" from
   * "operation-dunkirk-2017" (whose slug starts with "operation-"). Year/season are verified against
   * the combined slug + card text.
   */
  private async findPost(ctx: Context, name: string, year: number | undefined, season: number | undefined): Promise<URL | undefined> {
    // WordPress search returns "no results" when the query carries punctuation such as the subtitle
    // colon in "Avatar: Fire and Ash" (the post exists as slug "avatar-fire-and-ash-2025" but the
    // colon makes WP match nothing). Strip everything but letters/digits/spaces before searching.
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
    const seasonRe = season ? new RegExp(`\\bS0?${season}\\b|\\bSeason\\s+${season}\\b`, 'i') : undefined;

    const candidates: { href: string; slug: string; text: string }[] = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href.startsWith(`${this.baseUrl}/`)) return;
      if (href.includes('/page/') || href.includes('/category/') || href.includes('/wp-') || href.endsWith('/feed/') || href.includes('/search/')) return;
      const slug = decodeURIComponent(href.replace(`${this.baseUrl}/`, '').replace(/\/+$/, ''));
      // Skip non-post links: empty slugs, sitemaps/files, or multi-segment taxonomy paths.
      if (!slug || slug.includes('.') || slug.includes('/')) return;
      candidates.push({ href, slug, text: $(el).text() });
    });

    for (const { href, slug, text } of candidates) {
      if (!this.clean(slug).startsWith(nameClean)) continue;

      const matchText = `${slug} ${text}`;
      const yearMatch = matchText.match(YEAR_RE);
      if (year && yearMatch) {
        if (Math.abs(parseInt(yearMatch[0], 10) - year) > 1) continue;
      }

      if (seasonRe && !seasonRe.test(matchText)) continue;

      return new URL(href);
    }

    return undefined;
  }

  /**
   * Post page: each quality has a heading `<h4>...720p...[800Mb]</h4>` immediately followed by
   * `<h4><a class="dl" href="linkos.site/...">Download Links</a></h4>` (movies → linkos, series → epios).
   * Pair each `a.dl` with its nearest preceding `<h4>` to read quality + size.
   */
  private collectQualityLinks($: cheerio.CheerioAPI): DownloadLink[] {
    const links: DownloadLink[] = [];
    $('a.dl').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href || !SHORT_LINK_RE.test(href)) return;
      const linkH4 = $(el).closest('h4');

      // First try direct prev siblings; if none found, step up one container and try again.
      // HOTD S2 wraps the "Download Links" h4 in a div, so its quality h4 is a prev-sibling
      // of that div rather than of the h4 itself.
      let prevH4 = linkH4.prevAll('h4').first();
      if (!prevH4.length) {
        prevH4 = linkH4.parent().prevAll('h4').first();
      }

      const text = (prevH4.length ? prevH4.text() : linkH4.text()).trim() || $(el).text().trim();
      const { height, bytes } = parseQuality(text);
      links.push({ href, height, bytes, label: text });
    });
    return links;
  }

  /** Movie: linkos.site lists hosters — pick the MultiCloud view link, then resolve to direct file URL(s). */
  private async resolveMovie(ctx: Context, shortUrl: string, postUrl: URL): Promise<URL[]> {
    let html: string;
    try {
      html = await this.fetcher.text(ctx, new URL(shortUrl), { headers: { Referer: postUrl.href } });
    } catch (e) {
      this.logger.info(`WorldFree4u: linkos resolve failed for ${shortUrl}: ${e instanceof Error ? e.message : String(e)}`, ctx);
      return [];
    }

    const $ = cheerio.load(html);
    // 2026: the portal dropped MultiCloud entirely — GoFile is now the primary
    // server-side hoster on linkos pages (resolved by the GoFile extractor).
    const gofile = this.firstHref($, GOFILE_RE);
    if (gofile) return [gofile];

    const multiUrl = this.firstHref($, MULTICLOUD_VIEW_RE);
    if (multiUrl) {
      const urls = await this.resolveMultiCloud(ctx, multiUrl, postUrl);
      if (urls.length) return urls;
    }
    // MultiCloud yielded nothing (e.g. the 4K view page renders a JS loader with no server-side
    // hoster anchors). Fall back to the linkos page's GDFlix hoster — the GDFlix extractor resolves
    // it to a Google video-downloads CDN URL (relayed, no-Range plain-GET slice).
    const gdflix = this.firstHref($, GDFLIX_RE);
    if (gdflix) this.logger.info(`WorldFree4u: MultiCloud empty, falling back to GDFlix for ${shortUrl}`, ctx);
    return gdflix ? [gdflix] : [];
  }

  /** Series: epios.site lists episodes grouped by hoster — find the MultiCloud link for the requested episode. */
  private async resolveEpisode(ctx: Context, epiosUrl: string, postUrl: URL, episode: number | undefined): Promise<URL[]> {
    if (!episode) return [];
    let html: string;
    try {
      html = await this.fetcher.text(ctx, new URL(epiosUrl), { headers: { Referer: postUrl.href } });
    } catch (e) {
      this.logger.info(`WorldFree4u: epios resolve failed for ${epiosUrl}: ${e instanceof Error ? e.message : String(e)}`, ctx);
      return [];
    }

    const $ = cheerio.load(html);
    const epRe = new RegExp(`\\bEpisode\\s+${episode}\\b`, 'i');
    let multiUrl: URL | undefined;
    $('a').each((_, el) => {
      if (multiUrl) return;
      const href = $(el).attr('href') ?? '';
      if (!MULTICLOUD_VIEW_RE.test(href)) return;
      if (epRe.test($(el).text())) {
        try {
          multiUrl = new URL(href);
        } catch {
          // skip invalid
        }
      }
    });
    if (!multiUrl) return [];
    return this.resolveMultiCloud(ctx, multiUrl, postUrl);
  }

  /**
   * MultiCloud view page resolution.
   *
   * Three hosters are recognised:
   *  1. `bdl1.multicloudlinks.com/<file>.mkv` ("Direct Download") — stable, no token, Range-enabled.
   *     Served inline (no relay, no referer). Only mirrors smaller qualities (e.g. 720p). When
   *     present it is the best single mirror of the file → returned alone.
   *  2. `gofile.io/d/<id>` ("GoFile") — handed to the GoFile extractor, which resolves it to a
   *     Range-enabled CDN URL (fast, seekable & resumable). Covers 1080p/4K (and 720p when bdl1 is
   *     absent) without dr1's no-Range caveat. Only present on some pages.
   *  3. `dr1.multidownload.shop/d/<code>?exp=…&token=…` ("Turbo Download") — serves the real MKV
   *     (incl. 1080p/4K) via a plain GET, but is referer-locked to this view page (403 without the
   *     referer) and carries a short-lived token. It does NOT honour Range (500), so it is routed
   *     through the addon's /relay (plain-GET + local-slice profile) → playable via Stremio's
   *     streaming server (ffmpeg), but seeking is slow. Present on every page.
   *
   * When bdl1 is absent, **both** GoFile and dr1 are returned (GoFile first). dr1 is the
   * always-alive floor: the GoFile CDN can be unreachable from some networks (its `api.gofile.io`
   * lookup then yields nothing and that stream drops), so returning dr1 alongside guarantees the
   * quality still resolves — and when GoFile IS reachable the user gets the fast, seekable stream.
   */
  private async resolveMultiCloud(ctx: Context, viewUrl: URL, postUrl: URL): Promise<URL[]> {
    let html: string;
    try {
      html = await this.fetcher.text(ctx, viewUrl, { headers: { Referer: postUrl.href } });
    } catch (e) {
      this.logger.info(`WorldFree4u: multicloud resolve failed for ${viewUrl.href}: ${e instanceof Error ? e.message : String(e)}`, ctx);
      return [];
    }

    const $ = cheerio.load(html);

    // 1. bdl1 direct .mkv (inline, no relay, Range-enabled) — best mirror of the file; return alone.
    const direct = this.firstHref($, DIRECT_FILE_RE);
    if (direct) return [direct];

    // 2 + 3. GoFile (fast Range CDN) + dr1 (always-alive relay floor). Return both so a quality is
    //        never lost when the GoFile CDN is unreachable; GoFile wins when it is.
    const urls: URL[] = [];
    const gofile = this.firstHref($, GOFILE_RE);
    if (gofile) urls.push(gofile);
    const turbo = this.firstHref($, DR1_RE);
    if (turbo) {
      const relay = new URL('/relay', ctx.hostUrl);
      relay.searchParams.set('url', turbo.href);
      relay.searchParams.set('referer', viewUrl.href);
      urls.push(relay);
    }
    return urls;
  }

  /** First `<a href>` on the page matching `re`, parsed to a URL. */
  private firstHref($: cheerio.CheerioAPI, re: RegExp): URL | undefined {
    let found: URL | undefined;
    $('a').each((_, el) => {
      if (found) return;
      const href = $(el).attr('href') ?? '';
      if (re.test(href)) {
        try {
          found = new URL(href);
        } catch {
          // skip invalid
        }
      }
    });
    return found;
  }
}
