import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Logger } from 'winston';
import { Context } from '../types';
import { envGet } from './env';
import { Fetcher } from './Fetcher';

interface ExtractResult {
  destination_url: string;
  request_headers: Record<string, string>;
  mediaflow_proxy_url: string;
  query_params: Record<string, string>;
}

export const supportsMediaFlowProxy = (ctx: Context): boolean => !!ctx.config['mediaFlowProxyUrl'];

const stripProtocol = (value: string): string => value.replace(/^https?:\/\//i, '');
const configProtocol = (value: string): string => value.toLowerCase().startsWith('https://') ? 'https:' : 'http:';

const LOOPBACK_PROXY_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * Accepts a MediaFlow base URL with or WITHOUT a scheme — users routinely enter
 * bare hosts (`mediaflow-xyz.onrender.com`) in the add-on config / webui, and a
 * scheme-less value breaks every consumer: URL-based validation rejects it (the
 * /dm resolver then falls back to dead URLs) and `configProtocol` defaults it to
 * http://, which public hosts don't serve (and https players block as mixed
 * content). Public hosts default to https; loopback hosts default to http.
 */
export const normalizeMediaFlowUrl = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');

  const hostPart = (trimmed.split('/')[0] ?? '').toLowerCase();
  const loopback = LOOPBACK_PROXY_HOSTS.has(hostPart.split(':')[0] ?? '')
    || hostPart.startsWith('[')
    || hostPart.startsWith('::');
  return `${loopback ? 'http' : 'https'}://${trimmed}`.replace(/\/+$/, '');
};

/**
 * True when the configured MediaFlow Proxy is the embedded, co-running instance
 * (docker-compose/sidecar on loopback). Such a proxy has no address
 * reachable by Stremio players, so client-facing URLs must be exposed through
 * the add-on's own public host (relayed by MediaFlowProxyController).
 */
export const isEmbeddedMediaFlowProxy = (value?: string): boolean => {
  if (!value) return false;
  const hostPart = stripProtocol(value).split('/')[0] ?? '';
  // Bracketed IPv6 ([::1]:8889) must be captured before any ':' split —
  // splitting the raw host on '[' or ':' mangles it into an empty string.
  const bracketed = hostPart.match(/^\[([^\]]+)\]/);
  const host = (bracketed ? bracketed[1] : hostPart.split(':')[0])?.trim().toLowerCase();
  return host ? LOOPBACK_PROXY_HOSTS.has(host) : false;
};

/**
 * Base URL for requests issued BY THE ADDON (server-side fetches such as
 * `/extractor/video` resolution): always the configured proxy (loopback when
 * co-running). Never the public host — the add-on must reach the proxy
 * directly to avoid a public round-trip.
 */
const serverBase = (ctx: Context): URL => {
  const cfg = ctx.config.mediaFlowProxyUrl ?? '';
  return new URL(`${configProtocol(cfg)}//${stripProtocol(cfg)}`);
};

/**
 * Base URL for stream URLs HANDED TO THE PLAYER. For an external (public)
 * proxy configuration that is the proxy itself; for the embedded loopback
 * proxy it is the add-on's public host, because the add-on relays the
 * `/proxy/*` and `/extractor/*` paths to the co-running proxy.
 */
const publicBase = (ctx: Context): URL => {
  const cfg = ctx.config.mediaFlowProxyUrl;
  if (cfg && !isEmbeddedMediaFlowProxy(cfg)) return serverBase(ctx);
  return ctx.hostUrl;
};

const addExtractorParams = (mediaFlowProxyUrl: URL, host: string, url: URL, ctx: Context, headers: Record<string, string>): void => {
  mediaFlowProxyUrl.searchParams.append('host', host);
  if (ctx.config.mediaFlowProxyPassword) {
    mediaFlowProxyUrl.searchParams.append('api_password', ctx.config.mediaFlowProxyPassword);
  }
  mediaFlowProxyUrl.searchParams.append('d', url.href);

  for (const headerKey in headers) {
    mediaFlowProxyUrl.searchParams.set('h_' + headerKey.toLowerCase(), headers[headerKey] as string);
  }
};

