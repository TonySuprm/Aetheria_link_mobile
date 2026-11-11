import { existsSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import path from 'node:path';
import { Request, Response, Router } from 'express';
import winston from 'winston';
import { DAILYMOTION_METADATA_HEADERS, pickDailymotionMasterHls } from '../extractor/Dailymotion';
import { envGet } from '../utils';
import { DAILYMOTION_APP_HEADERS, fetchDailymotionAppHlsUrl, fetchDailymotionText, rewriteDailymotionMaster } from '../utils/dailymotion';

/**
 * MediaFlow Proxy relay.
 *
 * The add-on co-runs bundled MediaFlow Proxy (MFP) on loopback (start-all.ps1
 * runs both locally). MFP resolves
 * dailymotion / ok.ru / rumble / doodstream / ... into header-injected HLS or
 * plain stream URLs — but loopback is unreachable by Stremio players, and MFP
 * can fetch those CDNs only because it injects the UA/Referer itself.
 *
 * This controller exposes the MFP endpoints under the add-on's own public
 * host (the same origin players already fetch `/stream/*.json` from):
 *
 *   GET  /proxy/*       (hls/mpd manifests, segments, /proxy/stream)
 *   GET  /extractor/*   (extractor/video incl. redirect_stream mode)
 *   GET  /_token_/*     (MFP's encrypted-token form of the same endpoints)
 *
 * MFP rewrites child playlist/segment URIs inside the master playlist to
 * `{base}/_token_{encrypted_token}/proxy/hls/{manifest,segment,...}` (its
 * auth middleware decrypts the token and strips the prefix), so the relay
 * must serve `/_token_/*` too.
 *
 * Two things make the returned manifests playable:
 *
 * 1. The public host is forwarded upstream as `X-Forwarded-Proto` /
 *    `X-Forwarded-Host`. MFP's `public_proxy_base_url` honours those headers,
 *    so every rewritten segment/playlist URL points back at the add-on's
 *    public host (which this controller serves) instead of loopback.
 *
 * 2. The response is passed through verbatim (status, content-type,
 *    content-range, body) so seeking, 206s and 307 extraction redirects work
 *    unchanged.
 *
 * Only `/proxy/*`, `/extractor/*` and `/_token_/*` are relayed — the relay
 * cannot be turned into an open proxy for arbitrary hosts. These paths are
 * exempted from the global rate limit (a playing segment stream easily
 * exceeds 30 req/min).
 */

const DEFAULT_UPSTREAM = 'http://127.0.0.1:8889';

// Hop-by-hop / add-on-internal headers that must not be forwarded upstream.
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'x-request-id',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-for',
  'x-forwarded-port',
  'x-forwarded-scheme',
]);

// Upstream response headers that must not be replayed (express manages them).
const SKIP_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'upgrade',
]);

const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });

const firstForwarded = (value: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(',')[0]?.trim();
  return first || undefined;
};

/**
 * Where can a PLAYER reach the ytdlp bridge's /dm/fetch, given the request the
 * player made to this add-on?
 *   • LAN <ip>:<port> — the add-on was reached directly on its service port;
 *     the gateway (:8787) path-mounts every service under /s/<name>.
 *   • ≥3-label host (service subdomain `aetheria-link-mobile.<zone>` or the
 *     gateway host `aeth.<zone>`) — Cloudflare's tunnel ingress maps
 *     `<service>.<zone>` STRAIGHT to the service port, bypassing the gateway,
 *     so /s/<name> is unreachable there; the ytdlp service's own public
 *     subdomain is the correct target (it also tolerates the /s/ytdlp prefix,
 *     which it strips).
 *   • ≤2-label host (zone apex, localhost dev) — routes at the gateway, so the
 *     /s/<name> path-mount works as-is.
 * YTDLP_PUBLIC_URL overrides everything.
 */
export function ytdlpPublicBase(req: Request): string {
  const override = envGet('YTDLP_PUBLIC_URL');
  if (override) return override.replace(/\/+$/, '');
  const proto = firstForwarded(req.headers['x-forwarded-proto']) || req.protocol;
  const host = String(firstForwarded(req.headers['x-forwarded-host']) || req.headers.host || req.host);
  const hostNoPort = host.split(':')[0] || host;
  const lanDirect = /^[^:]+:\d+$/.test(host) && /^\d+\.\d+\.\d+\.\d+$/.test(hostNoPort);
  const labels = hostNoPort.split('.').filter(Boolean);
  const zone = labels.length >= 3 ? labels.slice(1).join('.') : '';
  if (lanDirect) return `${proto}://${hostNoPort}:8787/s/ytdlp`;
  if (zone) return `https://ytdlp.${zone}`;
  return `${proto}://${host}/s/ytdlp`;
}

