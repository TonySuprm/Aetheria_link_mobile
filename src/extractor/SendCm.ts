// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck -- the Puppeteer page.evaluate callbacks execute in a browser context (document/window) which is not part of the Node tsconfig lib
import * as cheerio from 'cheerio';
import winston from 'winston';
import { Context, Format, InternalUrlResult, Meta } from '../types';
import { envGet, Fetcher, getHeadfulBrowser, stealthPage } from '../utils';
import { Extractor } from './Extractor';

const PUPPETEER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// send.cm / send.now are XFileSharing-style hosters. send.cm serves a download2 form directly;
// send.now gates the download behind a Cloudflare Turnstile "Security verification" (op=download1),
// then a download2 step. The plain-HTTP flow below handles send.cm; for send.now (or when send.cm
// is challenged) we fall back to a Puppeteer pass that lets Turnstile solve and follows the
// download1 → download2 → direct-link chain.
export class SendCm extends Extractor {
  public override readonly id = 'sendcm';

  public override readonly label = 'SendCm';

  public override readonly ttl = 900000; // 15m

  // send.cm/send.now are behind Cloudflare (403 → FlareSolverr → got-scraping → Puppeteer),
  // taking 10-15s per extraction. Eager extraction blocks the stream response past the 18s deadline,
  // losing all of a source's results (e.g. MkvHub's send.cm links). Lazy + prewarm defers the
  // slow CF-bypass to play time (like UHDMovies), so the stream list returns immediately with
  // /extract/ proxy URLs while the real extraction fires in the background to warm the cache.
  public override readonly lazyExtract = true;
  public override readonly prewarmLazy = true;

  public constructor(fetcher: Fetcher, logger: winston.Logger) {
    super(fetcher, logger);
  }

  public override supports(_ctx: Context, url: URL): boolean {
    return /send\.cm|sendcm|send\.now/.test(url.host);
  }

  protected override async extractInternal(ctx: Context, url: URL, meta: Meta): Promise<InternalUrlResult[]> {
    const headers = { Referer: url.href };

    const html = await this.fetcher.text(ctx, url, { headers }).catch(() => '');
    if (html) {
      const direct = this.extractDirectLink(html);
      if (direct) {
        return this.toResult(direct, meta, url);
      }

      // If this is a plain XFileSharing download2 page (no Turnstile), do the form POST.
      const isTurnstileGate = /cf-turnstile|turnstile/i.test(html);
      if (!isTurnstileGate) {
        const result = await this.extractViaDownload2Form(ctx, url, html);
        if (result) {
          return result;
        }
      }
    }

    // Turnstile-gated (send.now) or the HTTP path failed entirely → Puppeteer fallback.
    if (envGet('PUPPETEER_EXECUTABLE_PATH')) {
      const direct = await this.extractViaPuppeteer(ctx, url.href).catch(() => undefined);
      if (direct) {
        return this.toResult(direct, meta, url);
      }
    }

    return [];
  }