const buildMediaFlowProxyExtractorUrl = (ctx: Context, host: string, url: URL, headers: Record<string, string>, base: URL): URL => {
  const mediaFlowProxyUrl = new URL('/extractor/video', base);
  addExtractorParams(mediaFlowProxyUrl, host, url, ctx, headers);
  return mediaFlowProxyUrl;
};

export const buildMediaFlowProxyExtractorRedirectUrl = (ctx: Context, host: string, url: URL, headers: Record<string, string> = {}): URL => {
  const mediaFlowProxyUrl = buildMediaFlowProxyExtractorUrl(ctx, host, url, headers, publicBase(ctx));

  mediaFlowProxyUrl.searchParams.append('redirect_stream', 'true');

  return mediaFlowProxyUrl;
};

export const buildMediaFlowProxyExtractorStreamUrl = async (ctx: Context, fetcher: Fetcher, host: string, url: URL, headers: Record<string, string>): Promise<URL> => {
  const mediaFlowProxyUrl = buildMediaFlowProxyExtractorUrl(ctx, host, url, headers, serverBase(ctx));

  const extractResult: ExtractResult = await fetcher.json(ctx, mediaFlowProxyUrl, { queueLimit: 4, queueTimeout: 10000, timeout: 20000 });

  const streamUrl = new URL(extractResult.mediaflow_proxy_url);

  // The proxy reports its own host; for the embedded proxy that is loopback,
  // which is unreachable by players. Re-base onto the public host.
  if (isEmbeddedMediaFlowProxy(extractResult.mediaflow_proxy_url)) {
    streamUrl.protocol = publicBase(ctx).protocol;
    streamUrl.host = publicBase(ctx).host;
  }

  for (const queryParamsKey in extractResult.query_params) {
    streamUrl.searchParams.append(queryParamsKey, extractResult.query_params[queryParamsKey] as string);
  }
  for (const requestHeadersKey in extractResult.request_headers) {
    streamUrl.searchParams.append(`h_${requestHeadersKey}`, extractResult.request_headers[requestHeadersKey] as string);
  }
  streamUrl.searchParams.append('d', extractResult.destination_url);

  return streamUrl;
};
export const buildMediaFlowProxyHlsUrl = (ctx: Context, m3u8Url: URL, headers: Record<string, string> = {}, proxySegments = false): URL => {
  const mediaFlowProxyUrl = new URL('/proxy/hls/manifest.m3u8', publicBase(ctx));
  if (ctx.config.mediaFlowProxyPassword) {
    mediaFlowProxyUrl.searchParams.append('api_password', ctx.config.mediaFlowProxyPassword);
  }
  mediaFlowProxyUrl.searchParams.append('d', m3u8Url.href);
  if (proxySegments) mediaFlowProxyUrl.searchParams.append('force_playlist_proxy', 'true');
  for (const headerKey in headers) {
    mediaFlowProxyUrl.searchParams.set('h_' + headerKey.toLowerCase(), headers[headerKey] as string);
  }
  return mediaFlowProxyUrl;
};

export const buildMediaFlowProxyStreamUrl = (ctx: Context, url: URL, headers: Record<string, string> = {}): URL => {
  const mediaFlowProxyUrl = new URL('/proxy/stream', publicBase(ctx));
  if (ctx.config.mediaFlowProxyPassword) {
    mediaFlowProxyUrl.searchParams.append('api_password', ctx.config.mediaFlowProxyPassword);
  }
  mediaFlowProxyUrl.searchParams.append('d', url.href);
  for (const headerKey in headers) {
    mediaFlowProxyUrl.searchParams.set('h_' + headerKey.toLowerCase(), headers[headerKey] as string);
  }
  return mediaFlowProxyUrl;
};

// ── Embedded MediaFlow Proxy sidecar ──────────────────────────────────────
// The proxy is expected to co-run on loopback, started before `npm start`
// by a supervisor script. When a host starts the process directly instead,
// every /proxy/* playback would die with ECONNREFUSED. As a safety net the
// add-on probes the configured loopback proxy at startup and spawns the
// bundled binary itself when nothing is listening (no-op when it is
// already running).
const MFP_DEFAULT_URL = 'http://127.0.0.1:8889';
const MFP_BINARY_CANDIDATES = ['/usr/local/bin/mediaflow-proxy-light', '/app/mediaflow-proxy-light'];

