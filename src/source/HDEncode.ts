// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck -- the Puppeteer page.evaluate callbacks execute in a browser context (document/window) which is not part of the Node tsconfig lib
import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import {
  Fetcher,
  findHeight,
  getHeadfulBrowser,
  getTmdbId,
  getTmdbNameAndYear,
  Id,
  isDebridHoster,
  pickBestHoster,
} from '../utils';
import { Source, SourceResult } from './Source';

const SIZE_RE = /([\d.]+)\s*(TB|GB|MB|KB)/i;

const parseSizeBytes = (text: string): number | undefined => {
  const m = text.match(SIZE_RE);
  if (!m) return undefined;
  return bytes.parse(`${m[1]} ${m[2]}`) ?? undefined;
};

const normalize = (str: string): string =>
  str.toLowerCase()
    .replace(/\./g, ' ')
    .replace(/&/g, 'and')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

interface ReleaseItem {
  title: string;
  postUrl: URL;
  height: number | undefined;
  bytes: number | undefined;
}

/** Revealed hoster links per post page, cached so repeat requests skip the
 *  expensive browser reveal (Turnstile solve + form submit). */
const revealedLinksCache = new Map<string, { urls: URL[]; ts: number }>();
const REVEALED_LINKS_TTL = 60 * 60 * 1000; // 1h

const MAX_REVEAL_POSTS = 3;

export class HDEncode extends Source {
  public readonly id = 'hdencode';

  public readonly label = 'HDEncode';

