import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import { envGet, Fetcher, getTmdbId, getTmdbNameAndYear, Id } from '../utils';
import { Source, SourceResult } from './Source';
import { HttpError } from '../error';

// Kayoanime (kayoanime.com) is a WordPress (TIELab/Jannah) anime site whose post pages link to
// Google Drive resources — either a **folder** (one per quality / season, holding episode .mkv
// files) or a **direct file** link (a single file, common for movies). Many links are "Private
// Drive" resources gated behind a Google Group join: with no credentials these yield nothing; with
// a logged-in Google account's cookies (GDRIVE_COOKIE env) the folder lists and the file streams.
//
// Resolution chain:
//   WP search ?s=<name> → match post by slug (download posts carry a quality token in the slug)
//   post page → collect `a.shortc-button` Google-Drive links (folder OR file) + quality/season labels
//   folder → Google's `embeddedfolderview` endpoint lists the files (id + name) [cookies if set]
//   file link → used directly (movie only; a single file has no episode to match for series)
//   series → match the requested episode number from the filename
//   movie → folder: first video file; file link: the linked file
//   file id → `drive.usercontent.google.com/download?id=<id>&export=download&confirm=t` routed
//     through the addon's /relay (range-forward profile). The relay injects a browser UA, retries
//     Google's transient 403 quota errors, and forwards GDRIVE_COOKIE for private resources.

const GDRIVE_FOLDER_RE = /drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/i;
// Post-page direct file link: `drive.google.com/file/d/<id>/view`.
const GDRIVE_FILE_PAGE_RE = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i;
// File-id extracted from an embeddedfolderview entry anchor: `/file/d/<id>/view`.
const GDRIVE_FILE_ENTRY_RE = /\/file\/d\/([a-zA-Z0-9_-]+)/i;
const VIDEO_EXT_RE = /\.(mkv|mp4|webm|avi|mov|m4v)$/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
// Slugs of full-season/full-series download posts carry one of these tokens; per-episode "english
// subbed" posts (e.g. "...-episode-1-english-subbed") and news posts do not, so this filters them.
const DOWNLOAD_SLUG_RE = /(1080p|2160p|720p|480p|4k|bluray|blu-ray|dual-audio|hevc|x264|x265)/i;
const EPISODE_SUBBED_RE = /episode-\d+-english-subbed/i;

interface DownloadLink {
  kind: 'folder' | 'file';
  id: string;
  label: string;
  height: number;
  season: number | undefined;
  isPrivate: boolean;
}

interface DriveFile {
  id: string;
  name: string;
  episode: number | undefined;
  season?: number | undefined;
}

const parseHeight = (text: string): number => {
  if (/2160p|4k/i.test(text)) return 2160;
  if (/1080p/i.test(text)) return 1080;
  if (/720p/i.test(text)) return 720;
  if (/480p/i.test(text)) return 480;
  return 0;
};

const parseSeason = (text: string): number | undefined => {
  const range = text.match(/Season\s*(\d+)\s*[-–]\s*(\d+)/i);
  if (range?.[1]) return parseInt(range[1], 10); // a "Season 1-2" post → treat as the first season listed
  const single = text.match(/Season\s*(\d+)/i);
  return single?.[1] ? parseInt(single[1], 10) : undefined;
};

/** Extract an episode number from a Drive filename, e.g. "Sousou no Frieren - 01.mkv" → 1. */
const parseEpisode = (name: string): number | undefined => {
  const base = name.replace(VIDEO_EXT_RE, '');
  let m = base.match(/S\d{1,2}E(\d{1,3})/i);
  if (m?.[1]) return parseInt(m[1], 10);
  // "Berserk 1x01" — SxE naming some packs use
  m = base.match(/\b\d{1,2}x(\d{1,3})\b/i);
  if (m?.[1]) return parseInt(m[1], 10);
  m = base.match(/Episode\s*0*(\d{1,3})/i);
  if (m?.[1]) return parseInt(m[1], 10);
  m = base.match(/\bE0*(\d{1,3})\b/i);
  if (m?.[1]) return parseInt(m[1], 10);
  // trailing " - 01" / " 01" (the common kayoanime "Show - NN.mkv" pattern)
  m = base.match(/[-\s]0*(\d{1,3})$/);
  return m?.[1] ? parseInt(m[1], 10) : undefined;
};