// [halcyon patch] musl static binaries cannot resolve DNS on Android (no
// /etc/resolv.conf; the loopback fallback hits nothing). This CONNECT +
// absolute-URI proxy runs inside the add-on (node resolves via the system)
// and MFP's reqwest tunnels every upstream fetch through it via PROXY_URL.
let sidecarProxyPort: number | undefined;
const ensureSidecarDnsProxy = async (logger: Logger): Promise<number | undefined> => {
  if (sidecarProxyPort) return sidecarProxyPort;
  const srv = createServer((client) => {
    client.once('data', (first: Buffer) => {
      const head = first.toString('latin1');
      const connectMatch = head.match(/^CONNECT ([^:\s]+):(\d+)/);
      const getMatch = head.match(/^([A-Z]+) (https?:\/\/)([^:\/\s]+)(?::(\d+))?(\/\S*) (HTTP\/[\d.]+)\r\n/);
      if (connectMatch) {
        client.pause();
        const up = createConnection({ host: connectMatch[1], port: Number(connectMatch[2]) }, () => {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n', () => {
            const idx = first.indexOf('\r\n\r\n');
            const rest = idx >= 0 ? first.subarray(idx + 4) : null;
            if (rest && rest.length) up.write(rest);
            client.on('data', (b: Buffer) => up.write(b));
            up.on('data', (b: Buffer) => client.write(b));
            client.resume();
          });
        });
        up.on('error', () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* ignore */ } });
        client.on('error', () => { try { up.destroy(); } catch { /* ignore */ } });
      } else if (getMatch) {
        const up = createConnection(
          { host: getMatch[3], port: Number(getMatch[4] || (getMatch[2] === 'https:' ? 443 : 80)) },
          () => {
            const firstLineEnd = first.indexOf('\r\n');
            up.write(getMatch[1] + ' ' + getMatch[5] + ' ' + getMatch[6] + '\r\n' + first.subarray(firstLineEnd + 2).toString('latin1'));
            client.on('data', (b: Buffer) => up.write(b));
            up.on('data', (b: Buffer) => client.write(b));
          },
        );
        up.on('error', () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* ignore */ } });
        client.on('error', () => { try { up.destroy(); } catch { /* ignore */ } });
      } else {
        try { client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); } catch { /* ignore */ }
      }
    });
  });
  await new Promise<void>((ok, err) => {
    srv.once('error', err);
    srv.listen(0, '127.0.0.1', ok);
  });
  sidecarProxyPort = (srv.address() as { port: number }).port;
  logger.info('[mfp] dns-bypass proxy on 127.0.0.1:' + sidecarProxyPort);
  return sidecarProxyPort;
};

// [halcyon patch] on-device (Halcyon) deployments: the musl static android
// build ships via jniLibs exec-safe trick (like libffmpeg/libcloudflared) —
// resolved at runtime from the worker-injected native bin dir.
const MFP_NATIVE_CANDIDATE = (): string | undefined => {
  const nativeBinDir = process.env['AETH_NATIVE_BIN_DIR'];
  if (!nativeBinDir) return undefined;
  return path.join(nativeBinDir, 'libmediaflow.so');
};
const MFP_PROBE_TIMEOUT_MS = 750;
const MFP_READY_TIMEOUT_MS = 15_000;
const MFP_MAX_RESTARTS = 5;
const MFP_RESTART_DELAY_MS = 2_000;
const MFP_STABLE_UPTIME_MS = 60_000;

export interface LoopbackProxyTarget {
  host: string;
  port: number;
}

/**
 * Resolves the probe/spawn target for an embedded (loopback) proxy URL.
 * Returns null for external proxies and empty values — those are somebody
 * else's process to keep alive.
 */
