import { AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import winston from 'winston';
import { Context, Format, InternalUrlResult, Meta } from '../types';
import { Fetcher } from '../utils';
import { Extractor } from './Extractor';

// UHDMovies (uhdmovies.casa) extractor. Resolves the per-quality SID links
// (`cloud.unblockedgames.world/?sid=<base64>`, formerly `tech.unblockedgames.world`) to a
// driveleech/driveseed file page, then "Resume Cloud"/"Instant Download" → final Google-Drive-backed
// direct URL (workers.dev / video-downloads.googleusercontent.com). Lazy (resolution is ~10+ requests
// over ~20s → deferred to play time). Ported from the project's uhdmovies.js reference.
//
// SID flow A — current "lp" interstitial (en.thenaukriadda.in and friends):
//   GET ?sid=<b64>                → #lp-land form (_lp_http)
//   POST _lp_http                 → #lp-s1-form (_lp_http2, _lp_token, _lp_chain, _lp_hop_index)
//                                   + a ~10s countdown (server validates the hop age — submit early
//                                   and the chain dies with a session error)
//   POST s1 fields (after wait)   → JS: sc("<cookieName>","<value>",<mins>) + "?lp_go=<cookieName>" href
//   set cookie, GET ?lp_go=<name> → JS: window.location.replace("https://driveseed.org/r?key=…")
//   → driveseed/driveleech file page → final URL
//
// SID flow B — legacy WP form (cloud.unblockedgames.world):
//   GET ?sid=<b64>                  → #landing form (_wp_http + action)
//   POST action (_wp_http)          → #landing form (_wp_http2 + token + action)
//   POST action (_wp_http2+token)   → JS: s_343('cookieName','cookieValue') + c.setAttribute("href","<link>")
//   set cookie, GET <link>          → <meta http-equiv="refresh" content="...;url=<driveleech>">
//   GET <driveleech>                → file page (Resume Cloud / Instant Download) → final URL

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SID_HOSTS = ['cloud.unblockedgames.world', 'tech.unblockedgames.world', 'tech.examzculture.in', 'tech.creativeexpressionsblog.com', 'en.thenaukriadda.in', 'thenaukriadda.in'];
// Final direct-URL hosts the file-page methods look for.
const DIRECT_HOST_RE = /workers\.dev|driveleech\.net\/d\/|driveseed\.org\/d\/|googleusercontent\.com|\.r2\.dev/i;

const buildMultipart = (fields: Record<string, string>): { body: string; contentType: string } => {
  const boundary = '----UHDBoundary' + Math.random().toString(36).slice(2);
  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
};

const fixWorkersSpaces = (url: string): string => {
  if (!url.includes('workers.dev')) return url;
  const parts = url.split('/');
  parts[parts.length - 1] = (parts[parts.length - 1] ?? '').replace(/ /g, '%20');
  return parts.join('/');
};

export class UHDMovies extends Extractor {
  public readonly id = 'uhdmovies';
  public readonly label = 'UHDMovies';
  public override readonly lazyExtract = true;

  // Pre-warm the extraction at stream-list time (fire-and-forget) so the Google-Drive direct URL
  // is already cached when the user hits play — otherwise the first play blocks on the full
  // 8-12 request SID→driveleech→CDN chain (often exceeding Stremio's play-timeout → stuck at 0:00).
  public override readonly prewarmLazy = true;

  public override readonly ttl = 3600000; // 1h — Google-Drive-backed URLs last hours
  public override readonly viaMediaFlowProxy = false;

  public constructor(fetcher: Fetcher, logger: winston.Logger) {
    super(fetcher, logger);
  }

  public supports(_ctx: Context, url: URL): boolean {
    return SID_HOSTS.some(h => url.host === h || url.host.endsWith('.' + h)) && url.searchParams.has('sid');
  }

  protected async extractInternal(ctx: Context, url: URL, meta: Meta): Promise<InternalUrlResult[]> {
    const driveleechUrl = await this.resolveSid(ctx, url);
    if (!driveleechUrl) {
      this.logger.info(`UHDMovies: SID resolution failed for ${url.href}`, ctx);
      return [];
    }

    const filePage = await this.getFilePage(ctx, driveleechUrl);
    if (!filePage) {
      this.logger.info(`UHDMovies: no file page for ${driveleechUrl}`, ctx);
      return [];
    }

    const finalUrl = await this.extractFinalUrl(ctx, filePage.$, filePage.origin);
    if (!finalUrl || !(await this.validateUrl(ctx, finalUrl))) {
      this.logger.info(`UHDMovies: no valid final URL from ${driveleechUrl}`, ctx);
      return [];
    }

    return [
      {
        url: new URL(fixWorkersSpaces(finalUrl)),
        format: Format.mp4,
        meta: { ...meta },
      },
    ];
  }

  /** Multi-step WP form POST: SID link → driveleech URL (via meta refresh). */
  private async resolveSid(ctx: Context, sidUrl: URL): Promise<URL | null> {
    // Current "lp" interstitial first; legacy WP form as fallback (some SID hosts still serve it).
    const lpResult = await this.resolveSidLpFlow(ctx, sidUrl).catch(() => null);
    if (lpResult) return lpResult;
    return this.resolveSidLegacyFlow(ctx, sidUrl);
  }

  /**
   * SID flow A: the "lp" interstitial (#lp-land → #lp-s1-form → sc() cookie → ?lp_go=). The s1 hop
   * enforces a ~10s countdown server-side, so this flow takes ~15-20s — acceptable because
   * prewarmLazy fires it at stream-list time.
   */
  private async resolveSidLpFlow(ctx: Context, sidUrl: URL): Promise<URL | null> {
    const origin = sidUrl.origin;
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,*/*' };

    // Step 0: GET sid page → #lp-land form (_lp_http).
    const step0 = await this.fetcher.fetch(ctx, sidUrl, { headers, timeout: 12000 });
    const form0 = this.grabLpForm(step0.data, 'lp-land');
    if (!form0) return null;

    // Step 1: POST _lp_http → #lp-s1-form (_lp_http2/_lp_token/_lp_chain/_lp_hop_index).
    const step1 = await this.fetcher.fetch(ctx, new URL(form0.action, origin), {
      method: 'POST',
      data: new URLSearchParams(form0.fields).toString(),
      headers: { ...headers, 'Referer': sidUrl.href, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    const form1 = this.grabLpForm(step1.data, 'lp-s1');
    if (!form1) return null;

    // Respect the s1 countdown (10s observed; add margin). Bail if the stream deadline is near —
    // the prewarm will retry later.
    if (ctx.streamDeadline && Date.now() > ctx.streamDeadline - 16000) {
      this.logger.info(`UHDMovies: skipping lp flow — stream deadline too close for the s1 timer`, ctx);
      return null;
    }
    await new Promise(sleep => setTimeout(sleep, 12000));

    // Step 2: POST s1 fields → JS sc("<name>","<value>",<mins>) + "?lp_go=<name>" link.
    const step2 = await this.fetcher.fetch(ctx, new URL(form1.action, origin), {
      method: 'POST',
      data: new URLSearchParams(form1.fields).toString(),
      headers: { ...headers, 'Referer': form1.action, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    const step2Text = typeof step2.data === 'string' ? step2.data : String(step2.data);
    const scMatch = step2Text.match(/sc\("([^"]+)",\s*"([^"]+)",\s*\d+\)/);
    if (!scMatch) return null;
    const cookieName = scMatch[1] as string;
    const cookieValue = scMatch[2] as string;
    const goHref = step2Text.match(/lp_go=([a-z0-9-]+)/i)?.[0];
    if (!goHref) return null;

    // Step 3: set the cookie, GET ?lp_go= → JS window.location.replace("<driveseed/driveleech>").
    this.fetcher.setCookie(origin, `${cookieName}=${cookieValue}`);
    const step3 = await this.fetcher.fetch(ctx, new URL(`?${goHref}`, origin), {
      headers: { ...headers, Referer: form1.action }, timeout: 20000,
    });
    const step3Text = typeof step3.data === 'string' ? step3.data : String(step3.data);
    const target = step3Text.match(/window\.location\.replace\(["']([^"']+)["']\)/)?.[1]
      ?? step3Text.match(/https?:\\?\/\\?\/(?:driveseed\.org|driveleech\.net)\\?\/[^\s"']+/)?.[0];
    if (!target) return null;

    try {
      return new URL(target.replace(/\\\//g, '/'));
    } catch {
      return null;
    }
  }

  /** First form whose id starts with `prefix`, with all its input fields. */
  private grabLpForm(html: unknown, prefix: string): { action: string; fields: Record<string, string> } | null {
    const $ = cheerio.load(String(html));
    const form = $(`form[id^="${prefix}"]`).first();
    if (!form.length) return null;
    const action = form.attr('action') ?? '';
    const fields: Record<string, string> = {};
    form.find('input').each((_, el) => {
      const name = $(el).attr('name');
      if (name) fields[name] = $(el).attr('value') ?? '';
    });
    if (!action || Object.keys(fields).length === 0) return null;
    return { action, fields };
  }

  /** Legacy WP form flow (see file header, flow B). */
  private async resolveSidLegacyFlow(ctx: Context, sidUrl: URL): Promise<URL | null> {
    const origin = sidUrl.origin;
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,*/*' };
    try {
      // Step 0: GET sid page → #landing form (_wp_http + action).
      const step0 = await this.fetcher.fetch(ctx, sidUrl, { headers, timeout: 12000 });
      let $ = cheerio.load(step0.data);
      let form = $('#landing');
      let action = form.attr('action');
      const wpHttp = form.find('input[name="_wp_http"]').val();
      if (!action || !wpHttp) return null;
      const step0Url = this.finalUrl(step0, sidUrl);

      // Step 1: POST _wp_http → verification form (_wp_http2 + token + action).
      const step1 = await this.fetcher.fetch(ctx, new URL(action, origin), {
        method: 'POST',
        data: new URLSearchParams({ _wp_http: wpHttp }).toString(),
        headers: { ...headers, 'Referer': step0Url.href, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 12000,
      });
      $ = cheerio.load(step1.data);
      form = $('#landing');
      action = form.attr('action');
      const wpHttp2 = form.find('input[name="_wp_http2"]').val() as string | undefined;
      const token = form.find('input[name="token"]').val() as string | undefined;
      if (!action) return null;
      const step1Url = this.finalUrl(step1, new URL(action, origin));

      // Step 2: POST _wp_http2 + token → JS with dynamic cookie + link.
      const step2Body = new URLSearchParams();
      if (wpHttp2) step2Body.set('_wp_http2', wpHttp2);
      if (token) step2Body.set('token', token);
      const step2 = await this.fetcher.fetch(ctx, new URL(action, origin), {
        method: 'POST',
        data: step2Body.toString(),
        headers: { ...headers, 'Referer': step1Url.href, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 12000,
      });
      const step2Text = step2.data as string;
      const cookieMatch = step2Text.match(/s_343\('([^']+)',\s*'([^']+)'/);
      const linkMatch = step2Text.match(/c\.setAttribute\("href",\s*"([^"]+)"\)/);
      if (!cookieMatch || !linkMatch) return null;
      const cookieName = cookieMatch[1];
      const cookieValue = cookieMatch[2];
      const linkPath = linkMatch[1];
      if (!linkPath) return null;
      const finalLink = new URL(linkPath, origin);
      const step2Url = this.finalUrl(step2, finalLink);

      // Step 3: set dynamic cookie, GET link → meta refresh → driveleech URL.
      this.fetcher.setCookie(origin, `${cookieName}=${cookieValue}`);
      const step3 = await this.fetcher.fetch(ctx, finalLink, { headers: { ...headers, Referer: step2Url.href }, timeout: 12000 });
      $ = cheerio.load(step3.data);
      const refresh = $('meta[http-equiv="refresh"]').attr('content');
      if (!refresh) return null;
      const urlMatch = refresh.match(/url=(.*)/i);
      if (!urlMatch?.[1]) return null;
      const driveleech = urlMatch[1].replace(/["']/g, '').trim();
      try {
        return new URL(driveleech);
      } catch {
        return null;
      }
    } catch (error) {
      this.logger.info(`UHDMovies: SID resolution error: ${(error as Error).message}`, ctx);
      return null;
    }
  }

  /** Follow the driveleech redirect URL to the final file page (handles JS window.location.replace).
   *  Returns null for known-broken redirect targets (uhdmovies.mov "Coming Soon" challenge). */
  private async getFilePage(ctx: Context, driveleechUrl: URL): Promise<{ $: cheerio.CheerioAPI; origin: string } | null> {
    if (driveleechUrl.hostname.includes('uhdmovies.mov')) {
      return null;
    }
    const headers = { 'User-Agent': UA, 'Accept': 'text/html,*/*' };
    try {
      let resp = await this.fetcher.fetch(ctx, driveleechUrl, { headers, timeout: 12000 });
      let $ = cheerio.load(resp.data);
      const script = $('script').html() ?? '';
      const jsRedirect = script.match(/window\.location\.replace\(["']([^"']+)["']\)/);
      if (jsRedirect?.[1]) {
        const next = new URL(jsRedirect[1], driveleechUrl.origin);
        resp = await this.fetcher.fetch(ctx, next, { headers, timeout: 12000 });
        $ = cheerio.load(resp.data);
      }
      const origin = this.finalUrl(resp, driveleechUrl).origin;
      return { $, origin };
    } catch {
      return null;
    }
  }

  /** Try Resume Cloud → Instant Download → direct-link scan; return the first valid direct URL. */
  private async extractFinalUrl(ctx: Context, $: cheerio.CheerioAPI, origin: string): Promise<string | null> {
    const resume = await this.tryResumeCloud(ctx, $, origin);
    if (resume) return resume;
    const instant = await this.tryInstantDownload(ctx, $);
    if (instant) return instant;
    // Fallback: scan page for any plausible direct link.
    const direct = $('a[href]').toArray()
      .map(el => $(el).attr('href') ?? '')
      .find(href => DIRECT_HOST_RE.test(href));
    return direct ?? null;
  }

  /** Resume Cloud / Cloud Resume Download button → workers.dev direct link (or follow to a page). */
  private async tryResumeCloud(ctx: Context, $: cheerio.CheerioAPI, origin: string): Promise<string | null> {
    const btn = $('a').filter((_, el) => /resume|cloud/i.test($(el).text())).first();
    let href = btn.attr('href');
    if (!href) {
      // last-resort: a direct link already on the page
      href = $('a[href]').toArray().map(el => $(el).attr('href') ?? '').find(h => DIRECT_HOST_RE.test(h));
      return href ? fixWorkersSpaces(href) : null;
    }
    if (DIRECT_HOST_RE.test(href) || href.startsWith('http')) {
      return fixWorkersSpaces(href);
    }
    try {
      const resp = await this.fetcher.fetch(ctx, new URL(href, origin), { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }, timeout: 12000 });
      const $$ = cheerio.load(resp.data);
      const direct = $$('a[href]').toArray().map(el => $$(el).attr('href') ?? '').find(h => DIRECT_HOST_RE.test(h));
      return direct ? fixWorkersSpaces(direct) : null;
    } catch {
      return null;
    }
  }

  /** Instant Download button → direct URL, video-seed wrapper (?url=), /api POST, or CDN redirect. */
  private async tryInstantDownload(ctx: Context, $: cheerio.CheerioAPI): Promise<string | null> {
    const href = $('a').filter((_, el) => /instant/i.test($(el).text())).first().attr('href');
    if (!href) return null;
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      return null;
    }

    // Already a direct URL on the button itself.
    if (DIRECT_HOST_RE.test(parsed.href) || /\.(mp4|mkv)(\?|$)/i.test(parsed.href)) {
      return fixWorkersSpaces(parsed.href);
    }

    const hostname = parsed.hostname;
    const keys = parsed.searchParams.get('url');

    // video-seed.dev/.pro wrapper: ?url= may already hold a direct video URL.
    if (hostname.includes('video-seed.dev') || hostname.includes('video-seed.pro')) {
      const direct = this.extractFromVideoSeed(parsed);
      if (direct) return direct;
    }

    // /api POST (keys + x-token: hostname) → { url }
    if (keys) {
      try {
        const { body, contentType } = buildMultipart({ keys });
        const resp = await this.fetcher.fetch(ctx, new URL('/api', parsed.origin), {
          method: 'POST',
          data: body,
          headers: { 'User-Agent': UA, 'x-token': hostname, 'Content-Type': contentType },
          timeout: 12000,
        });
        const data = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
        if (data?.url) return fixWorkersSpaces(String(data.url));
      } catch {
        /* try next */
      }
    }

    // CDN redirect (cdn.video-gen.xyz / cdn.video-leech.pro) → video-seed wrapper → direct URL.
    // Follow the Instant Download href with redirects; the final URL is often a video-seed.dev
    // wrapper whose ?url= holds the Google-Drive direct link.
    return this.followCdnRedirect(ctx, parsed);
  }

  /** Extract a direct URL from a video-seed.dev/.pro wrapper's ?url= param. */
  private extractFromVideoSeed(url: URL): string | null {
    const videoUrl = url.searchParams.get('url');
    if (!videoUrl) return null;
    const decoded = decodeURIComponent(videoUrl);
    if (DIRECT_HOST_RE.test(decoded) || /\.(mp4|mkv)(\?|$)/i.test(decoded)) {
      return fixWorkersSpaces(decoded);
    }
    return null;
  }

  /** Follow a CDN redirect URL (e.g. cdn.video-gen.xyz) → final video-seed wrapper or direct URL. */
  private async followCdnRedirect(ctx: Context, url: URL): Promise<string | null> {
    try {
      const resp = await this.fetcher.fetch(ctx, url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
        timeout: 12000,
      });
      const finalUrl = this.finalUrl(resp, url);
      if (finalUrl.hostname.includes('video-seed.dev') || finalUrl.hostname.includes('video-seed.pro')) {
        const direct = this.extractFromVideoSeed(finalUrl);
        if (direct) return direct;
      }
      if (DIRECT_HOST_RE.test(finalUrl.href) || /\.(mp4|mkv)(\?|$)/i.test(finalUrl.href)) {
        return fixWorkersSpaces(finalUrl.href);
      }
      // Scan the response body for an embedded direct URL (some CDNs serve HTML/JSON).
      const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data ?? '');
      const bodyMatch = body.match(/https?:\/\/[^\s"'<>]*(?:googleusercontent|workers\.dev|\.r2\.dev)[^\s"'<>]*/i);
      if (bodyMatch) return fixWorkersSpaces(bodyMatch[0]);
      return null;
    } catch {
      return null;
    }
  }

  /** HEAD (fallback ranged GET) the URL to confirm it serves bytes. */
  private async validateUrl(ctx: Context, url: string): Promise<boolean> {
    try {
      const u = new URL(url);
      const h = await this.fetcher.head(ctx, u, { headers: { 'User-Agent': UA, 'Range': 'bytes=0-1' }, timeout: 12000 });
      const status = Number(h['status'] ?? 200);
      if (status >= 200 && status < 400) return true;
    } catch { /* fall through */ }
    try {
      const resp = await this.fetcher.fetch(ctx, new URL(url), { headers: { 'User-Agent': UA, 'Range': 'bytes=0-1' }, timeout: 12000 });
      return resp.status >= 200 && resp.status < 500;
    } catch {
      return false;
    }
  }

  private finalUrl(resp: AxiosResponse, fallback: URL): URL {
    const url = (resp.request as { res?: { responseUrl?: string } } | undefined)?.res?.responseUrl
      ?? (resp.request as { responseURL?: string } | undefined)?.responseURL;
    try {
      return url ? new URL(url) : fallback;
    } catch {
      return fallback;
    }
  }
}
