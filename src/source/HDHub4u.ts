import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { CheerioAPI } from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import { DEAD_HUBCLOUD_HOSTS, Fetcher, filterHubHosts, findCountryCodes, findHeight, getImdbId, getTmdbId, getTmdbNameAndYear, HUB_HOST_PATTERN, Id, ImdbId } from '../utils';
import { resolveRedirectUrl } from './hd-hub-helper';
import { Source, SourceResult } from './Source';

interface CdnHostResponse {
  h?: string;
  c?: string;
  t?: number;
}

interface SearchResponsePartial {
  hits: {
    document: {
      imdb_id: string;
      permalink: string;
      post_title: string;
    };
  }[];
}

const CDN_HOST_URL = 'https://cdn.hdhub4u.glass/host/';
const CDN_HOST_TTL = 4 * 60 * 60 * 1000;

let cdnDiscoveredUrl: string | null = null;
let cdnDiscoveryTs = 0;
let cdnVerifiedAliveAt = 0;
export const CDN_VERIFY_INTERVAL = 5 * 60 * 1000;

export function resetCdnCache(): string | undefined {
  let evictedHost: string | undefined;
  if (cdnDiscoveredUrl) {
    try {
      evictedHost = new URL(cdnDiscoveredUrl).hostname;
    } catch { /* invalid CDN URL */ }
  }
  cdnDiscoveredUrl = null;
  cdnDiscoveryTs = 0;
  cdnVerifiedAliveAt = 0;
  return evictedHost;
}

Source.evictionCallbacks.set('hdhub', resetCdnCache);

const EXCLUDED_HREF_PATTERNS = ['gadgetsweb', '4khdhub', 'linksly', 'shareus', 'dood', 'desiupload', 'megaup', 'filepress', 'mediashore', 'ninjastream', 'hubstream'];

const SIZE_RE = /\[?\s*([\d.]+)\s*(TB|GB|MB|KB)\s*\]?/i;

/** Parse a file size (e.g. "[800mb]", "1.8GB", "24.8GB") from link text into bytes. */
const parseSizeBytes = (text: string): number | undefined => {
  const m = text.match(SIZE_RE);
  if (!m) return undefined;
  return bytes.parse(`${m[1]} ${m[2]}`) ?? undefined;
};

/** Extract per-link quality metadata (height + file size) from anchor text.
 *  Prefers quality found in the link text over a caller-provided meta (e.g. from a
 *  gadgetsweb "480p Pack" label), falling back to meta when the text has none. */
const extractLinkMeta = (text: string, meta: Meta): Meta => {
  const textHeight = findHeight(text);
  const height = textHeight ?? meta.height;
  const textBytes = parseSizeBytes(text);
  const linkBytes = textBytes ?? meta.bytes;
  return {
    ...meta,
    ...(height !== undefined && { height }),
    ...(linkBytes !== undefined && { bytes: linkBytes }),
  };
};

/** Decode the base64 `q` param HDHub4u embeds in HubCloud search-recover URLs. It carries the
 *  file name, episode number and quality — e.g. "Stranger Things S05 Episode 5 720p" — which is
 *  far richer than the bare "Drive"/"Instant" anchor text, so it makes the best stream-card title. */
const decodeHubTitle = (url: URL): string | undefined => {
  const q = url.searchParams.get('q');
  if (!q) return undefined;
  try {
    const decoded = Buffer.from(q, 'base64').toString('utf8').trim();
    return decoded || undefined;
  } catch { /* invalid base64 */ }
  return undefined;
};

/** Map a pixel height to a compact quality label for constructed titles. */
const heightLabel = (height: number | undefined): string | undefined => {
  if (!height) return undefined;
  if (height >= 2160) return '4K';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  return '480p';
};

/** Clean anchor/heading text into a readable title: drop size brackets (the 💾 line already shows
 *  size), lightning bolts and generic mirror button labels ("Drive", "Instant", "Watch") so the
 *  card surfaces quality info without noise or duplication. */