export const parseLoopbackProxyTarget = (value: string): LoopbackProxyTarget | null => {
  const trimmed = value.trim();
  if (!trimmed || !isEmbeddedMediaFlowProxy(trimmed)) return null;
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/^0\.0\.0\.0$/, '127.0.0.1');
    if (!host) return null;
    return { host, port: url.port ? parseInt(url.port, 10) : 8889 };
  } catch {
    return null;
  }
};

/** True when something already accepts TCP connections on host:port. */
export const probePort = (host: string, port: number, timeoutMs = MFP_PROBE_TIMEOUT_MS): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });

let supervisedChild: ChildProcess | undefined;
let supervisionShuttingDown = false;
let exitHookRegistered = false;

const pipeSidecarOutput = (logger: Logger, stream: Readable | null, level: 'info' | 'warn'): void => {
  if (!stream) return;
  let carry = '';
  stream.on('data', (chunk: Buffer) => {
    carry += chunk.toString('utf8');
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) logger[level](`[mfp] ${trimmed}`);
    }
  });
};

const spawnSupervisedProxy = (logger: Logger, binary: string, host: string, port: number, attempt: number, dnsProxyPort?: number): void => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // The binary's Python-compat layer maps bare PORT/HOST onto its bind
    // address (config.rs compat_pairs). Those hold the ADDON's values here
    // and would repoint the sidecar onto the addon's own port — EADDRINUSE
    // on Linux, wrong port everywhere else.
    if (key === 'PORT' || key === 'HOST') continue;
    env[key] = value;
  }
  // Pin the bind address to exactly the probed loopback target: the APP__*
  // form wins over both the config file and the compat env vars.
  env['APP__SERVER__HOST'] = host === 'localhost' ? '127.0.0.1' : host;
  // [halcyon patch] route upstream fetches through the dns-bypass proxy
  const proxyPort = dnsProxyPort;
  if (proxyPort) {
    const proxyUrl = 'http://127.0.0.1:' + proxyPort;
    env['PROXY_URL'] = proxyUrl;
    env['HTTP_PROXY'] = proxyUrl;
    env['HTTPS_PROXY'] = proxyUrl;
    // all_proxy=true activates proxy.proxy_url for ALL destinations in MFP's
    // ProxyRouter (otherwise the default proxy is ignored entirely)
    env['ALL_PROXY'] = 'true';
  }
  // [halcyon patch] auth parity: MFP must run with the SAME api_password the
  // relay sends, and with it set the _token_ encrypted-URI scheme activates
  if (!env['API_PASSWORD']) env['API_PASSWORD'] = envGet('MEDIA_FLOW_PROXY_PASSWORD') || 'aetheria-link-secret';
  env['APP__SERVER__PORT'] = String(port);
  if (!env['CONFIG_PATH'] && existsSync('/app/mediaflow-config.toml')) env['CONFIG_PATH'] = '/app/mediaflow-config.toml';
  env['RUST_LOG'] = env['RUST_LOG'] ?? 'info';

  const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'], env });
  supervisedChild = child;
  const startedAt = Date.now();

  pipeSidecarOutput(logger, child.stdout, 'info');
  pipeSidecarOutput(logger, child.stderr, 'warn');
  logger.info(`[mfp] spawned ${binary} (pid ${child.pid ?? '?'}) for ${host}:${port}`);

  child.once('exit', (code, signal) => {
    if (supervisedChild === child) supervisedChild = undefined;
    if (supervisionShuttingDown) return;
    // A child that stayed up for a while gets a fresh restart budget; one
    // that keeps dying within seconds burns it.
    const nextAttempt = Date.now() - startedAt >= MFP_STABLE_UPTIME_MS ? 1 : attempt + 1;
    if (nextAttempt > MFP_MAX_RESTARTS) {
      logger.error(`[mfp] exited (code=${code ?? '?'} signal=${signal ?? '?'}) and the restart budget is exhausted — MediaFlow Proxy streams will fail until the container restarts.`);
      return;
    }
    logger.warn(`[mfp] exited (code=${code ?? '?'} signal=${signal ?? '?'}); restart ${nextAttempt}/${MFP_MAX_RESTARTS} in ${MFP_RESTART_DELAY_MS / 1000}s`);
    setTimeout(() => {
      if (!supervisionShuttingDown) {
        ensureSidecarDnsProxy(logger).then(dnsPort => spawnSupervisedProxy(logger, binary, host, port, nextAttempt, dnsPort)).catch(() => { /* ignore */ });
      }
    }, MFP_RESTART_DELAY_MS).unref();
  });
};

