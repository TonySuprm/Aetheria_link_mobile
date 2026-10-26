import { Mutex } from 'async-mutex';
import bytes from 'bytes';
import { ContentType, Stream } from 'stremio-addon-sdk';
import winston from 'winston';
import { logErrorAndReturnNiceString } from '../error';
import { ExtractorRegistry } from '../extractor';
import { Source } from '../source';
import { Context, CountryCode, Format, Meta, UrlResult } from '../types';
import { isResolutionExcluded, showErrors, showExternalUrls, isSourceDisabled } from './config';
import { normalizeFilename } from './debrid';
import { envGet, envGetAppName } from './env';
import { HUB_HOST_PATTERN } from './hub';
import { Id } from './id';
import { flagFromCountryCode } from './language';
import { getClosestResolution } from './resolution';

interface ResolveResponse {
  streams: Stream[];
  ttl?: number;
}

/**
 * Direct-playable video file extensions. URLs whose path ends in one of these are raw video files
 * served as-is (with HTTP Range support) — e.g. DramaSuki's dl.dramasuki.xyz goindex host. We must
 * NOT append a #stream_label fragment to such URLs: the host rejects fragmented URLs (403).
 */
const DIRECT_VIDEO_FILE_RE = /\.(mp4|mkv|webm|avi|mov|m4v)(?:$|\?)/i;

const DEAD_LINK_PROBE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Stream URLs that look like direct video files or playlists. We probe these with a fast HEAD
 * request so dead hoster links (common from 4KHDHub / HDHub4u / UHDMovies and many extractors)
 * don't clutter Stremio's results. Time-bounded so we never exceed the Stremio response deadline.
 */
const PROBEABLE_PATH_RE = /\.(m3u8|mp4|mkv|webm|avi|mov|m4v|ts)(?:$|\?)/i;

/**
 * Hard ceiling on how long a single /stream request waits for its sources, in ms. Stremio's client
 * gives up on a stream request after ~20-30s, while Absinth Streamer Cursor waits up to 35s. We race
 * the source batch against this deadline and return whatever has resolved by then. Slow sources
 * keep running in the background and populate the shared cache so the next request returns them.
 */
const MAX_STREAM_MS = (() => {
  const raw = envGet('STREAM_MAX_MS');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 35_000;
})();

/**
 * TTL returned when the response is sent before all sources finished (the deadline fired). A slow
 * source that misses the deadline keeps running in the background to warm the 12h source cache, so
 * the NEXT request returns the complete list. To make Stremio actually re-request (and pick up that
 * warmed list) we must NOT let it cache the incomplete first response for the normal (long) TTL —
 * a short TTL forces a re-fetch within ~30s, by which time the slow sources have cached. Without
 * this, Stremio would cache the VixSrc-only first response for minutes/hours and the other sources
 * would never appear.
 */
const INCOMPLETE_RESPONSE_TTL = 30_000;

export class StreamResolver {
  private readonly logger: winston.Logger;
  private readonly extractorRegistry: ExtractorRegistry;

  public constructor(logger: winston.Logger, extractorRegistry: ExtractorRegistry) {
    this.logger = logger;
    this.extractorRegistry = extractorRegistry;
  }