/**
 * Dailymotion ladder cap served to players. Default 2160 = full 4K ladder
 * (h264 kept, AV1 dropped by the bridge's filter for player compat). Every dm
 * byte flows through the phone's upload link (measured 2-6 Mbps behind a VPN
 * vs 12-20 Mbps for 1440/2160) — if top-selecting players (mpv/libVLC) stall
 * for minutes before the first frame or rebuffer constantly, lower this:
 * DM_MAX_HEIGHT=1080 starts in seconds, 720 streams rock-solid on slow links.
 */
export function dmMaxHeight(): number {
  const raw = envGet('DM_MAX_HEIGHT');
  const parsed = raw ? parseInt(raw, 10) : 2160;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2160;
}

export class MediaFlowProxyController {
  public readonly router: Router;

  private readonly logger: winston.Logger;

  public constructor(logger: winston.Logger) {
    this.router = Router();
    this.logger = logger;

    const proxyHandler = this.proxy.bind(this);
    // RegExp routes: Express 4 (this project) does not understand the
    // Express 5 `*splat` string syntax — the string form silently 404'd
    // every relayed request. RegExp works on both major versions.
    for (const prefix of [/^\/proxy\//, /^\/extractor\//, /^\/_token_/]) {
      this.router.get(prefix, proxyHandler);
      this.router.head(prefix, proxyHandler);
      this.router.options(prefix, proxyHandler);
    }

    // Play-time Dailymotion resolver: the /stream response hands players this
    // URL (no dailymotion calls are made at stream-resolution time — the CDN
    // sec= token would be stale and the per-link rate limit wasted). When the
    // player requests it, the video is resolved through Dailymotion's mobile
    // app API and served as a REWRITTEN master playlist whose variants stream
    // through the MediaFlow relay (see resolveViaDailymotionAppApi).
    const dmHandler = this.dailymotionResolver.bind(this);
    this.router.get('/dm/:videoId.m3u8', dmHandler);
    this.router.get('/dm/:videoId', dmHandler);
  }

  private upstreamBase(): string {
    // [halcyon patch] the embedded sidecar (same device/network as the
    // dailymotion sec= token) takes precedence over MEDIA_FLOW_PROXY_URL —
    // a re-seed can reset that env to a remote MFP whose IP can never match.
    const nativeBinDir = envGet('AETH_NATIVE_BIN_DIR') || process.env['AETH_NATIVE_BIN_DIR'];
    if (nativeBinDir && existsSync(path.join(nativeBinDir, 'libmediaflow.so'))) {
      return 'http://127.0.0.1:8889';
    }
    const configured = envGet('MEDIA_FLOW_PROXY_URL')?.trim();
    if (!configured) return DEFAULT_UPSTREAM;
    if (configured.startsWith('http://') || configured.startsWith('https://')) return configured;
    return `http://${configured}`;
  }

  /**
   * Play-time Dailymotion resolver (GET /dm/:videoId.m3u8).
   *
   * DEFAULT (mobile app API): resolve the video through Dailymotion's iOS-app GraphQL
   * API (no yt-dlp), fetch the `hlsURL` master with the app User-Agent (the ONLY
   * client class Dailymotion's /cdn/manifest route accepts — browser and MediaFlow's
   * rustls UAs both get 403 there), then serve the master REWRITTEN: every variant
   * URI is re-based onto the MediaFlow HLS proxy (which streams the dmcdn variants +
   * segments with its header injection — verified reachable by MediaFlow, unlike the
   * master host). The player only ever sees plain header-free URLs on this add-on's
   * origin, which is what Samsung Tizen and every other normal player need.
   * DM_MAX_HEIGHT caps the ladder (2160 = full 4K), DM_FLAT=1 (default) keeps only
   * the top variant so playback starts at 4K immediately.
   *
   * FALLBACK (DM app API refused the video): the original MediaFlow metadata path —
   * fetch a fresh `sec=` token via MFP and 302 to the MFP HLS proxy.
   *
   * LEGACY (DM_VIA_YTDLP=1, opt-in): 302 to the on-device ytdlp bridge. Kept behind
   * the kill-switch for deployments that still run one; the public bridge is gone.
   */
  private dailymotionResolver(req: Request, res: Response): void {
    const videoId = String(req.params['videoId'] || '').replace(/\.m3u8$/i, '');
    if (!/^[a-zA-Z0-9_-]{4,32}$/.test(videoId)) {
      res.status(400).end('invalid dailymotion video id');
      return;
    }

    if (envGet('DM_VIA_YTDLP') === '1') {
      const base = ytdlpPublicBase(req);
      const target = `https://www.dailymotion.com/video/${videoId}`;
      const max = dmMaxHeight();
      const maxQ = max && max < 4320 ? `&max=${max}` : '';
      const flatQ = envGet('DM_FLAT') === '0' ? '' : '&flat=1';
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, `${base}/dm/fetch?u=${encodeURIComponent(target)}${maxQ}${flatQ}&b=${encodeURIComponent(base)}`);
      return;
    }

    void this.resolveViaDailymotionAppApi(req, res, videoId);
  }

