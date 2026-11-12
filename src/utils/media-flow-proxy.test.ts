import { createServer } from 'node:net';
import { createTestContext } from '../test';
import { Context } from '../types';
import { FetcherMock } from './FetcherMock';
import {
  buildMediaFlowProxyExtractorRedirectUrl,
  buildMediaFlowProxyExtractorStreamUrl,
  buildMediaFlowProxyHlsUrl,
  buildMediaFlowProxyStreamUrl,
  isEmbeddedMediaFlowProxy,
  normalizeMediaFlowUrl,
  parseLoopbackProxyTarget,
  probePort,
  supportsMediaFlowProxy,
} from './media-flow-proxy';

const ctxWithProxy = createTestContext({ mediaFlowProxyUrl: 'proxy.example.com', mediaFlowProxyPassword: 'secret' });
const ctxWithProxyNoPassword = createTestContext({ mediaFlowProxyUrl: 'proxy.example.com' });
const ctxWithoutProxy = createTestContext();
const fetcher = new FetcherMock(`${__dirname}/__fixtures__/media-flow-proxy`);

const embeddedCtx = (mediaFlowProxyUrl: string): Context => ({
  hostUrl: new URL('https://public.example'),
  id: 'test',
  config: { mediaFlowProxyUrl, mediaFlowProxyPassword: 'secret' },
});

describe('supportsMediaFlowProxy', () => {
  test('returns true when mediaFlowProxyUrl is set', () => {
    expect(supportsMediaFlowProxy(ctxWithProxy)).toBe(true);
  });

  test('returns false when mediaFlowProxyUrl is not set', () => {
    expect(supportsMediaFlowProxy(ctxWithoutProxy)).toBe(false);
  });
});

describe('buildMediaFlowProxyHlsUrl', () => {
  test('builds url without headers', () => {
    const url = buildMediaFlowProxyHlsUrl(ctxWithProxy, new URL('https://example.com/stream.m3u8'));
    expect(url.pathname).toBe('/proxy/hls/manifest.m3u8');
    expect(url.searchParams.get('d')).toBe('https://example.com/stream.m3u8');
    expect(url.searchParams.get('api_password')).toBe('secret');
    expect(url.searchParams.has('force_playlist_proxy')).toBe(false);
  });

  test('builds url with headers and proxySegments', () => {
    const url = buildMediaFlowProxyHlsUrl(ctxWithProxy, new URL('https://example.com/stream.m3u8'), { Referer: 'https://ref.com' }, true);
    expect(url.searchParams.get('force_playlist_proxy')).toBe('true');
    expect(url.searchParams.get('h_referer')).toBe('https://ref.com');
  });
});

describe('buildMediaFlowProxyExtractorRedirectUrl', () => {
  test('builds redirect url', () => {
    const url = buildMediaFlowProxyExtractorRedirectUrl(ctxWithProxy, 'example.com', new URL('https://example.com/video'), { Referer: 'https://ref.com' });
    expect(url.pathname).toBe('/extractor/video');
    expect(url.searchParams.get('redirect_stream')).toBe('true');
    expect(url.searchParams.get('host')).toBe('example.com');
    expect(url.searchParams.get('h_referer')).toBe('https://ref.com');
  });
});

describe('buildMediaFlowProxyExtractorStreamUrl', () => {
  test('builds stream url from extractor result', async () => {
    const url = await buildMediaFlowProxyExtractorStreamUrl(ctxWithProxy, fetcher, 'example.com', new URL('https://example.com/video'), { Referer: 'https://ref.com' });
    expect(url).toBeInstanceOf(URL);
    expect(url.searchParams.has('d')).toBe(true);
  });
});

describe('buildMediaFlowProxyExtractorRedirectUrl without headers', () => {
  test('builds redirect url with default empty headers', () => {
    const url = buildMediaFlowProxyExtractorRedirectUrl(ctxWithProxy, 'example.com', new URL('https://example.com/video'));
    expect(url.pathname).toBe('/extractor/video');
    expect(url.searchParams.get('redirect_stream')).toBe('true');
  });
});

describe('api_password handling', () => {
  test('buildMediaFlowProxyExtractorRedirectUrl omits api_password when not set', () => {
    const url = buildMediaFlowProxyExtractorRedirectUrl(ctxWithProxyNoPassword, 'example.com', new URL('https://example.com/video'));
    expect(url.searchParams.has('api_password')).toBe(false);
  });

  test('buildMediaFlowProxyHlsUrl omits api_password when not set', () => {
    const url = buildMediaFlowProxyHlsUrl(ctxWithProxyNoPassword, new URL('https://example.com/stream.m3u8'));
    expect(url.searchParams.has('api_password')).toBe(false);
  });
});