  public async resolve(
    ctx: Context,
    sources: Source[],
    type: ContentType,
    id: Id,
    onProgress?: (completedSources: number, totalSources: number, label: string) => void,
    onPartial?: (streams: Stream[]) => void
  ): Promise<ResolveResponse> {
    // Publish the response deadline so lazy extractors can bound their prewarm-await by the
    // remaining time — a source that finishes its scrape near the deadline must still return its
    // /extract/ proxy in time, not be blocked 8s past the deadline and dropped from the response.
    ctx.streamDeadline = Date.now() + MAX_STREAM_MS;

    // Reserve the last 5 seconds of the response window for the dead-link filter. Without this,
    // sources routinely consume the full 35s and the filter has no time budget, so dead 4KHDHub /
    // HDHub4u links stay in the response. Sources still run in the background if they miss this
    // earlier cutoff, warming the cache for the next request.
    const sourceDeadlineMs = ctx.streamDeadline - 5000;

    if (sources.length === 0) {
      return {
        streams: [
          {
            name: 'Aetheria Link',
            title: '⚠️ No sources found. Please re-configure the plugin.',
            externalUrl: ctx.hostUrl.href,
          },
        ],
      };
    }

    const streams: Stream[] = [];

    let completedSources = 0;
    let sourceErrorCount = 0;
    const sourceErrorCountMutex = new Mutex();

    let urlResults: UrlResult[] = [];

    const urlResultsCountByCountryCode = new Map<CountryCode, number>();
    const urlResultsCountByCountryCodeMutex = new Mutex();

    const skippedFallbackSources: Source[] = [];

    const handleSource = async (source: Source, countUrlResultsByCountryCode: boolean) => {
      try {
        const sourceResults = await source.handle(ctx, type, id);
        this.logger.info(`Source ${source.id} returned ${sourceResults.length} results`, ctx);
        for (const sr of sourceResults) {
          this.logger.info(`Source ${source.id} URL: ${sr.url}`, ctx);
        }
        // Push results incrementally as each extractor completes — do NOT wait for Promise.all
        // before pushing. A slow extractor (e.g. SendCm's FlareSolverr+Puppeteer chain, 10-15s)
        // would otherwise block ALL of a source's results (including fast GDFlix/Mega instant
        // proxies) from being pushed before the stream deadline, causing "0 final streams" even
        // though sources found valid links.
        await Promise.all(
          sourceResults.map(async (sr) => {
            const results = sr.isExternal
              ? [{
                url: sr.url,
                format: Format.unknown,
                isExternal: true,
                notWebReady: sr.notWebReady ?? true,
                error: undefined,
                label: sr.meta.title ?? source.label,
                ttl: source.ttl,
                meta: { sourceLabel: source.label, sourceId: source.id, priority: source.priority, ...sr.meta },
              }]
              : await this.extractorRegistry.handle(ctx, sr.url, { sourceLabel: source.label, sourceId: source.id, priority: source.priority, ...sr.meta }, true);

            for (const urlResult of results) {
              urlResults.push(urlResult);

              if (urlResult.error || !countUrlResultsByCountryCode) {
                continue;
              }

              await urlResultsCountByCountryCodeMutex.runExclusive(() => {
                urlResult.meta?.countryCodes?.forEach((countryCode) => {
                  urlResultsCountByCountryCode.set(countryCode, (urlResultsCountByCountryCode.get(countryCode) ?? 0) + 1);
                });
              });
            }
          }),
        );
      } catch (error) {
        if (ctx.signal?.aborted) {
          return;
        }
        this.logger.warn(`Source ${source.id} threw error: ${error}`, ctx);
        await sourceErrorCountMutex.runExclusive(() => {
          sourceErrorCount++;
        });

        if (showErrors(ctx.config)) {
          streams.push({
            name: envGetAppName(),
            title: [`🔗 ${source.label}`, logErrorAndReturnNiceString(ctx, this.logger, source.id, error)].join('\n'),
            externalUrl: source.baseUrl,
          });
        }
      } finally {
        completedSources++;
        if (onProgress) {
          onProgress(completedSources, sources.length, source.label);
        }
        // Publish the streams resolved SO FAR so the app's /progress poll can
        // render links per source while the scrape is still running (the full
        // response only arrives at the deadline). Partial builds skip the
        // expensive dedup/dead-link passes — the app dedupes by URL anyway.
        if (onPartial) {
          try {
            onPartial(this.buildPartialStreams(urlResults, ctx));
          } catch { /* partial stream snapshot is best-effort */ }
        }
      }
    };

    // Resolve non-fallback sources in parallel extracting all their results
    const sourcePromises = sources.map(async (source) => {
      if (isSourceDisabled(ctx.config, source)) {
        this.logger.info(`Source ${source.id} is disabled by configuration, skipping`, ctx);
        return;
      }
      if (!source.contentTypes.includes(type)) {
        return;
      }

      if (source.useOnlyWithMaxUrlsFound !== undefined) {
        skippedFallbackSources.push(source);
        return;
      }

      await handleSource(source, true);
    });

    // Race the batch against the source deadline (5s before the final response deadline) so the
    // dead-link filter has a guaranteed window. Sources still running when this fires are kept alive
    // by the stream controller up to STREAM_BACKGROUND_MAX_MS so they warm the shared source cache.
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    let mainDeadlineFired = false;
    await Promise.race([
      Promise.all(sourcePromises),
      new Promise<void>((resolve) => {
        raceTimer = setTimeout(() => {
          mainDeadlineFired = true;
          resolve();
        }, Math.max(0, sourceDeadlineMs - Date.now()));
      }),
    ]);
    // Clear the deadline timer when the sources finished first, so it doesn't linger.
    if (raceTimer) {
      clearTimeout(raceTimer);
    }

    // Any sources still pending here are aborted once the controller fires (see StreamController).
    // Swallow rejections defensively so a stray throw can't surface as an unhandled rejection.
    Promise.all(sourcePromises).catch(() => { /* aborted sources resolve via Source.handle() */ });

    // Resolve fallback sources if we didn't get enough results already
    this.logger.info(`[TIMING] Starting fallback source resolution (${skippedFallbackSources.length} fallbacks)`, ctx);
    const skippedFallbackSourcePromises = skippedFallbackSources.map(async (skippedFallbackSource) => {
      const resultCount = urlResults.reduce((accumulator, urlResult) => accumulator + Number(this.arraysIntersect(skippedFallbackSource.countryCodes, /* istanbul ignore next */ urlResult.meta?.countryCodes ?? [])), 0);
      if (resultCount > (skippedFallbackSource.useOnlyWithMaxUrlsFound as number)) {
        return;
      }

      await handleSource(skippedFallbackSource, false);
    });
    // Fallback sources are raced against the source deadline so a slow/hung fallback can never
    // stall the response. Pending fallbacks keep running in the background after the response is
    // sent, up to STREAM_BACKGROUND_MAX_MS.
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackDeadlineFired = false;
    await Promise.race([
      Promise.all(skippedFallbackSourcePromises),
      new Promise<void>((resolve) => {
        fallbackTimer = setTimeout(() => {
          fallbackDeadlineFired = true;
          resolve();
        }, Math.max(0, sourceDeadlineMs - Date.now()));
      }),
    ]);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
    }
    Promise.all(skippedFallbackSourcePromises).catch(() => { /* aborted sources resolve via Source.handle() */ });
    this.logger.info(`[TIMING] Fallback resolution complete`, ctx);