  /** Mobile-app-API path of `dailymotionResolver` — always terminates the response
   *  (200 rewritten master, or nothing when the caller should fall back). */
  private async resolveViaDailymotionAppApi(req: Request, res: Response, videoId: string): Promise<void> {
    try {
      const hlsUrl = await fetchDailymotionAppHlsUrl(videoId);
      if (hlsUrl) {
        const master = await fetchDailymotionText(hlsUrl);
        if (master && master.status === 200 && master.text.startsWith('#EXTM3U')) {
          const maxHeight = dmMaxHeight();
          const rewritten = rewriteDailymotionMaster({
            master: master.text,
            hlsUrl,
            maxHeight,
            flat: envGet('DM_FLAT') !== '0',
            rewriteUrl: url => this.hlsProxyUrlFor(req, url, DAILYMOTION_APP_HEADERS),
          });
          this.logger.info(`Dailymotion ${videoId}: serving app-API master via MediaFlow (flat=${envGet('DM_FLAT') !== '0'}, maxHeight=${maxHeight})`);
          res.status(200)
            .setHeader('Content-Type', 'application/vnd.apple.mpegurl')
            .setHeader('Cache-Control', 'no-store')
            .end(rewritten);
          return;
        }
        this.logger.warn(`Dailymotion app-API master fetch failed for ${videoId} (status ${master?.status ?? 'none'}) — falling back to the metadata path`);
      } else {
        this.logger.warn(`Dailymotion app-API resolution refused ${videoId} — falling back to the metadata path`);
      }
    } catch (err) {
      this.logger.warn(`Dailymotion app-API resolution error for ${videoId}: ${err instanceof Error ? err.message : err} — falling back to the metadata path`);
    }

    this.resolveViaDailymotionMetadata(req, res, videoId);
  }

  /** Legacy metadata-API path: fresh `sec=` token via MFP, then 302 into the MFP HLS
   *  proxy. Only works while Dailymotion serves cdndirector manifests to MediaFlow's
   *  TLS client (currently 403 E005) — kept as a last-resort fallback. */
  private resolveViaDailymotionMetadata(req: Request, res: Response, videoId: string): void {
    const metadataUrl = new URL(`https://www.dailymotion.com/player/metadata/video/${videoId}`);

    // The manifest `sec=` token is bound to the IP that fetched the metadata.
    // The manifest itself will be fetched BY MediaFlow — so the metadata MUST
    // be fetched through MediaFlow too (its /proxy/stream relays the request
    // from MFP's own IP), otherwise the token is issued to this add-on's IP
    // and MFP's fetch 403s. This is what makes a co-located MFP work.
    const viaProxyUrl = new URL('/proxy/stream', this.upstreamBase());
    viaProxyUrl.searchParams.set('api_password', envGet('MEDIA_FLOW_PROXY_PASSWORD') || 'aetheria-link-secret');
    viaProxyUrl.searchParams.set('d', metadataUrl.href);
    for (const [name, value] of Object.entries(DAILYMOTION_METADATA_HEADERS)) {
      viaProxyUrl.searchParams.set('h_' + name.toLowerCase(), value);
    }

    const fetchMetadata = (url: URL, via: 'mfp' | 'direct') => {
      const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const headers: Record<string, string> = { accept: 'application/json' };
      if (via === 'direct') Object.assign(headers, DAILYMOTION_METADATA_HEADERS);

      const upstream = doRequest(
        url,
        { headers },
        (upstreamRes: IncomingMessage) => {
          if ((upstreamRes.statusCode ?? 500) >= 400) {
            upstreamRes.resume();
            if (via === 'mfp') {
              this.logger.warn(`Dailymotion metadata via MFP HTTP ${upstreamRes.statusCode} — falling back to direct`);
              fetchMetadata(metadataUrl, 'direct');
              return;
            }
            this.logger.warn(`Dailymotion metadata HTTP ${upstreamRes.statusCode} for ${videoId}`);
            res.status(502).end('dailymotion metadata unavailable');
            return;
          }

          let data = '';
          upstreamRes.setEncoding('utf8');
          upstreamRes.on('data', (c: string) => {
            data += c;
          });
          upstreamRes.on('end', () => {
            let master: URL | undefined;
            try {
              master = pickDailymotionMasterHls(JSON.parse(data));
            } catch (e) {
              this.logger.warn(`Dailymotion metadata parse failed for ${videoId}: ${e}`);
            }
            if (!master) {
              if (via === 'mfp' && !res.headersSent) {
                this.logger.warn(`Dailymotion metadata via MFP unusable — falling back to direct`);
                fetchMetadata(metadataUrl, 'direct');
                return;
              }
              res.status(404).end('no dailymotion HLS manifest');
              return;
            }

            res.setHeader('Cache-Control', 'no-store');
            res.redirect(302, this.hlsProxyUrlFor(req, master).href);
          });
          upstreamRes.on('error', () => {
            if (!res.headersSent) res.status(502).end('dailymotion metadata error');
          });
        },
      );

      upstream.on('error', (err) => {
        this.logger.warn(`Dailymotion metadata request error (${via}) for ${videoId}: ${err.message}`);
        if (via === 'mfp' && !res.headersSent) {
          fetchMetadata(metadataUrl, 'direct');
          return;
        }
        if (!res.headersSent) res.status(502).end('dailymotion metadata error');
      });
      upstream.end();
    };

    fetchMetadata(viaProxyUrl, 'mfp');
  }