describe('embedded (loopback) proxy -> public host rewrite', () => {
  test('isEmbeddedMediaFlowProxy detects loopback hosts', () => {
    expect(isEmbeddedMediaFlowProxy('http://localhost:8889')).toBe(true);
    expect(isEmbeddedMediaFlowProxy('127.0.0.1:8889')).toBe(true);
    expect(isEmbeddedMediaFlowProxy('http://0.0.0.0:8889')).toBe(true);
    expect(isEmbeddedMediaFlowProxy('https://mediaflow.example.com')).toBe(false);
    expect(isEmbeddedMediaFlowProxy(undefined)).toBe(false);
  });

  test('buildMediaFlowProxyHlsUrl uses the public host for the embedded proxy', () => {
    const url = buildMediaFlowProxyHlsUrl(embeddedCtx('http://localhost:8889'), new URL('https://example.com/stream.m3u8'));
    expect(url.origin).toBe('https://public.example');
    expect(url.pathname).toBe('/proxy/hls/manifest.m3u8');
    expect(url.searchParams.get('d')).toBe('https://example.com/stream.m3u8');
  });

  test('buildMediaFlowProxyStreamUrl uses the public host for the embedded proxy', () => {
    const url = buildMediaFlowProxyStreamUrl(embeddedCtx('127.0.0.1:8889'), new URL('https://example.com/video.mp4'));
    expect(url.origin).toBe('https://public.example');
    expect(url.pathname).toBe('/proxy/stream');
  });

  test('buildMediaFlowProxyExtractorRedirectUrl uses the public host for the embedded proxy', () => {
    const url = buildMediaFlowProxyExtractorRedirectUrl(embeddedCtx('http://localhost:8889'), 'doodstream', new URL('https://doodstream.com/d/abc'), { Referer: 'https://ref.com' });
    expect(url.origin).toBe('https://public.example');
    expect(url.pathname).toBe('/extractor/video');
    expect(url.searchParams.get('redirect_stream')).toBe('true');
  });

  test('external (public) proxy config keeps its own origin', () => {
    const url = buildMediaFlowProxyHlsUrl(ctxWithProxy, new URL('https://example.com/stream.m3u8'));
    expect(url.origin).toBe('http://proxy.example.com');
  });
});

describe('embedded sidecar bootstrap', () => {
  test('parseLoopbackProxyTarget resolves loopback urls', () => {
    expect(parseLoopbackProxyTarget('http://127.0.0.1:8889')).toEqual({ host: '127.0.0.1', port: 8889 });
    expect(parseLoopbackProxyTarget('127.0.0.1:8889')).toEqual({ host: '127.0.0.1', port: 8889 });
    expect(parseLoopbackProxyTarget('http://0.0.0.0:8889')).toEqual({ host: '127.0.0.1', port: 8889 });
    expect(parseLoopbackProxyTarget('http://[::1]:8889')).toEqual({ host: '::1', port: 8889 });
    expect(parseLoopbackProxyTarget('http://localhost:8889')).toEqual({ host: 'localhost', port: 8889 });
    expect(parseLoopbackProxyTarget('http://localhost')).toEqual({ host: 'localhost', port: 8889 });
  });

  test('parseLoopbackProxyTarget rejects external or empty config', () => {
    expect(parseLoopbackProxyTarget('https://mediaflow.example.com')).toBeNull();
    expect(parseLoopbackProxyTarget('')).toBeNull();
    expect(parseLoopbackProxyTarget('  ')).toBeNull();
  });

  test('probePort detects a listening socket and a closed one', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await expect(probePort('127.0.0.1', port)).resolves.toBe(true);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await expect(probePort('127.0.0.1', port)).resolves.toBe(false);
  });
});

describe('normalizeMediaFlowUrl', () => {
  test('defaults scheme-less public hosts to https', () => {
    expect(normalizeMediaFlowUrl('mediaflow-proxy-light-cloud.onrender.com')).toBe('https://mediaflow-proxy-light-cloud.onrender.com');
    expect(normalizeMediaFlowUrl('mediaflow-host.example.com:8443')).toBe('https://mediaflow-host.example.com:8443');
  });

  test('defaults scheme-less loopback hosts to http', () => {
    expect(normalizeMediaFlowUrl('127.0.0.1:8889')).toBe('http://127.0.0.1:8889');
    expect(normalizeMediaFlowUrl('localhost')).toBe('http://localhost');
    expect(normalizeMediaFlowUrl('0.0.0.0:8889')).toBe('http://0.0.0.0:8889');
    expect(normalizeMediaFlowUrl('[::1]:8889')).toBe('http://[::1]:8889');
    expect(normalizeMediaFlowUrl('::1')).toBe('http://::1');
  });

  test('leaves already-schemed URLs alone (trailing slashes stripped)', () => {
    expect(normalizeMediaFlowUrl('https://mediaflow.example.com/')).toBe('https://mediaflow.example.com');
    expect(normalizeMediaFlowUrl('http://127.0.0.1:8889')).toBe('http://127.0.0.1:8889');
  });

  test('trims whitespace and returns undefined for empty values', () => {
    expect(normalizeMediaFlowUrl('  mediaflow.example.com  ')).toBe('https://mediaflow.example.com');
    expect(normalizeMediaFlowUrl('')).toBeUndefined();
    expect(normalizeMediaFlowUrl('   ')).toBeUndefined();
    expect(normalizeMediaFlowUrl(undefined)).toBeUndefined();
  });
});