    // Drop confirmed-dead direct links before Stremio sees them. Bounded so a batch of slow
    // hosters does not push us past the client's response deadline. Can be disabled via env var
    // for test suites that don't want real network probes.
    if (envGet('DISABLE_DEAD_LINK_FILTER') !== '1' && envGet('DEAD_LINK_FILTER') !== 'off') {
      urlResults = await this.filterDeadUrls(ctx, urlResults);
    }

    urlResults.sort((a, b) => {
      if (a.error || b.error) {
        return a.error ? -1 : 1;
      }

      if (a.isExternal || b.isExternal) {
        return a.isExternal ? 1 : -1;
      }

      const heightComparison = (b.meta?.height ?? 0) - (a.meta?.height ?? 0);
      if (heightComparison !== 0) {
        return heightComparison;
      }

      const bytesComparison = (b.meta?.bytes ?? 0) - (a.meta?.bytes ?? 0);
      if (bytesComparison !== 0) {
        return bytesComparison;
      }

      const priorityComparison = (b.meta?.priority ?? 0) - (a.meta?.priority ?? 0);
      if (priorityComparison !== 0) {
        return priorityComparison;
      }

      return a.label.localeCompare(b.label);
    });

    const errorCount = urlResults.reduce((count, urlResult) => urlResult.error ? count + 1 : count, sourceErrorCount);
    this.logger.info(`Got ${urlResults.length} url results, including ${errorCount} errors`, ctx);

    // Diagnostic: log every UrlResult that will be considered for Stremio
    for (let i = 0; i < urlResults.length; i++) {
      const ur = urlResults[i];
      if (!ur) {
        continue;
      }
      this.logger.info(`UrlResult[${i}]: label=${ur.label} url=${ur.url.href} isExternal=${ur.isExternal ?? false} error=${ur.error ? 'yes' : 'no'} sourceId=${ur.meta?.sourceId}`, ctx);
    }

    this.logger.info(`[TIMING] Starting stream build (${urlResults.length} url results -> Stremio streams)`, ctx);

