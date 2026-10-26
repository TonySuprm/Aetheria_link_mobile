import { Request, Response, Router } from 'express';
import { IncomingMessage, get as httpGet } from 'node:http';
import { ContentType } from 'stremio-addon-sdk';
import winston from 'winston';
import { Source } from '../source';
import { Context } from '../types';
import { contextFromRequestAndResponse, envGet, envIsProd, Id, ImdbId, isSourceDisabled, KitsuId, StreamResolver, TmdbId } from '../utils';
import { dmMaxHeight, ytdlpPublicBase } from './MediaFlowProxyController';

interface InFlightResolution {
  streams: import('stremio-addon-sdk').Stream[];
  ttl: number | undefined;
}

/**
 * Hard cap on how long sources may keep running in the background AFTER the response has been sent.
 * The stream response is returned at the STREAM_MAX_MS deadline with whatever sources finished by
 * then; sources still running are NOT aborted (so they warm the 12h source cache and appear on the
 * next request — previously they were cancelled on send and slow sources never appeared). This cap
 * ensures a truly hung source (e.g. a stuck Cloudflare fallback) eventually dies instead of
 * scraping indefinitely during playback.
 */
const STREAM_BACKGROUND_MAX_MS = (() => {
  const raw = envGet('STREAM_BACKGROUND_MAX_MS');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
})();

export class StreamController {
  public readonly router: Router;

  private readonly logger: winston.Logger;
  private readonly sources: Source[];
  private readonly streamResolver: StreamResolver;

  // In-flight resolution dedup keyed by `${type}:${rawId}`. Concurrent requests for the same title
  // share one resolution Promise instead of queuing behind a lock — the second request returns as
  // soon as the first completes (and benefits from the partial-results / cache-fill behaviour in
  // StreamResolver). Cleared once the shared promise settles.
  private readonly inFlight = new Map<string, Promise<InFlightResolution>>();
  private readonly progress = new Map<string, { completed: number, total: number, label: string, streams?: import('stremio-addon-sdk').Stream[] }>();
  // dailymotion ids already warm-requested (30min dedupe so /stream retries
  // and Stremio re-polls don't burn extra resolves against the rate limit)
  private readonly dmWarmAt = new Map<string, number>();

  public constructor(logger: winston.Logger, sources: Source[], streams: StreamResolver) {
    this.router = Router();

    this.logger = logger;
    this.sources = sources;
    this.streamResolver = streams;

    this.router.get('/stream/:type/:id.json', this.getStream.bind(this));
    this.router.get('/:config/stream/:type/:id.json', this.getStream.bind(this));
    this.router.get('/progress/:type/:id.json', this.getProgress.bind(this));
    this.router.get('/:config/progress/:type/:id.json', this.getProgress.bind(this));
  }

  private async getStream(req: Request, res: Response) {
    const requestType: ContentType | 'anime' = (req.params['type'] || '') as ContentType | 'anime';
    const rawId: string = req.params['id'] as string || '';

    let id: Id;
    if (rawId.startsWith('tmdb:')) {
      id = TmdbId.fromString(rawId.replace('tmdb:', ''));
    } else if (rawId.startsWith('tt')) {
      id = ImdbId.fromString(rawId);
    } else if (rawId.startsWith('kitsu:')) {
      id = KitsuId.fromString(rawId.replace('kitsu:', ''));
    } else {
      res.status(400).send(`Unsupported ID: ${rawId}`);

      return;
    }

    // Aetheria's anime sources declare 'series' / 'movie' content types. Stremio clones that
    // send type 'anime' (common for Kitsu-based anime catalogs) would otherwise find no
    // matching sources and return zero streams.
    let type: ContentType = requestType as ContentType;
    if (requestType === 'anime') {
      type = 'series';
    }

    let ctx;
    try {
      ctx = contextFromRequestAndResponse(req, res);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }

    // Own the request's abort lifecycle. The signal propagates through ctx into every Fetcher
    // call (axios `signal`) so that, once we have a response to send (or the client gave up), all
    // still-running source scrapes are cancelled instead of lingering in the background and
    // hammering external sites / spawning Puppeteer during playback.
    const abortController = new AbortController();
    ctx.signal = abortController.signal;
    // Abort only when the client drops the connection BEFORE the response is sent. After the
    // response is on the wire we want slow sources to keep running up to STREAM_BACKGROUND_MAX_MS
    // so they warm the source cache. The previous abort-on-finish behaviour killed them at the same
    // moment the response was sent, leaving the cache cold and causing Absinth/Stremio clones to
    // see empty/partial results on the first request.
    const onClose = () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    };
    res.on('close', onClose);