/**
 * Ensures the embedded loopback MediaFlow Proxy is running before the first
 * /proxy/* playback request arrives. Returns true once the port accepts
 * connections. Safe to call in any deployment shape: external proxies,
 * missing binaries and already-running instances are all detected and
 * skipped.
 */
export const ensureEmbeddedMediaFlowProxy = async (logger: Logger): Promise<boolean> => {
  // [halcyon patch] the embedded sidecar binary takes precedence: when it
  // exists on-device, the sidecar MUST run (dailymotion's IP-bound token),
  // regardless of what MEDIA_FLOW_PROXY_URL says (a stale remote URL from a
  // re-seed would silently skip the spawn and leave the proxy dead).
  const sidecarBinDir = process.env['AETH_NATIVE_BIN_DIR'];
  const sidecarUrl = sidecarBinDir && existsSync(path.join(sidecarBinDir, 'libmediaflow.so'))
    ? 'http://127.0.0.1:8889'
    : undefined;
  const target = parseLoopbackProxyTarget(sidecarUrl ?? envGet('MEDIA_FLOW_PROXY_URL') ?? MFP_DEFAULT_URL);
  if (!target) return false; // external proxy or none configured: not ours to start

  const { host, port } = target;
  if (await probePort(host, port)) {
    logger.info(`MediaFlow Proxy already listening on ${host}:${port}.`);
    return true;
  }

  const binary = envGet('MEDIA_FLOW_PROXY_BIN')
    ?? (MFP_NATIVE_CANDIDATE() && existsSync(MFP_NATIVE_CANDIDATE() as string) ? MFP_NATIVE_CANDIDATE() : undefined)
    ?? MFP_BINARY_CANDIDATES.find(candidate => existsSync(candidate));
  if (!binary) {
    logger.warn(`MediaFlow Proxy is not listening on ${host}:${port} and no bundled binary was found — MediaFlow Proxy streams (dailymotion, ok.ru, rumble, ...) will fail with 502. Deploy via the Dockerfile (supervisord) or start the proxy with start-all.ps1.`);
    return false;
  }

  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on('exit', () => {
      supervisionShuttingDown = true;
      supervisedChild?.kill();
    });
  }

  logger.info(`MediaFlow Proxy not reachable on ${host}:${port} — starting bundled binary ${binary}.`);
  spawnSupervisedProxy(logger, binary, host, port, 1, await ensureSidecarDnsProxy(logger));

  const deadline = Date.now() + MFP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (await probePort(host, port)) {
      logger.info(`MediaFlow Proxy is ready on ${host}:${port}.`);
      return true;
    }
  }
  logger.warn(`MediaFlow Proxy did not accept connections on ${host}:${port} within ${MFP_READY_TIMEOUT_MS / 1000}s — see the [mfp] log lines above.`);
  return false;
};

// [halcyon patch] Sidecar liveness watchdog. When the add-on worker restarts
// (redeploy / service restart), a previously spawned sidecar becomes an
// orphan: the boot-time ensure() probes the port while the orphan is still
// alive, skips spawning, and the orphan then dies on its broken stdout pipe —
// leaving the loopback proxy dead until the next full restart. The watchdog
// re-probes periodically and re-runs ensure() (idempotent: alive = no-op) so
// the sidecar self-heals within one interval.
let watchdogStarted = false;
export const startMediaFlowWatchdog = (logger: Logger, intervalMs = 25_000): void => {
  if (watchdogStarted) return;
  watchdogStarted = true;
  setInterval(() => {
    ensureEmbeddedMediaFlowProxy(logger).catch(() => { /* per-run failures are logged inside */ });
  }, intervalMs);
  logger.info('[mfp] liveness watchdog armed (25s interval)');
};