  /** MediaFlow HLS-proxy URL for `master`, built on the PUBLIC host the player used
   *  (x-forwarded aware, honours x-forwarded-prefix for reverse-proxied mounts). */
  private hlsProxyUrlFor(req: Request, master: URL, headers: Record<string, string> = DAILYMOTION_METADATA_HEADERS): URL {
    const publicProto = firstForwarded(req.headers['x-forwarded-proto']) || req.protocol;
    const publicHost = firstForwarded(req.headers['x-forwarded-host']) || req.headers.host || req.host;
    const prefix = (firstForwarded(req.headers['x-forwarded-prefix']) || '').replace(/\/+$/, '');

    const url = new URL(`${prefix}/proxy/hls/manifest.m3u8`, `${publicProto}://${publicHost}`);
    const password = envGet('MEDIA_FLOW_PROXY_PASSWORD') || 'aetheria-link-secret';
    url.searchParams.set('api_password', password);
    url.searchParams.set('d', master.href);
    for (const [name, value] of Object.entries(headers)) {
      url.searchParams.set('h_' + name.toLowerCase(), value);
    }
    return url;
  }

  private proxy(req: Request, res: Response): void {
    // CORS preflight from web players (cross-origin Range fetches).
    if (req.method === 'OPTIONS') {
      res.status(204).set({
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      }).end();
      return;
    }

    const upstreamUrl = new URL(req.originalUrl, this.upstreamBase());

    // Mirror exactly what utils/context.ts#resolveHostUrl does so the base
    // MFP rewrites segment URLs into matches the origin players use.
    // req.headers.host (NOT express 4's req.host, which strips the port) so
    // non-default ports survive into MFP's rewritten URLs.
    const publicProto = firstForwarded(req.headers['x-forwarded-proto']) || req.protocol;
    const publicHost = firstForwarded(req.headers['x-forwarded-host']) || req.headers.host || req.host;

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (SKIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
    headers['x-forwarded-proto'] = publicProto;
    headers['x-forwarded-host'] = publicHost;

    const doRequest = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    const agent = upstreamUrl.protocol === 'https:' ? httpsAgent : httpAgent;

    const upstream = doRequest(
      upstreamUrl,
      { method: req.method, agent, headers },
      (upstreamRes: IncomingMessage) => {
        const status = upstreamRes.statusCode ?? 502;
        res.status(status);

        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue;
          if (SKIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
          res.setHeader(name, Array.isArray(value) ? value.join(', ') : value);
        }

        if (req.method === 'HEAD') {
          upstreamRes.resume();
          return;
        }

        upstreamRes.pipe(res);
        upstreamRes.on('error', (err) => {
          this.logger.warn(`MediaFlowProxy upstream stream error: ${err.message}`);
          if (!res.headersSent) {
            res.status(502).end();
          } else {
            res.destroy();
          }
        });
      },
    );

    // Tear down the upstream pull when the player disconnects (seek/stop).
    req.on('close', () => {
      if (!res.writableEnded) {
        upstream.destroy();
      }
    });

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        this.logger.warn(`MediaFlowProxy upstream error: ${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`);
        res.status(502).end('MediaFlow proxy upstream error');
      } else {
        res.destroy();
      }
    });

    upstream.end();
  }
}
