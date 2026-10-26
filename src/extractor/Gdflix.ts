import * as cheerio from 'cheerio';
import winston from 'winston';
import { Context, Format, InternalUrlResult, Meta } from '../types';
import { Fetcher } from '../utils';
import { Extractor } from './Extractor';

// GDFlix (`gdflix.dev/file/<id>`) is a Cloudflare-fronted file host used by KatMovieHD, UHDMovies
// and WorldFree4u. The file page hides its download links in an HTML COMMENT (cheerio's `$('a')`
// never sees them), in one of two shapes:
//
//   current:  `fastcdn-dl.pages.dev/?url=<direct>`  — the `url` param holds the real file URL
//             (a tokened `pub-<id>.r2.dev/...` R2 bucket link, or a Google Drive
//             `video-downloads.googleusercontent.com` link in older layouts).
//   legacy:   `instant.busycdn.xyz/...` interstitial which 302-redirects to the same pages.dev
//             wrapper (captured from its Location header).
//
// Both inner URL flavors need a browser UA. r2.dev serves Range natively (206 + content-range,
// video/x-matroska) so it is returned DIRECT; the google video-downloads URL 400s on Range, so it
// is routed through the addon's /relay (plain-GET + local-slice profile), which injects a browser
// UA and serves the player's Range locally.
const BUSYCDN_RE = /instant\.busycdn\.xyz\//i;
const PAGES_WRAPPER_RE = /https?:\/\/[a-z0-9-]+\.pages\.dev\/\?url=([^"'\s>]+)/i;
const GOOGLE_VIDEO_RE = /video-downloads\.googleusercontent\.com\//i;

export class Gdflix extends Extractor {
  public override readonly id = 'gdflix';

  public override readonly label = 'GDFlix';

  // The r2.dev/google URL is freshly generated per file-page visit (tokened) and is short-lived;
  // keep the resolved result cached only briefly so a stale token doesn't linger.
  public override readonly ttl = 300000; // 5m

  // Lazy extraction: the gdflix chain (FlareSolverr for the CF-403 file page + redirect hops)
  // takes ~10-15s. Awaiting it inside StreamResolver's per-source `Promise.all` would block ALL of
  // that source's UrlResults (even the fast ones) past the stream-response deadline, dropping
  // every stream from the list. Returning an instant /extract/ proxy defers the real resolution to
  // play-time (ExtractController), so the stream appears in the list immediately and the direct
  // URL is resolved fresh on each play (sidestepping its short TTL).
  public override readonly lazyExtract = true;

  // Pre-warm the extraction at stream-list time (fire-and-forget) so the direct URL is already
  // cached when the user hits play — otherwise the first play blocks ~10-15s on FlareSolverr.
  public override readonly prewarmLazy = true;

  public constructor(fetcher: Fetcher, logger: winston.Logger) {
    super(fetcher, logger);
  }

  public override supports(_ctx: Context, url: URL): boolean {
    return /gdflix\./.test(url.host);
  }

  protected override async extractInternal(ctx: Context, url: URL, meta: Meta): Promise<InternalUrlResult[]> {
    // 1. GDFlix file page (Cloudflare 403 → the Fetcher auto-routes through FlareSolverr).
    const html = await this.fetcher.text(ctx, url).catch(() => null);
    if (!html) return [];

    // 2a. Current layout: the pages.dev wrapper is on the page itself — often inside an HTML
    //     comment, so scan the RAW HTML rather than parsed anchors.
    const wrapperMatch = html.match(PAGES_WRAPPER_RE);
    if (wrapperMatch?.[1]) {
      try {
        const inner = new URL(decodeURIComponent(wrapperMatch[1]));
        const result = this.wrapInnerUrl(ctx, inner, meta);
        if (result) return [result];
      } catch { /* fall through to the legacy flow */ }
    }

    // 2b. Legacy layout: busycdn interstitial → HTTP 302 → pages.dev wrapper. Fetch with redirects
    //     disabled so the Location header (carrying the direct URL in its `url` query param) is
    //     captured rather than followed.
    const $ = cheerio.load(html);
    const busyHref = this.firstHref($, BUSYCDN_RE);
    if (busyHref) {
      const redirect = await this.fetcher.fetch(ctx, busyHref, { maxRedirects: 0 }).catch(() => null);
      const location = redirect?.headers?.['location'];
      if (location) {
        try {
          const fastUrl = new URL(Array.isArray(location) ? location[0] : location, busyHref.href);
          const googleHref = fastUrl.searchParams.get('url');
          if (googleHref && GOOGLE_VIDEO_RE.test(googleHref)) {
            const result = this.wrapInnerUrl(ctx, new URL(googleHref), meta);
            if (result) return [result];
          }
        } catch { /* fall through */ }
      }
    }

    // 2c. Last resort: a direct r2.dev/googleusercontent link sitting on the page (commented or not).
    const directMatch = html.match(/https?:\/\/[^\s"'<>]*(?:\.r2\.dev|video-downloads\.googleusercontent\.com)\/[^\s"'<>]+/i);
    if (directMatch?.[0]) {
      try {
        const result = this.wrapInnerUrl(ctx, new URL(directMatch[0]), meta);
        if (result) return [result];
      } catch { /* nothing more to try */ }
    }

    return [];
  }

  /**
   * Build the final result for an inner direct-file URL: r2.dev serves Range natively and is
   * returned as a direct URL; the google video-downloads URL 400s on Range and goes through /relay.
   */
  private wrapInnerUrl(ctx: Context, inner: URL, meta: Meta): InternalUrlResult | undefined {
    if (GOOGLE_VIDEO_RE.test(inner.hostname)) {
      const relay = new URL('/relay', ctx.hostUrl);
      relay.searchParams.set('url', inner.href);
      return {
        url: relay,
        format: Format.unknown,
        isExternal: false,
        notWebReady: true,
        label: this.label,
        meta: { ...meta, extractorId: this.id },
      };
    }

    if (/\.r2\.dev$/i.test(inner.hostname)) {
      return {
        url: inner,
        format: Format.mp4,
        isExternal: false,
        notWebReady: true,
        label: this.label,
        meta: { ...meta, extractorId: this.id },
      };
    }

    return undefined;
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
