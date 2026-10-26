import * as cheerio from 'cheerio';
import winston from 'winston';
import { BlockedError, NotFoundError, TooManyRequestsError } from '../error';
import { Context, Format, InternalUrlResult, Meta, NonEmptyArray } from '../types';
import { Fetcher, guessHeightFromPlaylist } from '../utils';
import { Extractor } from './Extractor';

export class VidSrc extends Extractor {
  public readonly id = 'vidsrc';

  public readonly label = 'VidSrc';

  public override readonly ttl: number = 10800000; // 3h

  private readonly domains: NonEmptyArray<string>;

  public constructor(fetcher: Fetcher, logger: winston.Logger, domains: NonEmptyArray<string>) {
    super(fetcher, logger);

    this.domains = domains;
  }

  public supports(_ctx: Context, url: URL): boolean {
    return null !== url.host.match(/vidsrc|vsrc|vsembed/);
  }

  protected async extractInternal(ctx: Context, url: URL, meta: Meta): Promise<InternalUrlResult[]> {
    // While this is a crappy thing to do, they seem to be blocking overly strict IMO
    const randomIp = `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    const newCtx = { ...ctx, ip: randomIp };

    return this.extractUsingRandomDomain(newCtx, url, meta, [...this.domains]);
  };

  private async extractUsingRandomDomain(ctx: Context, url: URL, meta: Meta, domains: string[]): Promise<InternalUrlResult[]> {
    if (domains.length === 0) {
      throw new NotFoundError('All VidSrc domains exhausted');
    }

    const domainIndex = Math.floor(Math.random() * domains.length);
    const [domain] = domains.splice(domainIndex, 1) as [string];

    const newUrl = new URL(url);
    newUrl.hostname = domain;

    let html: string;
    try {
      html = await this.fetcher.text(ctx, newUrl, { queueLimit: 1 });
    } catch (error) {
      if (domains.length && (error instanceof TooManyRequestsError || error instanceof BlockedError || error instanceof NotFoundError)) {
        return this.extractUsingRandomDomain(ctx, url, meta, domains);
      }
      throw error;
    }

    const $ = cheerio.load(html.replace(/<!--/g, '').replace(/-->/g, '')); // server HTML is commented-out

    // The iframe's src is injected by the page's JS bundle on the current VidSrc build — a plain
    // HTTP fetch sees an iframe without src (or no iframe at all, e.g. block pages). Treat both as
    // a dead domain and fall through to the next one instead of crashing on undefined.
    const iframeSrc = $('#player_iframe').attr('src');
    if (!iframeSrc) {
      if (domains.length) {
        return this.extractUsingRandomDomain(ctx, url, meta, domains);
      }
      throw new NotFoundError('No player iframe found (VidSrc pages now build the player with JS)');
    }
    const iframeUrl = new URL(iframeSrc.replace(/^\/\//, 'https://'));
    const title = $('title').text().trim();

    const servers = $('.server')
      .map((_i, el) => ({ serverName: $(el).text(), dataHash: $(el).data('hash') }))
      .toArray()
      .filter(({ serverName }) => serverName === 'CloudStream Pro');

    if (servers.length === 0) {
      if (domains.length) {
        return this.extractUsingRandomDomain(ctx, url, meta, domains);
      }
      throw new NotFoundError('No CloudStream Pro server found');
    }

    return Promise.all(
      servers.map(async ({ serverName, dataHash }) => {
        const rcpUrl = new URL(`/rcp/${dataHash}`, iframeUrl.origin);
        const iframeHtml = await this.fetcher.text(ctx, rcpUrl, { headers: { Referer: newUrl.origin } });
        const srcMatch = iframeHtml.match(`src:\\s?'(.*)'`);
        if (!srcMatch) throw new NotFoundError();

        const srcPath = srcMatch[1] as string;
        const playerUrl = new URL(srcPath, iframeUrl.origin);
        const playerHtml = await this.fetcher.text(ctx, playerUrl, { headers: { Referer: rcpUrl.href } });

        let m3u8UrlStr = await this.extractM3u8Url(ctx, playerHtml, playerUrl);
        if (!m3u8UrlStr) {
          throw new NotFoundError('No stream URL found in player HTML');
        }

        const m3u8Url = new URL(m3u8UrlStr);

        return {
          url: m3u8Url,
          format: Format.hls,
          label: serverName,
          meta: {
            ...meta,
            height: await guessHeightFromPlaylist(ctx, this.fetcher, m3u8Url, { headers: { Referer: playerUrl.href } }),
            title,
            referer: playerUrl.href,
          },
        };
      }),
    );
  }

  private async extractM3u8Url(
    ctx: Context,
    playerHtml: string,
    playerUrl: URL,
  ): Promise<string | undefined> {
    // New VidSRC/CloudStream player uses `var master_urls = "<url> or <fallback>"`, where each
    // URL contains a `__TOKEN__` placeholder that must be replaced via `/generate.php`.
    const masterMatch = playerHtml.match(/master_urls\s*=\s*["'](https?:\/\/[^"']+)["']/i);
    const masterRaw = masterMatch?.[1];
    if (masterRaw) {
      let raw = masterRaw.trim();
      if (raw.includes(' or ')) {
        const parts = raw.split(' or ');
        raw = parts[0]!.trim();
      }
      return this.resolveToken(ctx, playerHtml, raw, playerUrl);
    }

    // Legacy CloudStream paths: `{v#}` hostname placeholder.
    const legacyMatch = playerHtml.match(/(https:\/\/[^"']*?{v\d}.*?)\s+or/i);
    if (legacyMatch?.[1]) {
      return legacyMatch[1].replace(/{v\d}/g, playerUrl.host);
    }

    // Direct `.m3u8` URLs, possibly with a token placeholder.
    const directMatch = playerHtml.match(/https:\/\/[^"']*\.m3u8[^"']*/i);
    if (directMatch?.[0]) {
      return this.resolveToken(ctx, playerHtml, directMatch[0], playerUrl);
    }

    return undefined;
  }

  private async resolveToken(
    ctx: Context,
    playerHtml: string,
    m3u8Url: string,
    playerUrl: URL,
  ): Promise<string> {
    if (!m3u8Url.includes('__TOKEN__')) return m3u8Url;

    const tokenGenMatch = playerHtml.match(/\$\.get\("([^"]+generate\.php[^"]*)"/i)
      ?? playerHtml.match(/["'](https?:\/\/[^"']+generate\.php[^"']*)["']/i);
    let tokenGenUrl = tokenGenMatch?.[1];
    if (!tokenGenUrl) return m3u8Url;

    // Support protocol-relative token URLs.
    if (tokenGenUrl.startsWith('//')) tokenGenUrl = `https:${tokenGenUrl}`;
    const tokenUrl = new URL(tokenGenUrl, playerUrl.href);
    try {
      const token = await this.fetcher.text(ctx, tokenUrl, { headers: { Referer: playerUrl.href }, timeout: 5000 });
      return m3u8Url.replace(/__TOKEN__/g, token.trim());
    } catch {
      return m3u8Url;
    }
  }
}