    this.logger.info(`Search stream for type "${type}" and id "${rawId}" for ip ${ctx.ip}`, ctx);

    const sources = this.sources.filter(source => !isSourceDisabled(ctx.config, source) && source.countryCodes.filter(countryCode => countryCode in ctx.config).length);

    // Dedupe concurrent resolutions for the same title + config: they share one
    // StreamResolver.resolve() call. This avoids a stampede of identical upstream scrapes when
    // Stremio retries/navigates, and lets a second request ride on the first's in-flight results.
    // The config (country checkboxes, MediaFlow settings, disabled sources) is part of the key so
    // requests with different configurations don't share a resolution.
    const configKey = sources.map(source => source.id).sort().join(',');
    const dedupeKey = `${type}:${rawId}:${configKey}`;
    const existing = this.inFlight.get(dedupeKey);
    const resolution: Promise<InFlightResolution> = existing ?? this.startResolution(ctx, sources, type, id, dedupeKey);

    try {
      const { streams, ttl } = await resolution;
      this.logger.info(`[TIMING] StreamController: resolver returned ${streams.length} streams. Sending response...`, { requestId: rawId });
      // extract dm ids BEFORE the direct-URL rewrite (it removes the /dm/<id>.m3u8
      // pattern this extraction matches)
      const dmIds = this.dailymotionIds(streams);
      this.rewriteDailymotionUrls(req, streams);

      if (ttl && envIsProd()) {
        res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttl / 1000)}`);
      }

      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ streams }));
      this.logger.info(`[TIMING] StreamController: res.send() completed`, { requestId: rawId });
      this.warmDailymotion(dmIds);
    } catch (error) {
      // resolve() never throws under normal operation (per-source errors are caught), but guard
      // against unexpected failures so the client always gets a JSON response.
      this.logger.error(`Stream resolution failed for ${rawId}: ${error}`, ctx);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ streams: [] }));
    } finally {
      // The response is on its way. Do NOT abort sources that the deadline left running: letting
      // them finish warms the 12h source cache so the next request returns the complete list (slow
      // sources that miss the deadline would otherwise be cancelled and never cached, so they'd
      // never appear — only fast sources like VixSrc would show). A background safety cap aborts
      // any source still running after STREAM_BACKGROUND_MAX_MS so a hung scrape can't linger.
      res.off('close', onClose);
      setTimeout(() => abortController.abort(), STREAM_BACKGROUND_MAX_MS);
    }
  };

  /**
   * Point dailymotion streams STRAIGHT at the ytdlp bridge, skipping this
   * add-on's /dm 302 hop — one fewer Cloudflare round trip (~2s) before the
   * first frame. The bridge's /dm/fetch serves the same rewritten playlist the
   * 302 target does (and tolerates the /s/ytdlp prefix). Kill-switch
   * DM_VIA_YTDLP=0 restores the /dm resolver URLs untouched.
   */
  private rewriteDailymotionUrls(req: Request, streams: import('stremio-addon-sdk').Stream[]): void {
    if (envGet('DM_VIA_YTDLP') === '0') return;
    const base = ytdlpPublicBase(req);
    const max = dmMaxHeight();
    const maxQ = max && max < 4320 ? `&max=${max}` : '';
    // flat=1: serve the top variant's MEDIA playlist, not the master — serial
    // players (mpv/libVLC) open every master rendition (16-40 tunnel round
    // trips); a flat playlist needs playlist → init → segments only
    const flatQ = envGet('DM_FLAT') === '0' ? '' : '&flat=1';
    for (const stream of streams) {
      const url = String(stream.url || '');
      const match = /^(https?:\/\/[^/]+)\/dm\/([a-zA-Z0-9_-]+)\.m3u8(#.*)?$/.exec(url);
      if (!match) continue;
      const target = `https://www.dailymotion.com/video/${match[2]}`;
      stream.url = `${base}/dm/fetch?u=${encodeURIComponent(target)}${maxQ}${flatQ}&b=${encodeURIComponent(base)}${match[3] || ''}`;
    }
  }

  /** Dailymotion video ids referenced by this /stream response (pre-rewrite). */
  private dailymotionIds(streams: import('stremio-addon-sdk').Stream[]): string[] {
    const ids: string[] = [];
    for (const stream of streams) {
      const match = /\/dm\/([a-zA-Z0-9_-]+)\.m3u8/.exec(String(stream.url || ''));
      const id = match?.[1];
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= 2) break;
    }
    return ids;
  }

  /**
   * Fast-start prefetch for dailymotion streams: ask the on-device ytdlp
   * bridge to resolve the video and pre-cache every variant's init+first
   * segments NOW (fire-and-forget), so clicking Play starts in ~1s instead of
   * ~10s — without it every play pays a ~4-5s metadata+master resolve through
   * yt-dlp's networking before the player sees a manifest. On-device only
   * (the bridge lives at 127.0.0.1:10003 next to the addon); deduped 30min.
   */
  private warmDailymotion(ids: string[]): void {
    if (!ids.length) return;
    const onDevice = envGet('AETH_NATIVE_BIN_DIR') || process.env['AETH_NATIVE_BIN_DIR'];
    if (!onDevice) { this.logger.info('[dm-warm] skipped — not on-device'); return; }
    const max = dmMaxHeight();
    const maxQ = max && max < 4320 ? `&max=${max}` : '';
    const base = (envGet('YTDLP_BRIDGE_URL') || 'http://127.0.0.1:10003').replace(/\/+$/, '');
    for (const id of ids) {
      if (Date.now() - (this.dmWarmAt.get(id) || 0) < 30 * 60_000) continue;
      this.dmWarmAt.set(id, Date.now());
      const req = httpGet(`${base}/dm/warm?id=${encodeURIComponent(id)}${maxQ}`, { timeout: 60_000 }, (up: IncomingMessage) => {
        up.resume();
        this.logger.info(`[dm-warm] ${id} → HTTP ${up.statusCode} (${base})`);
      });
      req.on('timeout', () => { this.logger.warn(`[dm-warm] ${id} → timeout`); req.destroy(); });
      req.on('error', (e) => this.logger.warn(`[dm-warm] ${id} → ${e.message}`));
    }
  }

  private startResolution(ctx: Context, sources: Source[], type: ContentType, id: Id, dedupeKey: string): Promise<InFlightResolution> {
    this.progress.set(dedupeKey, { completed: 0, total: sources.length, label: 'Scraping sources...' });

    const promise = this.streamResolver.resolve(
      ctx,
      sources,
      type,
      id,
      (completed: number, total: number, label: string) => {
        const prev = this.progress.get(dedupeKey);
        this.progress.set(dedupeKey, { completed, total, label, ...(prev?.streams && { streams: prev.streams }) });
      },
      // Incremental per-source links: merged into the live progress entry so
      // the app's /progress ticker can render links while sources still run.
      (partialStreams) => {
        const prev = this.progress.get(dedupeKey);
        if (prev) this.progress.set(dedupeKey, { ...prev, streams: partialStreams });
      },
    )
      .then(({ streams, ttl }) => ({ streams, ttl }))
      .finally(() => {
        this.inFlight.delete(dedupeKey);
        // Retain progress for a short window so trailing polling requests don't instantly show empty state
        setTimeout(() => this.progress.delete(dedupeKey), 20000);
      });

    this.inFlight.set(dedupeKey, promise);
    return promise;
  };

  private async getProgress(req: Request, res: Response) {
    const rawId: string = req.params['id'] as string || '';
    const requestType: ContentType | 'anime' = (req.params['type'] || '') as ContentType | 'anime';

    let type: ContentType = requestType as ContentType;
    if (requestType === 'anime') {
      type = 'series';
    }

    let ctx;
    try {
      ctx = contextFromRequestAndResponse(req, res);
    } catch {
      res.json({ completed: 1, total: 1, label: 'Unknown' });
      return;
    }

    const sources = this.sources.filter(source => !isSourceDisabled(ctx.config, source) && source.countryCodes.filter(countryCode => countryCode in ctx.config).length);
    const configKey = sources.map(source => source.id).sort().join(',');
    const dedupeKey = `${type}:${rawId}:${configKey}`;

    const prog = this.progress.get(dedupeKey);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (prog) {
      res.json(prog);
    } else {
      res.json({ completed: sources.length, total: sources.length, label: 'Completed' });
    }
  }
}
