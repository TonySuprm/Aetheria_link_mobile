import { ContentType } from 'stremio-addon-sdk';
import { Extractor } from '../extractor';
import { Source } from '../source';
import { Config, CountryCode, CustomManifest } from '../types';
import {
  disableExtractorConfigKey,
  disableSourceConfigKey,
  excludeResolutionConfigKey,
  getDebridSuffix,
  isExtractorDisabled,
  isResolutionExcluded,
  isSourceDisabled,
} from './config';
import { envGetAppId, envGetAppName } from './env';
import { flagFromCountryCode, languageFromCountryCode } from './language';
import { RESOLUTIONS } from './resolution';

const typedEntries = <T extends object>(obj: T): [keyof T, T[keyof T]][] => (Object.entries(obj) as [keyof T, T[keyof T]][]);

export const buildManifest = (sources: Source[], extractors: Extractor[], config: Config): CustomManifest => {
  const manifest: CustomManifest = {
    id: envGetAppId(),
    version: '0.74.0', // x-release-please-version
    name: `${envGetAppName()}${getDebridSuffix(config)}`,
    description: 'Resolves streaming sites into URLs',
    resources: [
      'stream',
    ],
    types: [
      'movie',
      'series',
      'anime',
    ] as unknown as ContentType[],
    catalogs: [],
    idPrefixes: ['tmdb:', 'tt', 'kitsu:'],
    logo: '/public/aetheria.png',
    behaviorHints: {
      p2p: false,
      configurable: true,
      configurationRequired: false,
    },
    config: [],
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..h1oW2E0XXKLldUqO-ReSUA.fejuyGAvmc_CdT9dnq2srZCgoC42ak-Rqeo7IKsEN3DPRpz8x-hmvbuBI_7BUU2PsFMSni35m_Lv0teUNQDPvlrm7t1FCZINMR4ty_Hee6If5m6J4kSzafD75HhWvxFU.FAcDZ5qZrTPDeRAVOUI2tQ',
    },
  };

  sources.sort((sourceA, sourceB) => sourceA.label.localeCompare(sourceB.label));

  const countryCodeSources: Partial<Record<CountryCode, Source[]>> = {};
  sources.forEach(source =>
    source.countryCodes
      .forEach(countryCode => countryCodeSources[countryCode] = [...(countryCodeSources[countryCode] ?? []), source]));

  const sortedLanguageSources = typedEntries(countryCodeSources)
    .sort(([countryCodeA], [countryCodeB]) => {
      if (countryCodeB === CountryCode.multi) {
        return 1;
      }

      return countryCodeA.localeCompare(countryCodeB);
    });

  for (const [countryCode, sources] of sortedLanguageSources) {
    const language = languageFromCountryCode(countryCode);

    const isDefaultAsian = [CountryCode.multi, CountryCode.ja, CountryCode.zh, CountryCode.ko].includes(countryCode as CountryCode);
    manifest.config.push({
      key: countryCode,
      type: 'checkbox',
      title: `${language} ${flagFromCountryCode(countryCode)} (${(sources as Source[]).map(source => source.label).sort().join(', ')})`,
      ...((countryCode in config || isDefaultAsian) && { default: 'checked' }),
    });
  }

  manifest.config.push({
    key: 'showErrors',
    type: 'checkbox',
    title: 'Show errors',
    ...('showErrors' in config && { default: 'checked' }),
  });

  manifest.config.push({
    key: 'includeExternalUrls',
    type: 'checkbox',
    title: 'Include external URLs in results',
    ...('includeExternalUrls' in config && { default: 'checked' }),
  });

  manifest.config.push({
    key: 'mediaFlowProxyUrl',
    type: 'text',
    title: 'MediaFlow Proxy URL',
    default: config['mediaFlowProxyUrl'] ?? '',
  });

  manifest.config.push({
    key: 'mediaFlowProxyPassword',
    type: 'password',
    title: 'MediaFlow Proxy Password',
    default: config['mediaFlowProxyPassword'] ?? '',
  });

  manifest.config.push({
    key: 'alldebridApiKey',
    type: 'password',
    title: 'AllDebrid API Key',
    default: config['alldebridApiKey'] ?? '',
  });

  manifest.config.push({
    key: 'realdebridApiKey',
    type: 'password',
    title: 'RealDebrid API Token',
    default: config['realdebridApiKey'] ?? '',
  });

  RESOLUTIONS.forEach((resolution) => {
    manifest.config.push({
      key: excludeResolutionConfigKey(resolution),
      type: 'checkbox',
      title: `Exclude resolution ${resolution}`,
      ...(isResolutionExcluded(config, resolution) && { default: 'checked' }),
    });
  });

  extractors.forEach((extractor) => {
    if (extractor.id === 'external') {
      return;
    }

    manifest.config.push({
      key: disableExtractorConfigKey(extractor),
      type: 'checkbox',
      title: `Disable extractor ${extractor.label}`,
      ...(isExtractorDisabled(config, extractor) && { default: 'checked' }),
    });
  });

  sources.forEach((source) => {
    manifest.config.push({
      key: disableSourceConfigKey(source),
      type: 'checkbox',
      title: `Disable source ${source.label}`,
      ...(isSourceDisabled(config, source) && { default: 'checked' }),
    });
  });

  return manifest;
};