    const seenFilenames = new Set<string>();
    streams.push(
      ...urlResults.filter(urlResult => (!urlResult.error || showErrors(ctx.config)) && !isResolutionExcluded(ctx.config, getClosestResolution(urlResult.meta?.height)))
        .filter((urlResult, index, self) => {
          // Remove duplicate URLs
          const isDup = index !== self.findIndex(t => t.url.href === urlResult.url.href);
          if (isDup) {
            this.logger.info(`Dedup: dropping duplicate stream #${index} url=${urlResult.url.href} label=${urlResult.label}`, ctx);
          }
          return !isDup;
        })
        .filter((urlResult) => {
          // Cross-source dedup by normalized filename.
          // Each source already returns only 1 hoster per file (NitroFlare preferred),
          // but the same file from different sources (1DDL, RapidMoviez, DDLValley)
          // still needs dedup here. We normalize the filename from the hoster URL
          // (extracted from the extract proxy's `url` query param) and keep only
          // the first occurrence. Results are sorted by height desc then bytes desc,
          // so the first is the best quality. Different encodes (x265, x264, HDR,
          // REMUX) have different filenames and are NOT deduped.
          let filename = '';
          try {
            const hosterUrlStr = urlResult.url.searchParams.get('url')
              || urlResult.url.searchParams.get('d');
            const hosterUrl = hosterUrlStr ? new URL(hosterUrlStr) : urlResult.url;
            filename = normalizeFilename(hosterUrl);
          } catch { /* skip filename dedup for non-extract URLs */ }

          // Only dedup by filename if we extracted a meaningful one (length > 5
          // to skip short/empty filenames from hosters like RapidRAR that have
          // no filename in the URL — those are already handled by exact-URL dedup).
          if (filename.length > 5) {
            if (seenFilenames.has(filename)) {
              this.logger.info(`Dedup: dropping cross-source duplicate file (${filename}) label=${urlResult.label} sourceId=${urlResult.meta?.sourceId}`, ctx);
              return false;
            }
            seenFilenames.add(filename);
          }
          return true;
        })
        .map(urlResult => ({
          ...this.buildUrl(urlResult),
          name: this.buildName(ctx, urlResult),
          title: this.buildTitle(ctx, urlResult),
          behaviorHints: {
            bingeGroup: `aetheria-link-${urlResult.meta?.sourceId}-${urlResult.meta?.extractorId}-${urlResult.meta?.countryCodes?.join('_')}`,
            ...(urlResult.format !== Format.mp4 && urlResult.notWebReady !== false && { notWebReady: true }),
            ...((urlResult.requestHeaders !== undefined || urlResult.meta?.referer !== undefined) && {
              ...((ctx.config.mediaFlowProxyUrl && urlResult.url.href.includes(ctx.config.mediaFlowProxyUrl))
                ? {}
                : {
                  notWebReady: true,
                  proxyHeaders: { request: { ...urlResult.requestHeaders, ...(urlResult.meta?.referer ? { Referer: urlResult.meta.referer } : {}) } },
                }),
            }),
            ...(urlResult.meta?.bytes && { videoSize: urlResult.meta.bytes }),
          },
        })),
    );

    this.logger.info(`[TIMING] Stream build complete. ${streams.length} final streams. Returning response now.`, ctx);

    // If the deadline fired (not all sources finished), the response is incomplete — slow sources
    // are still warming the cache in the background. Return a short TTL so Stremio re-requests soon
    // and picks up the now-complete, cached list instead of caching the partial first response.
    const incomplete = mainDeadlineFired || fallbackDeadlineFired;
    const ttl = incomplete
      ? INCOMPLETE_RESPONSE_TTL
      : (sourceErrorCount === 0 ? this.determineTtl(urlResults) : undefined);

