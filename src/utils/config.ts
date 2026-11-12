import { existsSync } from 'node:fs';
import path from 'node:path';
import { Extractor } from '../extractor';
import { Source } from '../source';
import { Config } from '../types';
import { envGet } from './env';
import { normalizeMediaFlowUrl } from './media-flow-proxy';

export { envGet };

/**
 * Sources turned OFF by default for fresh installs (no saved config). The user can still
 * re-enable them from the configure page; once enabled (key removed from the config URL)
 * the choice persists across visits because their saved config no longer matches the default.
 * Empty by default — 111477.xyz's workers.dev per-worker 429 throttle is bypassed by the
 * relay's worker rotation (RelayController), so it ships enabled.
 */
export const DEFAULT_DISABLED_SOURCE_IDS: string[] = [];

export const getDefaultConfig = (): Config => {
  return {
    multi: 'on',
    en: 'on',
    ...Object.fromEntries(DEFAULT_DISABLED_SOURCE_IDS.map(id => [`disableSource_${id}`, 'on'])),
  } as Config;
};

export const EMBEDDED_MEDIAFLOW_URL = 'http://127.0.0.1:8889';

/**
 * [halcyon patch] True when this instance co-runs the bundled MediaFlow Proxy
 * sidecar (libmediaflow.so shipped via Halcyon jniLibs). When true, the
 * sidecar is the ONLY valid MediaFlow for dailymotion (the manifest sec=
 * token is IP-bound to the fetcher) — every config layer must resolve to it.
 */
export const embeddedMediaFlowAvailable = (): boolean => {
  const nativeBinDir = envGet('AETH_NATIVE_BIN_DIR') || process.env['AETH_NATIVE_BIN_DIR'];
  return Boolean(nativeBinDir && existsSync(path.join(nativeBinDir, 'libmediaflow.so')));
};

/**
 * [halcyon patch] Force the embedded sidecar URL onto a config object.
 * Used on every config WRITE path (app-sync persistence, boot migration) so a
 * stale remote MediaFlow URL — e.g. re-saved from the webui's localStorage —
 * can never be persisted again on-device.
 */
export const forceEmbeddedMediaFlow = (config: Config): Config => {
  if (embeddedMediaFlowAvailable()) {
    config.mediaFlowProxyUrl = EMBEDDED_MEDIAFLOW_URL;
    if (!config.mediaFlowProxyPassword) config.mediaFlowProxyPassword = 'aetheria-link-secret';
  }
  return config;
};

export const getConfigWithEnvFallback = (urlConfig?: Config): Config => {
  const baseConfig = urlConfig ?? getDefaultConfig();

  const envMediaFlowProxyUrl = envGet('MEDIA_FLOW_PROXY_URL');
  const envMediaFlowProxyPassword = envGet('MEDIA_FLOW_PROXY_PASSWORD');
  const envAlldebridApiKey = envGet('ALLDEBRID_API_KEY');
  const envRealdebridApiKey = envGet('REALDEBRID_API_KEY');

  const resolved = {
    ...baseConfig,
    ...(envMediaFlowProxyUrl && !baseConfig.mediaFlowProxyUrl && { mediaFlowProxyUrl: envMediaFlowProxyUrl }),
    ...(envMediaFlowProxyPassword && !baseConfig.mediaFlowProxyPassword && { mediaFlowProxyPassword: envMediaFlowProxyPassword }),
    ...(envAlldebridApiKey && !baseConfig.alldebridApiKey && { alldebridApiKey: envAlldebridApiKey }),
    ...(envRealdebridApiKey && !baseConfig.realdebridApiKey && { realdebridApiKey: envRealdebridApiKey }),
  };

  // Users enter bare hosts (`mediaflow-xyz.onrender.com`, no scheme) into the
  // config UI — normalize once here so every consumer (extractor URLs, the /dm
  // resolver, MediaFlow URL builders) sees a usable http(s) base.
  const normalizedMediaFlowUrl = normalizeMediaFlowUrl(resolved.mediaFlowProxyUrl);
  if (normalizedMediaFlowUrl) resolved.mediaFlowProxyUrl = normalizedMediaFlowUrl;

  // [halcyon patch] on-device embedded sidecar WINS over every config layer
  // (webui-saved config AND the per-request URL config segment): the
  // Dailymotion manifest sec= token is bound to the fetching IP, so a remote
  // MFP can never serve it — the co-located sidecar (same device/network) is
  // the only valid MediaFlow for this deployment shape.
  return forceEmbeddedMediaFlow(resolved);
};

export const showErrors = (config: Config): boolean => 'showErrors' in config;

export const showExternalUrls = (config: Config): boolean => 'includeExternalUrls' in config;

export const hasMultiEnabled = (config: Config): boolean => 'multi' in config;

export const hasDebrid = (config: Config): boolean =>
  Boolean(config.alldebridApiKey?.trim()) || Boolean(config.realdebridApiKey?.trim());

export const getDebridSuffix = (config: Config): string => {
  const parts: string[] = [];
  if (config.alldebridApiKey?.trim()) parts.push('AD+');
  if (config.realdebridApiKey?.trim()) parts.push('RD+');
  return parts.length ? ` ${parts.join('')}` : '';
};

export const disableExtractorConfigKey = (extractor: Extractor): string => `disableExtractor_${extractor.id}`;

export const isExtractorDisabled = (config: Config, extractor: Extractor): boolean => disableExtractorConfigKey(extractor) in config;

export const disableSourceConfigKey = (source: Source): string => `disableSource_${source.id}`;

export const isSourceDisabled = (config: Config, source: Source): boolean => disableSourceConfigKey(source) in config;

export const excludeResolutionConfigKey = (resolution: string): string => `excludeResolution_${resolution}`;

export const isResolutionExcluded = (config: Config, resolution: string): boolean => excludeResolutionConfigKey(resolution) in config;