const cleanLinkTitle = (text: string): string | undefined => {
  const t = text
    .replace(/⚡/g, '')
    .replace(/\[[\d.]+\s*(?:TB|GB|MB|KB)\]/gi, '')
    .replace(/\b(Drive|Instant|Watch|Server|Download)\b/gi, '')
    .replace(/\|/g, ' ')
    .replace(/[-–—]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t || undefined;
};

/** Canonical identity key — strips ephemeral query params for HubCloud (keeps from_ac), keeps full href otherwise. */
const getCanonicalKey = (url: URL): string => {
  if (/hubcloud/.test(url.hostname)) {
    const u = new URL(url);
    const fromAc = u.searchParams.get('from_ac');
    u.search = '';
    if (fromAc) u.searchParams.set('from_ac', fromAc);
    return u.href;
  }
  return url.href;
};

const hostPriority = (url: URL): number => {
  if (/hubdrive/.test(url.hostname)) return 3;
  if (/hubcloud/.test(url.hostname)) return 2;
  if (/hubcdn/.test(url.hostname)) return 1;
  return 0;
};

/** Collapse multiple host mirrors of the same encode (same height + title) into one result.
 *  Prefers mirrors with a known file size and reliable hosts (hubdrive/hubcloud) over hubcdn,
 *  which reduces duplicate stream cards and avoids surfacing mirrors that often fail. Results that
 *  carry no height or title are left as-is because they cannot be safely grouped. */
const deduplicateMirrorHosts = (results: SourceResult[]): SourceResult[] => {
  const withMeta: SourceResult[] = [];
  const withoutMeta: SourceResult[] = [];
  results.forEach((r) => {
    if ((r.meta.height ?? 0) > 0 || r.meta.title) withMeta.push(r);
    else withoutMeta.push(r);
  });

  const groups = new Map<string, SourceResult[]>();
  withMeta.forEach((r) => {
    // Unknown-size mirrors are grouped by height+title so host duplicates collapse, while
    // mirrors with different sizes are treated as distinct encodes.
    const bytesKey = r.meta.bytes !== undefined ? String(r.meta.bytes) : '';
    const key = `${r.meta.height ?? 0}|${r.meta.title ?? ''}|${bytesKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  });

  const deduped = Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0]!;
    return group.sort((a, b) => {
      const bHasBytes = (b.meta.bytes ?? 0) > 0 ? 1 : 0;
      const aHasBytes = (a.meta.bytes ?? 0) > 0 ? 1 : 0;
      if (bHasBytes !== aHasBytes) return bHasBytes - aHasBytes;
      return hostPriority(b.url) - hostPriority(a.url);
    })[0]!;
  });

  return [...withoutMeta, ...deduped];
};

/** Deduplicate SourceResults by canonical URL, and collapse mirrors of the same file.
 *  Same quality + same size = the same encode mirrored across hub hosts, so only the first
 *  mirror is kept (the rest are redundant clutter). Results without a known size (e.g. episode
 *  single links whose page has no size) are left untouched so their Drive/Instant mirrors survive. */
const deduplicateSourceResults = (results: SourceResult[]): SourceResult[] => {
  const seenUrl = new Set<string>();
  const seenFile = new Set<string>();
  return results.filter((r) => {
    const urlKey = getCanonicalKey(r.url);
    if (seenUrl.has(urlKey)) return false;
    seenUrl.add(urlKey);
    if (r.meta.bytes !== undefined) {
      const fileKey = `${r.meta.height ?? 0}|${r.meta.bytes}`;
      if (seenFile.has(fileKey)) return false;
      seenFile.add(fileKey);
    }
    return true;
  });
};

export class HDHub4u extends Source {
  public readonly id = 'hdhub4u';

  public readonly label = 'HDHub4u';

  public readonly contentTypes: ContentType[] = ['movie', 'series'];

  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.gu, CountryCode.hi, CountryCode.ml, CountryCode.pa, CountryCode.ta, CountryCode.te];

  public readonly baseUrl = 'https://new1.hdhub4u.limo';

  protected override readonly domainKey = 'hdhub';

  private readonly FALLBACK_CANDIDATES = [
    'https://new8.hdhub4u.cl',
    'https://new1.hdhub4u.limo',
    'https://new1.hdhub4u.fo',
    'https://new2.hdhub4u.fo',
    'https://new3.hdhub4u.fo',
    'https://new4.hdhub4u.fo',
    'https://new5.hdhub4u.fo',
    'https://new6.hdhub4u.fo',
    'https://new7.hdhub4u.fo',
    'https://new8.hdhub4u.fo',
    'https://new9.hdhub4u.fo',
    'https://new10.hdhub4u.fo',
  ];

  private readonly searchUrl = 'https://search.pingora.fyi';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();

    this.fetcher = fetcher;
  }

  public override async prewarm(ctx: Context): Promise<void> {
    try {
      await this.fetcher.text(ctx, new URL(this.baseUrl));
      this.fetcher.getLogger().info('HDHub4u: pre-warm complete', ctx);
    } catch (error) {
      this.fetcher.getLogger().warn(`HDHub4u: pre-warm failed: ${error}`, ctx);
    }
  }

  public async handleInternal(ctx: Context, _type: string, id: Id): Promise<SourceResult[]> {
    const imdbId = await getImdbId(ctx, this.fetcher, id);

    const pageUrls = await this.fetchPageUrls(ctx, imdbId, id);

    // HubCloud mirrors only (see filterHubHosts) — this source's non-hub mirrors are slow or
    // dead, and hdhub4u regularly missed the first stream response because of them.
    return filterHubHosts(
      deduplicateMirrorHosts(
        deduplicateSourceResults(
          (await Promise.all(
            pageUrls.map(async (pageUrl) => {
              return await this.handlePage(ctx, pageUrl, imdbId);
            }),
          )).flat(),
        ),
      ),
    );
  };

  /** Collect unique redirect links (gadgetsweb/4khdhub) from a cheerio instance, preserving the
   *  first occurrence's text for quality/title parsing and avoiding double processing when a
   *  selector matches the same anchor via multiple patterns. */
  private readonly uniqueRedirectLinks = ($: CheerioAPI, selector: string): { href: string; text: string }[] => {
    const seen = new Set<string>();
    return $(selector)
      .map((_i, el) => ({ href: $(el).attr('href') ?? '', text: $(el).text() }))
      .toArray()
      .filter((l): l is { href: string; text: string } => {
        if (!l.href || seen.has(l.href)) return false;
        seen.add(l.href);
        return true;
      });
  };

  private readonly handlePage = async (ctx: Context, pageUrl: URL, imdbId: ImdbId): Promise<SourceResult[]> => {
    const html = await this.fetcher.text(ctx, pageUrl);

    const $ = cheerio.load(html);

    const meta = {
      countryCodes: [CountryCode.multi, ...findCountryCodes($('div:contains("Language"):not(:has(div)):first').text())],
    };

    if (!imdbId.episode) {
      return [
        ...this.extractHubDriveUrlResults(html, meta),
        ...(await Promise.all(
          this.uniqueRedirectLinks($, 'a[href*="gadgetsweb"], a[href*="4khdhub"]').map((link) => {
            const gadgetMeta = extractLinkMeta(link.text, { ...meta, title: cleanLinkTitle(link.text) });
            return this.handleHubLinks(ctx, new URL(link.href), pageUrl, gadgetMeta);
          }),
        )).flat(),
      ];
    }

    const ep = imdbId.episode;
    const epPadded = String(ep).padStart(2, '0');
    const episodeLabel = `S${String(imdbId.season).padStart(2, '0')}E${epPadded}`;
    const episodeSelector = [
      `h3:contains("EP-${epPadded}")`,
      `h3:contains("EPiSODE ${ep}")`,
      `h3:contains("EPiSODE ${epPadded}")`,
      `h3:contains("Episode ${ep}")`,
      `h3:contains("Episode ${epPadded}")`,
      `h4:contains("EP-${epPadded}")`,
      `h4:contains("EPiSODE ${ep}")`,
      `h4:contains("E${epPadded} ")`,
      `h4:contains("E${ep} ")`,
      `h4:contains("EPiSODE ${epPadded}")`,
      `h4:contains("Episode ${ep}")`,
      `h4:contains("Episode ${epPadded}")`,
      `h2:contains("EPiSODE ${ep}")`,
      `h2:contains("EPiSODE ${epPadded}")`,
      `h2:contains("Episode ${ep}")`,
      `h2:contains("Episode ${epPadded}")`,
    ].join(', ');

    const heading = $(episodeSelector).first();

    // This volume page doesn't contain the requested episode (e.g. VOL-1 [E01-04] when the user
    // asked for E05). Return nothing instead of flooding the stream list with full-season packs
    // mirrored from the wrong volume — every volume page shares the same season title, so without
    // this guard each volume contributes its packs for an episode it doesn't even have.
    if (heading.length === 0) {
      return [];
    }

    const headingAndAfterHtml = $.html(heading)
      + heading.nextUntil('hr').map((_i, el) => $.html(el)).get().join('');

    // Episode-scoped gadgetsweb links — only the link matching the requested episode number.
    // The section may contain links for ALL episodes (EPiSODE 1..10); without this filter
    // every episode's mirrors would be returned, inflating the stream list with wrong episodes.
    const epLinkRegex = new RegExp(`(?:EPiSODE|Episode|EP-|EP)\\s*0*${ep}(?!\\d)`, 'i');
    const episodeSection$ = cheerio.load(headingAndAfterHtml);
    const episodeGadgetLinks = episodeSection$('a[href*="gadgetsweb"], a[href*="4khdhub"]')
      .map((_i, el) => ({ href: episodeSection$(el).attr('href') ?? '', text: episodeSection$(el).text() }))
      .toArray()
      .filter((l): l is { href: string; text: string } => !!l.href && epLinkRegex.test(l.text));

    // Episode-scoped hub links (the primary results): "Drive"/"Instant" mirrors that sit right
    // under the EPiSODE N heading.
    const episodeHubResults = this.extractHubDriveUrlResults(headingAndAfterHtml, meta, episodeLabel);

    // Season/volume packs (top-of-page gadgetsweb links under non-episode headings) are NOT
    // included for a single-episode request: a season pack is the wrong content for one episode
    // and previously flooded the stream list (every volume page dumped its packs for the
    // requested episode). Only episode-scoped links are returned.

    // Deduplicate episode gadgetsweb links by href, preserving first link's text for quality parsing
    const seenGadgetHrefs = new Set<string>();
    const episodeLinks = episodeGadgetLinks
      .filter(l => (seenGadgetHrefs.has(l.href) ? false : (seenGadgetHrefs.add(l.href), true)));

    return [
      ...episodeHubResults,
      ...(await Promise.all(
        episodeLinks.map((link) => {
          const baseMeta = { ...meta, title: cleanLinkTitle(link.text) ?? (episodeLabel && /2160p|1080p|720p|480p|4k/i.test(link.text) ? `${episodeLabel} ${cleanLinkTitle(link.text)}` : undefined) };
          const linkMeta = epLinkRegex.test(link.text) ? baseMeta : extractLinkMeta(link.text, baseMeta);
        return this.handleHubLinks(ctx, new URL(link.href), pageUrl, linkMeta, episodeLabel);
      }),
    )).flat(),
];
  };

  private readonly handleHubLinks = async (ctx: Context, redirectUrl: URL, refererUrl: URL, meta: Meta, episodeLabel?: string): Promise<SourceResult[]> => {
    let resolvedUrl: URL;
    try {
      resolvedUrl = await resolveRedirectUrl(ctx, this.fetcher, redirectUrl);
    } catch {
      return [];
    }

    if (!resolvedUrl) {
      return [];
    }

    if (HUB_HOST_PATTERN.test(resolvedUrl.hostname)) {
      if (!DEAD_HUBCLOUD_HOSTS.has(resolvedUrl.hostname)) {
        return [{ url: resolvedUrl, meta: { ...meta, referer: refererUrl.href } }];
      }
      return [];
    }

    const hubLinksHtml = await this.fetcher.text(ctx, resolvedUrl, { headers: { Referer: refererUrl.href } });

    return [
      ...this.extractHubDriveUrlResults(hubLinksHtml, { ...meta, referer: resolvedUrl.href }, episodeLabel),
    ];
  };

  private readonly extractHubDriveUrlResults = (html: string, meta: Meta, episodeLabel?: string): SourceResult[] => {
    const $ = cheerio.load(html);
    const results: SourceResult[] = [];
    let lastQuality = '';

    // Walk elements sequentially so quality headers (h2-h6, p, strong) are tracked
    // and applied to subsequent hub links whose own anchor text lacks quality info.
    $.root().find('*').each((_, el) => {
      const $el = $(el);
      const tag = el.tagName;
      const text = $el.text().trim().replace(/\s+/g, ' ');

      // Quality header: p/strong/h2-h6 with resolution markers or filesize, under 140 chars.
      if (/^(p|strong|h[2-6])$/.test(tag)
        && /(2160p|1080p|720p|480p|4k|hevc|x265|x264|size|gb|mb|tb)/i.test(text)
        && text.length < 140) {
        // If it introduces a new resolution or video format, reset the tracked heading.
        // Otherwise (if it's just a "Size: 2GB" paragraph underneath), append it.
        if (/(2160p|1080p|720p|480p|4k|hevc|x265|x264)/i.test(text)) {
          lastQuality = text;
        } else {
          lastQuality += ` ${text}`;
        }
        return;
      }

      // Hub link anchor
      const href = $el.attr('href') ?? '';
      if (!href) return;
      const hrefLower = href.toLowerCase();
      if (!HUB_HOST_PATTERN.test(hrefLower)) return;
      if (EXCLUDED_HREF_PATTERNS.some(p => hrefLower.includes(p))) return;
      if (text.includes('⚡')) return;

      try {
        const url = new URL(href);
        if (DEAD_HUBCLOUD_HOSTS.has(url.hostname)) return;

        // Prefer link text quality; fall back to nearest quality header.
        let linkMeta = extractLinkMeta(text, meta);
        if (linkMeta.height === undefined && linkMeta.bytes === undefined && lastQuality) {
          linkMeta = extractLinkMeta(lastQuality, linkMeta);
        }
        // Build a human-readable title so the Stremio card shows episode/quality info.
        // Priority: base64 filename from search-recover ?q= > cleaned link text > nearest
        // quality header. Generic mirror labels ("Direct", "HubCloud", etc.) fall back to the
        // heading so multiple mirrors of the same encode share one title and can be deduped.
        const decodedTitle = decodeHubTitle(url);
        const cleanedText = cleanLinkTitle(text);
        const isGeneric = !cleanedText || /^(Direct|HubCloud|HubDrive|HubCDN|Watch|Download)$/i.test(cleanedText);
        const title = decodedTitle
          ?? (!isGeneric ? cleanedText : undefined)
          ?? (episodeLabel && linkMeta.height ? `${episodeLabel} ${heightLabel(linkMeta.height)}` : undefined)
          ?? (lastQuality ? cleanLinkTitle(lastQuality) : undefined)
          ?? cleanedText
          ?? linkMeta.title;
        results.push({ url, meta: title ? { ...linkMeta, title } : linkMeta });
      } catch { /* invalid URL */ }
    });

    return results;
  };

  private readonly fetchPageUrls = async (ctx: Context, imdbId: ImdbId, id: Id): Promise<URL[]> => {
    const baseUrl = await this.getBaseUrl(ctx);

    const results = await this.fetchPageUrlsFromSearch(ctx, imdbId, baseUrl);
    if (results.length > 0) {
      return results;
    }

    // Fallback: search by title (IMDb ID not in Typesense index — happens for recently added posts).
    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (name) {
      const titleResults = await this.fetchPageUrlsByTitle(ctx, name, year, imdbId, baseUrl);
      if (titleResults.length > 0) {
        return titleResults;
      }
    }

    return this.fetchPageUrlsFromSiteSearch(ctx, imdbId, baseUrl);
  };

  private readonly fetchPageUrlsFromSearch = async (ctx: Context, imdbId: ImdbId, baseUrl: URL): Promise<URL[]> => {
    try {
      const searchUrl = new URL(`/collections/post/documents/search?query_by=imdb_id&q=${encodeURIComponent(imdbId.id)}`, this.searchUrl);
      const searchResponse = await this.fetcher.json(ctx, searchUrl, { headers: { Referer: baseUrl.href, Origin: baseUrl.origin } }) as SearchResponsePartial;

      return searchResponse.hits
        .filter(hit =>
          hit.document.imdb_id === imdbId.id
          && (
            !imdbId.season
            || (() => {
              const season = imdbId.season;
              const title = hit.document.post_title;
              const padded = String(season).padStart(2, '0');
              if (title.includes(`Season ${season}`) || title.includes(`S${season}`) || title.includes(`S${padded}`)) return true;
              // Check ranges like S01-05 or Seasons 1-5
              const rangeMatch = title.match(/(?:s|season\s*s?)[a-z\s]*0*(\d+)\s*[-\u2013]\s*0*(\d+)/i);
              if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
                const start = parseInt(rangeMatch[1], 10);
                const end = parseInt(rangeMatch[2], 10);
                return season >= start && season <= end;
              }
              return false;
            })()
          ),
        )
        .map(hit => this.rebasePermalink(hit.document.permalink, baseUrl));
    } catch {
      return [];
    }
  };

  private readonly fetchPageUrlsFromSiteSearch = async (ctx: Context, imdbId: ImdbId, baseUrl: URL): Promise<URL[]> => {
    try {
      const siteSearchUrl = new URL(`/?s=${encodeURIComponent(imdbId.id)}`, baseUrl);
      const html = await this.fetcher.text(ctx, siteSearchUrl);
      const $ = cheerio.load(html);

      return $('a')
        .filter((_i, el) => {
          const href = $(el).attr('href') ?? '';
          const text = $(el).text();
          return href.startsWith(baseUrl.origin)
            && (text.includes(imdbId.id) || href.includes(imdbId.id));
        })
        .map((_i, el) => new URL($(el).attr('href') as string))
        .toArray();
    } catch {
      return [];
    }
  };

  /** Typesense title search fallback — used when the IMDb ID isn't in the search index
   *  (recently added posts have empty imdb_id fields). Matches by cleaned title + year (±1). */
  private readonly fetchPageUrlsByTitle = async (ctx: Context, name: string, year: number, imdbId: ImdbId, baseUrl: URL): Promise<URL[]> => {
    try {
      const searchUrl = new URL(`/collections/post/documents/search?query_by=post_title&q=${encodeURIComponent(name)}`, this.searchUrl);
      const searchResponse = await this.fetcher.json(ctx, searchUrl, { headers: { Referer: baseUrl.href, Origin: baseUrl.origin } }) as SearchResponsePartial;

      const nameClean = HDHub4u.clean(name);
      const yearRe = /\b(19[89]\d|20\d{2})\b/;

      return searchResponse.hits
        .filter((hit) => {
          const title = hit.document.post_title;
          const titleClean = HDHub4u.clean(title);
          if (!titleClean.includes(nameClean)) return false;

          // Year check (±1) — skip if the result has a year that doesn't match.
          const yearMatch = title.match(yearRe);
          if (yearMatch && Math.abs(parseInt(yearMatch[0], 10) - year) > 1) return false;

          // Series: season must appear in the title, or be inside a range (S01-05).
          if (imdbId.season) {
            const season = imdbId.season;
            const padded = String(season).padStart(2, '0');
            let hasSeason = title.includes(`Season ${season}`) || title.includes(`S${season}`) || title.includes(`S${padded}`);
            if (!hasSeason) {
              const rangeMatch = title.match(/(?:s|season\s*s?)[a-z\s]*0*(\d+)\s*[-\u2013]\s*0*(\d+)/i);
              if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
                const start = parseInt(rangeMatch[1], 10);
                const end = parseInt(rangeMatch[2], 10);
                hasSeason = season >= start && season <= end;
              }
            }
            return hasSeason;
          }

          // Movies: reject series results when searching for a movie.
          return !/season\s+\d/i.test(title);
        })
        .map(hit => this.rebasePermalink(hit.document.permalink, baseUrl));
    } catch {
      return [];
    }
  };

  /** Resolve a search-hit permalink against the live base. The Typesense index
   *  keeps permalinks from older mirror domains (the .free TLD is dead) —
   *  rebase those onto the resolved baseUrl so the post page stays fetchable. */
  private readonly rebasePermalink = (permalink: string, baseUrl: URL): URL => {
    const raw = new URL(permalink, baseUrl);
    if (raw.hostname !== baseUrl.hostname && /hdhub4u\./.test(raw.hostname)) {
      return new URL(`${raw.pathname}${raw.search}`, baseUrl);
    }
    return raw;
  };

  private static clean(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private async discoverFromCdn(ctx: Context): Promise<string | null> {
    if (cdnDiscoveredUrl && Date.now() - cdnDiscoveryTs < CDN_HOST_TTL) {
      return cdnDiscoveredUrl;
    }

    try {
      const d = new Date();
      const seed = (d.getFullYear() * 1000000) + ((d.getMonth() + 1) * 10000) + (d.getDate() * 100) + d.getHours() + 1;
      const url = new URL(`?v=${seed}`, CDN_HOST_URL);
      const response = await this.fetcher.json(ctx, url) as CdnHostResponse;

      if (response.c) {
        const decoded = atob(response.c.replace(/\/$/, ''));
        const baseUrl = decoded.replace(/[?&]utm=[^&]*/, '').replace(/\/$/, '');
        cdnDiscoveredUrl = baseUrl;
        cdnDiscoveryTs = Date.now();
        return baseUrl;
      }
    } catch { /* CDN endpoint unreachable */ }

    return null;
  }

  private readonly getBaseUrl = async (ctx: Context) => {
    const cdnUrl = await this.discoverFromCdn(ctx);
    if (cdnUrl) {
      const hostname = (() => {
        try {
          return new URL(cdnUrl).hostname;
        } catch {
          return '';
        }
      })();
      const diedAt = hostname ? Source.deadDomains.get(hostname) : undefined;
      const isKnownDead = diedAt && Date.now() - diedAt < Source.DEAD_DOMAIN_TTL;

      if (!isKnownDead) {
        const needsVerify = Date.now() - cdnVerifiedAliveAt >= CDN_VERIFY_INTERVAL;
        if (Source.isFailing(this.domainKey) || needsVerify) {
          if (await this.isDomainAlive(ctx, this.fetcher, cdnUrl)) {
            Source.recordSuccess(this.domainKey);
            cdnVerifiedAliveAt = Date.now();
          } else {
            if (hostname) Source.deadDomains.set(hostname, Date.now());
            resetCdnCache();
            return this.probeBaseUrl(ctx, this.fetcher, this.domainKey, this.FALLBACK_CANDIDATES);
          }
        }
        try {
          return new URL(cdnUrl);
        } catch {
          // invalid CDN URL, fall through to probeBaseUrl
        }
      }
    }

    return this.probeBaseUrl(ctx, this.fetcher, this.domainKey, this.FALLBACK_CANDIDATES);
  };
}