  public readonly contentTypes: ContentType[] = ['movie', 'series'];

  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.en];

  public readonly baseUrl = 'https://hdencode.org';

  public override readonly category = 'debrid' as const;

  protected override readonly domainKey = 'hdencode';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public override async prewarm(ctx: Context): Promise<void> {
    try {
      await this.fetcher.text(ctx, new URL(this.baseUrl));
      this.fetcher.getLogger().info('HDEncode: pre-warm complete', ctx);
    } catch (error) {
      this.fetcher.getLogger().warn(`HDEncode: pre-warm failed: ${error}`, ctx);
    }
  }

  public async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    if (!ctx.config.alldebridApiKey && !ctx.config.realdebridApiKey) return [];

    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (!name) return [];

    const rss = await this.search(ctx, name);
    if (!rss) return [];

    const items = this.parseRss(rss, name, year, type, tmdbId.season, tmdbId.episode);
    if (items.length === 0) {
      this.fetcher.getLogger().info(`HDEncode: 0 matching releases for "${name}"`, ctx);
      return [];
    }

    // Prefer higher resolution, then larger file size — and only reveal the
    // download links for the best handful (each reveal is a browser round-trip).
    items.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bytes ?? 0) - (a.bytes ?? 0));

    const logger = this.fetcher.getLogger();
    const topItems = items.slice(0, MAX_REVEAL_POSTS);

    // Reveal sequentially — the Content Protector/Turnstile flow rate-limits
    // hard when several posts solve at once (parallel reveals all fail).
    // The stream deadline bounds how many posts we get through.
    const results: SourceResult[] = [];
    for (const item of topItems) {
      if (ctx.streamDeadline && Date.now() > ctx.streamDeadline - 8000) {
        logger.info(`HDEncode: deadline near — stopping reveal after ${results.length} result(s)`, ctx);
        break;
      }

      const urls = await this.revealPostLinks(ctx, item.postUrl).catch((error: unknown) => {
        logger.warn(`HDEncode: reveal failed for ${item.postUrl.pathname}: ${error instanceof Error ? error.message : String(error)}`, ctx);
        return [] as URL[];
      });
      if (urls.length === 0) continue;

      const rapidgator = urls.find(
        u => u.host.includes('rapidgator') || u.host === 'rg.to',
      );
      const nitroflare = urls.find(
        u => u.host.includes('nitroflare'),
      );
      const best = rapidgator ?? nitroflare ?? pickBestHoster(urls);
      if (!best) continue;

      const cleanTitle = item.title
        .replace(/\s*[-–]\s*[\d.]+\s*(?:GB|MB|KB|TB)\s*$/i, '')
        .replace(/\./g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const meta: Meta = {
        title: `[HDEncode] ${cleanTitle}`,
        height: item.height,
        bytes: item.bytes,
        countryCodes: this.countryCodes,
        sourceLabel: this.label,
        sourceId: this.id,
        season: tmdbId.season,
        episode: tmdbId.episode,
      };

      results.push({ url: best, meta });

      if (results.length >= 3) break;
    }

    this.fetcher.getLogger().info(
      `HDEncode: returning ${results.length} result(s) for "${name}"`,
      ctx,
    );
    return results;
  }

  private async search(ctx: Context, query: string): Promise<string | undefined> {
    const slug = query.trim().split(/\s+/).map(encodeURIComponent).join('+');

    const pagePromises: Promise<string | undefined>[] = [];
    for (let page = 1; page <= 3; page++) {
      const searchUrl = new URL(`/search/${slug}/feed/rss2/`, this.baseUrl);
      if (page > 1) searchUrl.searchParams.set('paged', String(page));
      pagePromises.push(
        this.fetcher.text(ctx, searchUrl, { timeout: 12000 })
          .catch(() => undefined),
      );
    }

    const pages = await Promise.all(pagePromises);
    const combined = pages.filter((p): p is string => !!p).join('\n');
    return combined || undefined;
  }

  /** Extract matching releases from the RSS search feed. The feed's <enclosure>
   *  hoster URLs were removed by the site in 2026 — download links now live
   *  behind a Content Protector + Cloudflare Turnstile form on each post page —
   *  so this returns the post URL per release and the caller reveals links. */
  private parseRss(
    xml: string,
    name: string,
    year: number,
    type: ContentType,
    season: number | undefined,
    episode: number | undefined,
  ): ReleaseItem[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    const nameClean = normalize(name);
    const groups = new Map<string, ReleaseItem>();

    $('item').each((_i, el) => {
      const $item = $(el);
      const title = $item.find('title').text().trim();
      if (!title || !normalize(title).includes(nameClean)) return;

      if (type === 'series' && season && episode) {
        const epMatch = title.match(/s0*(\d+)e0*(\d+)/i);
        if (
          !epMatch?.[1] || !epMatch?.[2]
          || parseInt(epMatch[1], 10) !== season
          || parseInt(epMatch[2], 10) !== episode
        ) {
          return;
        }
      } else if (type === 'movie') {
        if (/s0*\d+e0*\d+/i.test(title)) return;
        const yearMatch = title.match(/\b(19[89]\d|20\d{2})\b/);
        if (yearMatch && year && Math.abs(parseInt(yearMatch[0], 10) - year) > 1) return;
      }

      let postUrl: URL | undefined;
      try {
        postUrl = new URL($item.find('link').first().text().trim());
      } catch { /* invalid URL */ }
      if (!postUrl || !postUrl.href.startsWith(this.baseUrl)) return;

      // Group by release title (without trailing size) so the same release
      // only produces one result even if it appears on multiple pages.
      const titleKey = normalize(title.replace(/\s*[-–]\s*[\d.]+\s*(?:GB|MB|KB|TB)\s*$/i, ''));
      if (!groups.has(titleKey)) {
        groups.set(titleKey, {
          title,
          postUrl,
          height: findHeight(title),
          bytes: parseSizeBytes(title),
        });
      }
    });

    return [...groups.values()];
  }

  /** Load a post page in the headful browser, let Turnstile auto-solve, submit
   *  the Content Protector form and collect the revealed hoster links. */
  private async revealPostLinks(ctx: Context, postUrl: URL): Promise<URL[]> {
    const cached = revealedLinksCache.get(postUrl.href);
    if (cached && Date.now() - cached.ts < REVEALED_LINKS_TTL) {
      return cached.urls;
    }

    const logger = this.fetcher.getLogger();
    const browser = await getHeadfulBrowser(logger);
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // @ts-expect-error - window.chrome is not typed
        window.chrome = { runtime: {} };
      });

      await page.goto(postUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Invisible Turnstile widget: wait until it has produced its token.
      try {
        await page.waitForFunction(() => {
          const el = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
          return !!el && !!el.value && el.value.length > 10;
        }, { timeout: 20000 });
      } catch { /* widget absent or slow — submit anyway, server decides */ }

      await page.evaluate(() => {
        const form = document.querySelector('form[id^="content-protector-access-form"]') as HTMLFormElement | null;
        const btn = form?.querySelector('input[type="submit"], button[type="submit"]') as HTMLElement | null;
        if (!btn) throw new Error('content-protector form not found');
        btn.click();
      });

      await page.waitForFunction(() => /rapidgator\.net|nitroflare\.com|rg\.to|1fichier\.com|ddownload\.com|turbobit\.net|katfile\.com|uploadgig\.com/i.test(document.body.innerHTML), { timeout: 25000 });

      const hrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).href),
      );

      const urls: URL[] = [];
      const seen = new Set<string>();
      for (const href of hrefs) {
        try {
          const url = new URL(href);
          if (!isDebridHoster(url.host) || seen.has(url.href)) continue;
          seen.add(url.href);
          urls.push(url);
        } catch { /* invalid URL */ }
      }

      if (urls.length > 0) {
        revealedLinksCache.set(postUrl.href, { urls, ts: Date.now() });
      }
      return urls;
    } finally {
      await page.close().catch(() => { /* already closed */ });
    }
  }
}