    return {
      streams,
      ...(ttl && { ttl }),
    };
  };

  private arraysIntersect<T>(arr1: T[], arr2: T[]): boolean {
    return arr1.filter(item => arr2.includes(item)).length > 0;
  };

  /**
   * Snapshot of the streams resolved so far, in the exact shape the final
   * response uses (same name/title/URL builders) minus the cross-source
   * dedup, resolution-exclusion re-sort and dead-link probe. Only successful,
   * non-error results are included; exact-duplicate URLs collapse to one.
   */
  private buildPartialStreams(urlResults: UrlResult[], ctx: Context): Stream[] {
    const seenUrls = new Set<string>();
    const partial: Stream[] = [];
    for (const urlResult of urlResults) {
      if (urlResult.error || isResolutionExcluded(ctx.config, getClosestResolution(urlResult.meta?.height))) continue;
      const href = urlResult.url.href;
      if (seenUrls.has(href)) continue;
      seenUrls.add(href);
      partial.push({
        ...this.buildUrl(urlResult),
        name: this.buildName(ctx, urlResult),
        title: this.buildTitle(ctx, urlResult),
      });
      if (partial.length >= 80) break;
    }
    return partial;
  };

  private determineTtl(urlResults: UrlResult[]): number | undefined {
    if (!urlResults.length) {
      return 900000; // 15m
    }

    return Math.min(...urlResults.map(urlResult => urlResult.ttl as number));
  };

  /**
   * Fast, time-bounded HEAD probe that drops clearly dead direct stream URLs (404/410/5xx) before
   * they are handed to Stremio. External links, lazy /extract/ proxies, and URLs that fail for
   * non-HTTP reasons (timeout, network error, 403 geo/header rejection) are kept so we don't
   * throw away slow-but-valid links. The overall probe budget is derived from the stream response
   * deadline; if we are running short on time, probing is skipped entirely.
   */
  private async filterDeadUrls(ctx: Context, urlResults: UrlResult[]): Promise<UrlResult[]> {
    if (urlResults.length === 0) return urlResults;

    const remainingMs = (ctx.streamDeadline ?? Date.now() + 5000) - Date.now();
    // Keep a small safety margin so the HTTP response can still be serialized before the client
    // deadline. If there's at least half a second left, use it for probes.
    const budgetMs = Math.min(5000, remainingMs - 500);
    if (budgetMs <= 0) {
      this.logger.info(`Dead-link filter: skipped (only ${remainingMs}ms remaining)`, ctx);
      return urlResults;
    }

    const probeable = urlResults.filter(ur => this.isProbeableUrl(ur));
    if (probeable.length === 0) return urlResults;

    this.logger.info(`Dead-link filter: probing ${probeable.length} URLs with ${budgetMs}ms budget`, ctx);

    const alive = new Map<UrlResult, boolean>();
    const probes = probeable.map(async (ur) => {
      const isAlive = await this.probeUrlAlive(ctx, ur);
      alive.set(ur, isAlive);
    });

    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(probes),
      new Promise<void>(resolve => { probeTimer = setTimeout(resolve, budgetMs); }),
    ]);
    if (probeTimer) {
      clearTimeout(probeTimer);
    }

    const kept: UrlResult[] = [];
    const dropped: UrlResult[] = [];

    for (const ur of urlResults) {
      if (!this.isProbeableUrl(ur)) {
        kept.push(ur);
        continue;
      }

      const result = alive.get(ur);
      if (result === false) {
        dropped.push(ur);
      } else {
        kept.push(ur);
        if (result === undefined) {
          this.logger.info(`Dead-link filter: keeping ${ur.url.href} (probe did not finish)`, ctx);
        }
      }
    }

    if (dropped.length > 0) {
      this.logger.info(`Dead-link filter: dropped ${dropped.length} dead URLs`, ctx);
      dropped.forEach(ur => this.logger.info(`  dropped: ${ur.url.href}`, ctx));
    }

    return kept;
  }

  /**
   * Resolve the URL that the dead-link probe should actually hit. Internal /extract/ proxies
   * encode the real hoster URL in their `url` query parameter; MediaFlow extractor URLs encode it
   * in `d`. Probing the real hoster page/file lets us drop dead links from 4KHDHub / HDHub4u etc.
   * instead of skipping the proxy and leaving dead results in the Stremio list.
   */
  private getProbeTarget(urlResult: UrlResult): { url: URL; meta?: Meta; requestHeaders?: Record<string, string> } | undefined {
    const path = urlResult.url.pathname.toLowerCase();
    let targetHref: string | null = null;
    let extractedHeaders: Record<string, string> | undefined = undefined;

    if (path.includes('/extract/')) {
      targetHref = urlResult.url.searchParams.get('url');
    } else if (path.endsWith('/extractor/video') || path.includes('/proxy/hls/') || path.includes('/proxy/stream') || path.includes('/proxy/mpd/')) {
      targetHref = urlResult.url.searchParams.get('d');
      if (targetHref) {
        extractedHeaders = {};
        for (const [key, value] of urlResult.url.searchParams.entries()) {
          if (key.toLowerCase().startsWith('h_')) {
            extractedHeaders[key.substring(2)] = value;
          }
        }
      }
    }

    if (targetHref === null) {
      return { url: urlResult.url };
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(targetHref);
    } catch {
      return undefined;
    }

    const target: { url: URL; meta?: Meta; requestHeaders?: Record<string, string> } = { url: targetUrl };
    if (urlResult.meta) target.meta = urlResult.meta;
    
    const combinedHeaders = { ...(urlResult.requestHeaders ?? {}), ...(extractedHeaders ?? {}) };
    if (Object.keys(combinedHeaders).length > 0) {
      target.requestHeaders = combinedHeaders;
    }

    return target;
  }

  private isProbeableUrl(urlResult: UrlResult): boolean {
    if (urlResult.error || urlResult.isExternal || urlResult.ytId) return false;
    const path = urlResult.url.pathname.toLowerCase();
    // Internal extract proxies carry the real hoster URL in a query parameter.
    if (path.includes('/extract/') || path.endsWith('/extractor/video') || path.includes('/proxy/hls/') || path.includes('/proxy/stream') || path.includes('/proxy/mpd/')) {
      return this.getProbeTarget(urlResult) !== undefined;
    }
    if (PROBEABLE_PATH_RE.test(path)) return true;
    return urlResult.format === Format.hls || urlResult.format === Format.mp4;
  }

  private async probeUrlAlive(ctx: Context, urlResult: UrlResult): Promise<boolean> {
    const target = this.getProbeTarget(urlResult);
    if (!target) return true;

    // HubDrive/HubCloud/HubCDN pages often return HTTP 200 for dead files, so a HEAD status check
    // is not enough. For those we run the actual HubExtractor synchronously: it returns empty/error
    // when the file page has no HubCloud link / is dead, and a valid result when alive. Runs under
    // its own short timeout; if it times out we keep the link to avoid false positives.
    if (HUB_HOST_PATTERN.test(target.url.hostname)) {
      try {
        const probeCtx: Context = { ...ctx, signal: AbortSignal.timeout(7000), streamDeadline: Date.now() + 7000 };
        const extracted = await this.extractorRegistry.handle(probeCtx, target.url, target.meta ?? {}, false);
        const alive = extracted.length > 0 && extracted.some(r => !r.error);
        this.logger.info(`Dead-link filter: extractor ${target.url.href} -> ${alive ? 'kept' : 'dropped'}`, ctx);
        return alive;
      } catch {
        return true;
      }
    }

    const headers: Record<string, string> = { 'User-Agent': DEAD_LINK_PROBE_UA };
    if (target.meta?.referer) headers['Referer'] = target.meta.referer;
    if (target.requestHeaders) {
      for (const [key, value] of Object.entries(target.requestHeaders)) {
        // Don't let a generic UA override ours; keep other headers (Referer, Origin, etc.)
        if (key.toLowerCase() === 'user-agent') continue;
        headers[key] = value;
      }
    }

    try {
      const headRes = await fetch(target.url.href, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(3000),
        redirect: 'follow',
      });

      if (headRes.status === 405) {
        const getRes = await fetch(target.url.href, {
          method: 'GET',
          headers: { ...headers, Range: 'bytes=0-0' },
          signal: AbortSignal.timeout(3000),
          redirect: 'follow',
        });
        return this.isAliveStatus(getRes.status);
      }

      return this.isAliveStatus(headRes.status);
    } catch {
      // Timeout, DNS failure, TLS error, etc. — don't penalize; keep the link.
      return true;
    }
  }

  private isAliveStatus(status: number): boolean {
    // 404/410 = gone; 5xx = server-side dead. Keep 403/401 (could be missing header/geo) and
    // anything else so we don't drop valid-but-protected links.
    if (status === 404 || status === 410) return false;
    if (status >= 500) return false;
    return true;
  }

  private buildUrl(urlResult: UrlResult): { externalUrl: string } | { url: string } | { ytId: string } {
    /* istanbul ignore if */
    if (urlResult.ytId) {
      return { ytId: urlResult.ytId };
    }

    const finalUrl = new URL(urlResult.url.href);

    // Natively embed metadata specifically so that custom external applications traversing the manifest can track states accurately
    // Network stripping inherently blocks # fragments from transmitting to CDNs and Proxies, preventing all validation crashes effortlessly
    //
    // BUT skip the #stream_label fragment for direct video-file URLs (e.g. DramaSuki's
    // dl.dramasuki.xyz/.../<file>.mkv). Those hosts serve the raw file from a Google-Drive-backed
    // goindex and REJECT any request whose URL carries a # fragment (returning 403). The file
    // extension is already in the path there, so the synthetic label adds nothing useful.
    // External players name the file after the #stream_label fragment, so put the
    // title in every URL the player sees: series as Show.Name-SxxEyy, movies as
    // their full sanitized meta title (quality included). Skipped only for raw
    // direct-video-file URLs — those hosts reject fragmented URLs (403) and their
    // path already names the file. Extract-proxy URLs carry it fine (fragments are
    // client-side and never hit the server).
    const isDirectVideoFile = DIRECT_VIDEO_FILE_RE.test(finalUrl.pathname);
    const rawTitle = urlResult.meta?.title?.trim() ?? '';
    // HLS stays .m3u8; otherwise prefer the release's own extension (".mkv" titles mean the file
    // IS an mkv) and fall back to .mp4.
    const origExt = rawTitle.match(/\.(mkv|mp4|avi|mov|webm|m4v)$/i)?.[1]?.toLowerCase();
    const targetExt = finalUrl.pathname.includes('.m3u8') || finalUrl.pathname.includes('/hls/') || rawTitle.includes('HLS') ? '.m3u8'
      : (origExt ? `.${origExt}` : '.mp4');
    const episodeMatch = rawTitle.match(/(.*?)\sS(\d+)E(\d+)/);
    // Titles often already end in the release's extension ("...CiNEPHiLES.mkv") — strip it so the
    // label doesn't end up ".mkv.mp4"; the extension is re-appended once at the end.
    const stripTrailingExt = (s: string): string => s.replace(/\.(mkv|mp4|avi|mov|webm|m4v)$/i, '');
    const streamLabel = episodeMatch && episodeMatch[1]
      ? stripTrailingExt(`${episodeMatch[1].trim().replace(/[^a-zA-Z0-9]+/g, '.')}-S${episodeMatch[2]}E${episodeMatch[3]}`)
      : stripTrailingExt(rawTitle.replace(/[^a-zA-Z0-9]+/g, '.').replace(/^\.+|\.+$/g, ''));
    if (streamLabel && streamLabel.length > 3 && !isDirectVideoFile) {
      finalUrl.hash = `stream_label=${streamLabel}${targetExt}`;
    }

    if (!urlResult.isExternal) {
      return { url: finalUrl.href };
    }

    return { externalUrl: finalUrl.href };
  };

  private buildName(ctx: Context, urlResult: UrlResult): string {
    const lines: string[] = [envGetAppName()];

    const flags = urlResult.meta?.countryCodes?.map(cc => flagFromCountryCode(cc)).join(' ');
    if (flags) lines.push(flags);

    if (urlResult.meta?.height) {
      lines.push(getClosestResolution(urlResult.meta.height));
    }

    if (urlResult.isExternal && showExternalUrls(ctx.config)) {
      lines.push('⚠️ external');
    }

    return lines.join('\n');
  };

  private buildTitle(ctx: Context, urlResult: UrlResult): string {
    const titleLines = [];

    if (urlResult.meta?.title) {
      titleLines.push(urlResult.meta.title);
    }

    if (urlResult.meta?.bytes) {
      titleLines.push(`💾 ${bytes.format(urlResult.meta.bytes, { unitSeparator: ' ' })}`);
    }
    const sourceLabel = urlResult.meta?.sourceLabel;
    if (sourceLabel && sourceLabel !== urlResult.label) {
      titleLines.push(`🔗 ${urlResult.label} from ${urlResult.meta?.sourceLabel}`);
    } else {
      titleLines.push(`🔗 ${urlResult.label}`);
    }

    if (urlResult.error) {
      titleLines.push(logErrorAndReturnNiceString(ctx, this.logger, urlResult.meta?.sourceId ?? '', urlResult.error));
    }

    return titleLines.join('\n');
  };
}
