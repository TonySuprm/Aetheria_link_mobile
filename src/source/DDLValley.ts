import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import { Fetcher, findHeight, getTmdbEpisodeAirDate, getTmdbId, getTmdbMovieReleaseDate, getTmdbNameAndYear, Id, isDebridHoster, normalizeFilename, TmdbId } from '../utils';
import { Source, SourceResult } from './Source';

const normalize = (str: string): string =>
  str.toLowerCase()
    .replace(/\./g, ' ')
    .replace(/&/g, 'and')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

interface PostInfo {
  url: URL;
  title: string;
  height: number | undefined;
}

export class DDLValley extends Source {
  public readonly id = 'ddlvalley';

  public readonly label = 'DDLValley';

  public readonly contentTypes: ContentType[] = ['movie', 'series'];

  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.en];

  public readonly baseUrl = 'https://www.ddlvalley.me';

  public override readonly category = 'debrid' as const;

  protected override readonly domainKey = 'ddlvalley';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    if (!ctx.config.alldebridApiKey && !ctx.config.realdebridApiKey) return [];

    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (!name) return [];

    let posts: PostInfo[] = [];

    if (type === 'series' && tmdbId.season && tmdbId.episode) {
      // WordPress search is Cloudflare-protected; daily archives are cached
      // and load without a challenge, so start with the episode air-date page.
      posts = await this.searchByAirDateArchive(ctx, tmdbId, name);
    }

    if (posts.length === 0 && !tmdbId.season) {
      // Movies: same story — the release-date daily archive loads without a
      // challenge. Try it BEFORE ?s= search: one blocked search marks the whole
      // host CF-protected in the Fetcher and fast-fails every later request.
      posts = await this.searchByReleaseDateArchive(ctx, tmdbId, name, year);
    }

    if (posts.length === 0) {
      const searchHtml = await this.search(ctx, name);
      if (searchHtml) {
        posts = this.parseSearchResults(searchHtml, name, year, tmdbId.season, tmdbId.episode);
      }
    }

    if (posts.length === 0) return [];

    this.fetcher.getLogger().info(`DDLValley: found ${posts.length} matching posts for "${name}"`, ctx);

    const results: SourceResult[] = [];
    const topPosts = posts.slice(0, 5);

    await Promise.all(
      topPosts.map(async (post) => {
        const links = await this.fetchPostLinks(ctx, post.url);
        for (const link of links) {
          const meta: Meta = {
            title: `[DDLValley] ${post.title}`,
            height: post.height,
            countryCodes: this.countryCodes,
            sourceLabel: this.label,
            sourceId: this.id,
            season: tmdbId.season,
            episode: tmdbId.episode,
          };
          results.push({ url: link, meta });
        }
      }),
    );

    this.fetcher.getLogger().info(`DDLValley: returning ${results.length} result(s) for "${name}"`, ctx);
    return results;
  }

  private async search(ctx: Context, query: string): Promise<string | undefined> {
    const searchUrl = new URL(`/?s=${encodeURIComponent(query)}`, this.baseUrl);
    try {
      return await this.fetcher.text(ctx, searchUrl, { timeout: 15000 });
    } catch {
      return undefined;
    }
  }

  private async fetchArchiveDays(
    ctx: Context,
    base: Date,
    parse: (html: string) => PostInfo[],
  ): Promise<PostInfo[]> {
    const offsets = [0, -1, 1, -2, 2];
    const posts: PostInfo[] = [];

    await Promise.all(
      offsets.map(async (offset) => {
        const date = new Date(base);
        date.setDate(date.getDate() + offset);

        const archiveUrl = new URL(
          `/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/`,
          this.baseUrl,
        );

        // CF challenges on this host are flaky per-request — some archive days
        // 403 on the first hit and pass on retry, so give each day one redo.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            // The 5-day × 2-attempt scan can outlive the stream deadline;
            // bail out instead of wasting the player's patience (HDEncode pattern).
            if (ctx.streamDeadline && Date.now() > ctx.streamDeadline - 8000) {
              this.fetcher.getLogger().info(`DDLValley: deadline near — skipping ${archiveUrl.pathname} attempt ${attempt}`, ctx);
              return;
            }
            if (attempt > 0) await new Promise(sleep => setTimeout(sleep, 1200));
            const html = await this.fetcher.text(ctx, archiveUrl, { timeout: 12000 });
            if (!html) return;
            const dayPosts = parse(html);
            if (dayPosts.length > 0) {
              posts.push(...dayPosts);
            }
            return;
          } catch { /* archive day missing, 404, or blocked */ }
        }
      }),
    );

    return posts;
  }

  private async searchByAirDateArchive(
    ctx: Context,
    tmdbId: TmdbId,
    name: string,
  ): Promise<PostInfo[]> {
    const airDate = await getTmdbEpisodeAirDate(ctx, this.fetcher, tmdbId);
    if (!airDate) return [];

    const base = new Date(airDate);
    if (Number.isNaN(base.getTime())) return [];

    return await this.fetchArchiveDays(ctx, base, html => this.parseSearchResults(html, name, 0, tmdbId.season, tmdbId.episode));
  }

  private async searchByReleaseDateArchive(
    ctx: Context,
    tmdbId: TmdbId,
    name: string,
    year: number,
  ): Promise<PostInfo[]> {
    const releaseDate = await getTmdbMovieReleaseDate(ctx, this.fetcher, tmdbId);
    if (!releaseDate) return [];

    const base = new Date(releaseDate);
    if (Number.isNaN(base.getTime())) return [];

    return await this.fetchArchiveDays(ctx, base, html => this.parseSearchResults(html, name, year, undefined, undefined));
  }

  private parseSearchResults(
    html: string,
    name: string,
    year: number,
    season: number | undefined,
    episode: number | undefined,
  ): PostInfo[] {
    const $ = cheerio.load(html);
    const nameClean = normalize(name);
    const posts: PostInfo[] = [];
    const seenHrefs = new Set<string>();

    const collect = (titleText: string, href: string) => {
      if (!titleText || !href) return;

      const titleClean = normalize(titleText);
      if (!titleClean.includes(nameClean)) return;

      if (!season) {
        const yearMatch = titleText.match(/\b(19[89]\d|20\d{2})\b/);
        if (yearMatch && year && Math.abs(parseInt(yearMatch[0], 10) - year) > 1) return;
      }

      if (season && episode) {
        const epMatch = titleText.match(/s0*(\d+)e0*(\d+)/i);
        if (!epMatch?.[1] || !epMatch?.[2] || parseInt(epMatch[1], 10) !== season || parseInt(epMatch[2], 10) !== episode) return;
      }

      if (seenHrefs.has(href)) return;
      seenHrefs.add(href);

      const height = findHeight(titleText);

      try {
        posts.push({
          url: new URL(href, this.baseUrl),
          title: titleText.replace(/\./g, ' ').replace(/\s+/g, ' ').trim(),
          height,
        });
      } catch { /* invalid URL */ }
    };

    $('h2 a[rel="bookmark"]').each((_i, el) => {
      const $el = $(el);
      collect($el.text().trim(), $el.attr('href') ?? '');
    });

    if (posts.length === 0) {
      $('a[rel="bookmark"]').each((_i, el) => {
        const $el = $(el);
        collect($el.text().trim(), $el.attr('href') ?? '');
      });
    }

    // The current theme (2026+) dropped rel="bookmark" — post titles are plain
    // single-segment anchors alongside nav/author/series links, which the
    // name/year/episode filters inside collect() already reject.
    if (posts.length === 0) {
      $('a[href]').each((_i, el) => {
        const $el = $(el);
        const href = $el.attr('href') ?? '';
        if (!href || href.startsWith('#') || href.includes('?')) return;

        try {
          const url = new URL(href, this.baseUrl);
          if (url.hostname.replace(/^www\./, '') !== 'ddlvalley.me') return;
          const path = url.pathname.replace(/\/+$/, '');
          if (!path || path.includes('/')) return; // post slugs are single-segment
          if (/^(about|contact|dmca|forum|irc|author|category|tag|show|page|feed|wp-content|wp-includes|privacy|terms)$/i.test(path)) return;

          collect($el.text().trim(), href);
        } catch { /* invalid URL */ }
      });
    }

    return posts;
  }

  private async fetchPostLinks(ctx: Context, postUrl: URL): Promise<URL[]> {
    let html: string;
    try {
      html = await this.fetcher.text(ctx, postUrl, { timeout: 12000 });
    } catch {
      return [];
    }

    const $ = cheerio.load(html);
    const seenHrefs = new Set<string>();

    // Group hoster links by normalized filename so we return only ONE hoster
    // per file (NitroFlare preferred). A single DDLValley post often has both
    // NitroFlare and RapidGator for the same .mkv — returning both creates
    // duplicate streams in Stremio for the same release.
    const fileMap = new Map<string, URL[]>();

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      try {
        const url = new URL(href);
        if (!isDebridHoster(url.host)) return;

        if (/\.part\d+\.rar/i.test(url.pathname)) return;

        if (seenHrefs.has(url.href)) return;
        seenHrefs.add(url.href);

        const fileKey = normalizeFilename(url);
        const bucket = fileMap.get(fileKey);
        if (bucket) {
          bucket.push(url);
        } else {
          fileMap.set(fileKey, [url]);
        }
      } catch { /* invalid URL */ }
    });

    // Return all debrid hoster URLs — the eager AllDebrid/RealDebrid extractor
    // resolves each one at stream-list time. Failing hosters (e.g. NitroFlare
    // under maintenance on AllDebrid) are filtered out; working ones (e.g.
    // Rapidgator) become direct CDN URL streams. Cross-source dedup in
    // StreamResolver collapses the same file from different hosters.
    return [...fileMap.values()].flat();
  }
}