const parseFileSeason = (name: string): number | undefined => {
  const m = name.replace(VIDEO_EXT_RE, '').match(/\b(\d{1,2})x\d{1,3}\b/i);
  return m?.[1] ? parseInt(m[1], 10) : undefined;
};

/** Build the public/cookie streamable Google Drive download URL for a file id. */
const buildStreamUrl = (fileId: string): URL => {
  const u = new URL('https://drive.usercontent.google.com/download');
  u.searchParams.set('id', fileId);
  u.searchParams.set('export', 'download');
  u.searchParams.set('confirm', 't');
  return u;
};

export class Kayoanime extends Source {
  public readonly id = 'kayoanime';
  public readonly label = 'Kayoanime';
  public readonly contentTypes: ContentType[] = ['movie', 'series'];
  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.en];
  public readonly baseUrl = 'https://kayoanime.com';
  public override readonly category = 'anime' as const;
  // GDrive file IDs are stable; folder links rarely change. 6h keeps results fresh without
  // re-scraping the (slowish) WP + embeddedfolderview chain on every request.
  public override readonly ttl = 6 * 60 * 60 * 1000;

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public override async prewarm(ctx: Context): Promise<void> {
    try {
      await this.fetcher.text(ctx, new URL(this.baseUrl));
      this.fetcher.getLogger().info('Kayoanime: pre-warm complete', ctx);
    } catch (error) {
      this.fetcher.getLogger().warn(`Kayoanime: pre-warm failed: ${error}`, ctx);
    }
  }

  private clean(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private get logger() {
    return this.fetcher.getLogger();
  }

  /** Google account cookie string (GDRIVE_COOKIE env) enabling Private Drive access, if configured. */
  private get gdriveCookie(): string | undefined {
    return envGet('GDRIVE_COOKIE')?.trim() || undefined;
  }

  protected async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    if (type !== 'movie' && type !== 'series') return [];

    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (!name) return [];

    const postUrl = await this.findPost(ctx, name, year, tmdbId.season);
    if (!postUrl) {
      this.logger.info(`Kayoanime: no post matched TMDB "${name}" ${year ?? ''}`, ctx);
      return [];
    }

    let html: string;
    try {
      html = await this.fetcher.text(ctx, postUrl, { headers: { Referer: this.baseUrl } });
    } catch {
      return [];
    }

    const $ = cheerio.load(html);
    const postHeight = parseHeight($('h1.post-title').first().text()) || parseHeight(html);
    const links = this.collectDownloadLinks($, postHeight);

    if (links.length === 0) {
      this.logger.info(`Kayoanime: no Google Drive links on ${postUrl.pathname}`, ctx);
      return [];
    }

    const season = tmdbId.season;
    const episode = tmdbId.episode;
    const chosen = this.chooseLinks(links, season);

    const results: SourceResult[] = [];
    for (const link of chosen) {
      let fileId: string | undefined;
      let fileName: string | undefined;
      let fileSize: number | undefined;

      if (link.kind === 'folder') {
        const files = await this.listFolder(ctx, link.id);
        if (files.length === 0) continue;

        let file: DriveFile | undefined;
        if (type === 'series') {
          if (!episode) continue;
          // SxE-named packs may hold several seasons in one folder — match both.
          file = files.find(f => f.episode === episode && (f.season === undefined || f.season === season));
        } else {
          // Movie: pick the first video file (a movie folder normally holds a single file).
          file = files[0];
        }
        if (!file) continue;
        fileId = file.id;
        fileName = file.name;
      } else {
        // Direct file link. A single file carries no episode info, so only usable for movies.
        if (type === 'series') continue;
        // Verify the file is accessible (public, or private via cookie). HEAD also yields the size.
        const streamUrl = buildStreamUrl(link.id);
        const headHeaders: Record<string, string> = { 'User-Agent': 'Mozilla/5.0' };
        if (this.gdriveCookie) headHeaders['Cookie'] = this.gdriveCookie;
        try {
          const h = await this.fetcher.head(ctx, streamUrl, { headers: headHeaders, timeout: 8000 });
          const len = h['content-length'];
          const lenStr = Array.isArray(len) ? len[0] : typeof len === 'string' ? len : undefined;
          if (lenStr) fileSize = parseInt(lenStr, 10);
        } catch (e) {
          const status = e instanceof HttpError ? `${e.status} ${e.statusText}` : (e instanceof Error ? e.message : String(e));
          this.logger.info(`Kayoanime: file link not accessible (${link.id}): ${status}`, ctx);
          continue;
        }
        fileId = link.id;
        fileName = link.label;
      }

      const relay = new URL('/relay', ctx.hostUrl);
      relay.searchParams.set('url', buildStreamUrl(fileId).href);

      const meta: Meta = {
        countryCodes: this.countryCodes,
        height: link.height || postHeight || 1080,
        title: fileName,
        sourceLabel: this.label,
        ...(fileSize && { bytes: fileSize }),
        ...(season && { season }),
        ...(episode && { episode }),
      };

      results.push({ url: relay, meta });
    }

    return results;
  }

  /**
   * Search the WP site and pick the download post whose slug/text matches the name + year + season.
   *
   * Kayoanime slugs prefix the Japanese title (e.g. "sousou-no-frieren-…-1080p-bluray-dual-audio"),
   * so — unlike WorldFree4u — we match by *contains* rather than startsWith. Download posts carry a
   * quality token in the slug; per-episode "english subbed" posts and news posts are filtered out.
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

    const candidates: { href: string; slug: string; text: string }[] = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href.startsWith(`${this.baseUrl}/`)) return;
      if (href.includes('/page/') || href.includes('/category/') || href.includes('/wp-') || href.endsWith('/feed/') || href.includes('/search/') || href.includes('/tag/')) return;
      const slug = decodeURIComponent(href.replace(`${this.baseUrl}/`, '').replace(/\/+$/, ''));
      if (!slug || slug.includes('.') || slug.includes('/')) return;
      candidates.push({ href, slug, text: $(el).text() });
    });

    // Post slugs reorder or rename the title ("kimetsu-no-yaiba-demon-slayer" vs TMDB
    // "Demon Slayer: Kimetsu no Yaiba", "berserk-season-1-2-movies-memorial-edition" vs
    // "Berserk: The Golden Age Arc – Memorial Edition"), so full-string containment misses
    // them. Require the first name word plus a majority of the significant words.
    const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);

    for (const { href, slug, text } of candidates) {
      const combined = `${slug} ${text}`;
      const combinedClean = this.clean(combined);
      const hit = words.length
        ? combinedClean.includes(this.clean(words[0]!))
          && words.filter(w => combinedClean.includes(this.clean(w))).length >= Math.ceil(words.length / 2)
        : combinedClean.includes(nameClean);
      if (!hit) continue;
      // Only full download posts (quality token in slug); skip per-episode subbed + news posts.
      if (!DOWNLOAD_SLUG_RE.test(slug)) continue;
      if (EPISODE_SUBBED_RE.test(slug)) continue;

      const yearMatch = combined.match(YEAR_RE);
      if (year && yearMatch?.[0] && Math.abs(parseInt(yearMatch?.[0], 10) - year) > 1) continue;

      if (season !== undefined && !this.seasonMatches(combined, season)) continue;

      return new URL(href);
    }

    return undefined;
  }

  /** A post "covers" a season if it lists that season (or a range incl. it), or has no season marker. */
  private seasonMatches(text: string, season: number): boolean {
    const range = text.match(/Season\s*(\d+)\s*[-–]\s*(\d+)/i);
    if (range?.[1] && range[2]) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      return season >= Math.min(a, b) && season <= Math.max(a, b);
    }
    const single = text.match(/Season\s*0?(\d+)/i);
    if (single?.[1]) return parseInt(single[1], 10) === season;
    // No season marker → assume the post covers it (folder-level season logic refines further).
    return true;
  }

  /** Collect Google Drive folder AND direct-file links from the post's download buttons. */
  private collectDownloadLinks($: cheerio.CheerioAPI, fallbackHeight: number): DownloadLink[] {
    const links: DownloadLink[] = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const label = $(el).text().trim() || 'Drive';
      let kind: 'folder' | 'file' | undefined;
      let id: string | undefined;
      const fm = href.match(GDRIVE_FOLDER_RE);
      if (fm?.[1]) {
        kind = 'folder';
        id = fm[1];
      } else {
        const fim = href.match(GDRIVE_FILE_PAGE_RE);
        if (fim?.[1]) {
          kind = 'file';
          id = fim[1];
        }
      }
      if (!kind || !id) return;
      links.push({
        kind,
        id,
        label,
        height: parseHeight(label) || fallbackHeight,
        season: parseSeason(label),
        isPrivate: /private\s*drive/i.test(label),
      });
    });
    // De-duplicate by kind+id (a post may link the same resource twice).
    const seen = new Set<string>();
    return links.filter((l) => {
      const key = `${l.kind}:${l.id}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  }

  /**
   * For the requested season, pick one link per quality (height). Among the links that apply to
   * the season (explicit match or generic/no-season), prefer public over private so a public
   * resource wins when available. (Season-specific vs generic only matters for folders; file links
   * are season-generic unless their label names a season.)
   */
  private chooseLinks(links: DownloadLink[], season: number | undefined): DownloadLink[] {
    const applies = (l: DownloadLink): boolean =>
      season === undefined || l.season === undefined || l.season === season;

    const rank = (l: DownloadLink): number => {
      const seasonSpecific = l.season !== undefined;
      if (seasonSpecific && !l.isPrivate) return 3;
      if (seasonSpecific && l.isPrivate) return 2;
      if (!seasonSpecific && !l.isPrivate) return 1;
      return 0;
    };

    const byHeight = new Map<number, DownloadLink>();
    for (const l of links) {
      if (!applies(l)) continue;
      const key = l.height || 1080;
      const cur = byHeight.get(key);
      if (!cur || rank(l) > rank(cur)) byHeight.set(key, l);
    }
    return [...byHeight.values()];
  }

  /**
   * List the video files in a Google Drive folder via the `embeddedfolderview` endpoint. With
   * GDRIVE_COOKIE set, Private Drive folders list too; without it a private folder returns a
   * sign-in page (no `/file/d/` entries) → no files.
   */
  private async listFolder(ctx: Context, folderId: string): Promise<DriveFile[]> {
    const viewUrl = new URL('https://drive.google.com/embeddedfolderview');
    viewUrl.searchParams.set('id', folderId);
    viewUrl.hash = 'list';

    const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0' };
    if (this.gdriveCookie) headers['Cookie'] = this.gdriveCookie;

    let html: string;
    try {
      html = await this.fetcher.text(ctx, viewUrl, { headers });
    } catch (e) {
      const status = e instanceof HttpError ? `${e.status} ${e.statusText}` : (e instanceof Error ? e.message : String(e));
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        // embeddedfolderview rejects non-public folders with 401/403. With GDRIVE_COOKIE a folder
        // shared with the logged-in account should list; without it (or with an invalid/expired
        // cookie, or an account that hasn't joined the folder's Google Group) it stays rejected.
        const hint = this.gdriveCookie
          ? 'GDRIVE_COOKIE set but folder still rejected — cookie invalid/expired, or the account lacks access (join the Google Group the folder is shared with)'
          : 'private folder — set GDRIVE_COOKIE (a logged-in Google account cookie) to access';
        this.logger.info(`Kayoanime: folder ${folderId} not accessible (HTTP ${status}); ${hint}`, ctx);
      } else {
        this.logger.info(`Kayoanime: embeddedfolderview failed for ${folderId}: ${status}`, ctx);
      }
      return [];
    }

    // A private/not-shared folder (with no cookie) returns a sign-in page → no file entries.
    if (!/\/file\/d\//.test(html)) return [];

    const $ = cheerio.load(html);
    const files: DriveFile[] = [];
    $('a[href*="/file/d/"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const m = href.match(GDRIVE_FILE_ENTRY_RE);
      if (!m?.[1]) return;
      const name = ($(el).find('.flip-entry-title').first().text() || $(el).text()).trim();
      if (!VIDEO_EXT_RE.test(name)) return;
      files.push({ id: m[1], name, episode: parseEpisode(name), season: parseFileSeason(name) });
    });

    // De-duplicate by file id.
    const seen = new Set<string>();
    return files.filter(f => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  }
}