  // XFileSharing download2 form POST (works for send.cm without a captcha).
  private async extractViaDownload2Form(ctx: Context, url: URL, html: string): Promise<InternalUrlResult[] | undefined> {
    const $ = cheerio.load(html);
    const form = $('form[name="F1"], form[action]').first();
    const formAction = form.attr('action');
    const postUrl = formAction ? new URL(formAction, url.href) : url;

    const params = new URLSearchParams();
    params.set('op', 'download2');
    params.set('referer', url.href);
    params.set('method_free', '');
    params.set('method_premium', '');
    form.find('input').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') ?? '';
      if (name && !['method_free', 'method_premium', 'referer'].includes(name)) {
        params.set(name, value);
      }
    });

    const postHeaders = {
      'Referer': url.href,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const responseHtml = await this.fetcher.textPost(ctx, postUrl, params.toString(), { headers: postHeaders }).catch(() => '');
    if (!responseHtml) {
      return undefined;
    }

    const link = this.extractDirectLink(responseHtml);
    return link ? this.toResult(link, {}, url) : undefined;
  }

  // Drive send.now's download1 (Turnstile) → download2 → direct link in a real browser.
  // Headful is REQUIRED: the "Download Challenge" Turnstile gate never auto-solves in headless,
  // but auto-passes in a visible Chrome (same behavior as HDEncode's reveal and ImdbSu's player).
  private async extractViaPuppeteer(ctx: Context, url: string): Promise<string | undefined> {
    const browser = await getHeadfulBrowser(this.logger);
    const page = await browser.newPage();
    try {
      await stealthPage(page);
      await page.setUserAgent(PUPPETEER_UA);
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

      // Let Turnstile solve (it auto-submits via data-callback in most cases), then advance
      // download1 → download2. Poll for either a download2 form or a direct video link.
      const deadline = Date.now() + 35000;
      let stage: 'download1' | 'download2' | 'direct' = 'download1';
      while (Date.now() < deadline) {
        const body = await page.content();
        if (/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|webm|avi|mov|m4v)[^\s"'<>]*/i.test(body)) {
          stage = 'direct';
          break;
        }
        if (/op=["']?download2/i.test(body)) {
          stage = 'download2';
          break;
        }
        // nudge the F1 form (download1) forward once Turnstile has populated its token
        await page.evaluate(() => {
          const f = document.querySelector('form[name="F1"]');
          if (f) f.submit();
        }).catch(() => undefined);
        await new Promise(r => setTimeout(r, 2000));
      }

      const directFrom = (html: string) => html.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|webm|avi|mov|m4v)[^\s"'<>]*/i)?.[0];

      if (stage === 'direct') {
        return directFrom(await page.content());
      }

      if (stage === 'download2') {
        // The download2 page may already show the direct link, or require one more submit.
        const direct = directFrom(await page.content());
        if (direct) {
          return direct;
        }
        await page.evaluate(() => {
          const f = document.querySelector('form[name="F1"]');
          if (f) f.submit();
        }).catch(() => undefined);
        await new Promise(r => setTimeout(r, 4000));
        return directFrom(await page.content());
      }

      return undefined;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private extractDirectLink(html: string): string | undefined {
    // Direct video container link inside an anchor or JS string.
    const containerMatch = html.match(/https?:\/\/[^\s"'<>]*\.(?:mp4|mkv|webm|avi|mov|m4v)[^\s"'<>]*/i);
    if (containerMatch) {
      return containerMatch[0];
    }

    // meta refresh or window.location redirect carrying the download URL — but only accept
    // destinations on the same hoster or a known CDN, to avoid false matches on ad/analytics URLs
    // (e.g. send.now's "?op=upload_result" upload landing page was previously captured wrongly).
    const redirectMatch = html.match(/(?:url=|location(?:\.href)?\s*=|window\.open\()\s*['"]?(https?:\/\/[^\s'"<>]+)/i);
    if (redirectMatch && /send\.|\/d\/|\/download|cdn|storage|\.mp4|\.mkv/i.test(redirectMatch[1])) {
      return redirectMatch[1];
    }

    // Any send.cm download href present in the markup.
    const hrefMatch = html.match(/href\s*=\s*["'](https?:\/\/[^\s"'<>]*send\.cm[^\s"'<>]*)["']/i);
    if (hrefMatch) {
      return hrefMatch[1];
    }

    return undefined;
  }

  private toResult(link: string, meta: Meta, url: URL): InternalUrlResult[] {
    let resolved: URL;
    try {
      resolved = new URL(link);
    } catch {
      return [];
    }

    const isVideo = /\.(mp4|mkv|webm|avi|mov|m4v)(\?|$)/i.test(resolved.pathname);

    return [{
      url: resolved,
      format: isVideo ? Format.mp4 : Format.unknown,
      label: 'SendCm',
      meta: { ...meta, extractorId: this.id, referer: url.href },
      requestHeaders: { Referer: url.href },
    }];
  }
}
