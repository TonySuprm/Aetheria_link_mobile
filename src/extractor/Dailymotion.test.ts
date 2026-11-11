import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import { createTestContext } from '../test';
import { Dailymotion, pickDailymotionMasterHls } from './Dailymotion';
import { ExtractorRegistry } from './ExtractorRegistry';

const logger = winston.createLogger({ transports: [new winston.transports.Console({ level: 'nope' })] });
// The extractor no longer fetches the metadata API itself (play-time
// resolution) — the fetcher is unused; registry construction stays realistic.
const extractorRegistry = new ExtractorRegistry(logger, [new Dailymotion(undefined as never, logger)]);

const ctx = createTestContext({ mediaFlowProxyUrl: 'https://mediaflow.test.org', mediaFlowProxyPassword: 'test' });

/**
 * Dailymotion stream URLs are now PLAY-TIME resolver URLs on this add-on
 * (`/dm/<id>.m3u8`, served by MediaFlowProxyController). The sec= manifest
 * token is only minutes-lived and Dailymotion rate-limits per link, so the
 * extractor must NOT fetch the metadata API at /stream time — the resolver
 * route fetches a fresh manifest when the player actually presses play.
 *
 * The master-picking logic itself (auto master first, else highest ladder)
 * is tested directly against recorded metadata fixtures.
 */
describe('Dailymotion', () => {
  test('returns a play-time resolver URL on the add-on host (no upstream calls)', async () => {
    const results = await extractorRegistry.handle(ctx, new URL('https://www.dailymotion.com/video/xbbtrw2'));

    expect(results).toHaveLength(1);
    const result = assertSingle(results);
    expect(result.format).toBe('hls');
    expect(result.label).toBe('Dailymotion (MFP)');

    const url = new URL(result.url.href);
    expect(url.origin).toBe('http://localhost');
    expect(url.pathname).toBe('/dm/xbbtrw2.m3u8');
    // The configured MediaFlow rides along so the play-time resolver (which runs
    // WITHOUT /stream config) can point players at the right proxy directly.
    expect(url.searchParams.get('mfp')).toBe('https://mediaflow.test.org');
    expect(url.searchParams.get('pw')).toBe('test');
  });

  test('parses the video id from a geo player page ?video= query', async () => {
    const results = await extractorRegistry.handle(ctx, new URL('https://geo.dailymotion.com/player/xabc.html?video=x93u5v6'));
    expect(results).toHaveLength(1);
    const url = new URL(assertSingle(results).url.href);
    expect(url.pathname).toBe('/dm/x93u5v6.m3u8');
  });

  test('does not support non-dailymotion hosts', async () => {
    expect(await extractorRegistry.handle(ctx, new URL('https://vimeo.com/12345'))).toEqual([]);
  });

  test('does not support dailymotion hosts when MediaFlow Proxy is not configured', async () => {
    const noMfp = createTestContext();
    expect(await extractorRegistry.handle(noMfp, new URL('https://www.dailymotion.com/video/xbbtrw2'))).toEqual([]);
  });

  describe('pickDailymotionMasterHls (used by the /dm play-time resolver)', () => {
    // FetcherMock fixture files are named after the metadata URL they record.
    const loadFixture = (videoId: string): unknown =>
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, '__fixtures__', 'Dailymotion', `https_www.dailymotion.complayermetadatavideo${videoId}`),
          'utf8',
        ),
      );

    test('prefers the adaptive auto master playlist', () => {
      const metadata = loadFixture('xbbtrw2');
      expect(pickDailymotionMasterHls(metadata)?.href).toBe(
        'https://cdndirector.dailymotion.com/cdn/manifest/video/xbbtrw2.m3u8?sec=FAKETOKEN123&dmTs=997274',
      );
    });

    test('without an auto master, picks the highest single-quality HLS ladder', () => {
      const metadata = loadFixture('xfa1234');
      expect(pickDailymotionMasterHls(metadata)?.href).toBe('https://cdndirector.dailymotion.com/cdn/m/fx-1080.m3u8?sec=FAKE1080');
    });

    test('returns undefined when only non-HLS qualities exist', () => {
      expect(pickDailymotionMasterHls({ qualities: { 720: [{ type: 'video/mp4', url: 'https://x/video.mp4' }] } })).toBeUndefined();
      expect(pickDailymotionMasterHls({})).toBeUndefined();
      expect(pickDailymotionMasterHls(undefined)).toBeUndefined();
    });
  });
});

function assertSingle<T>(results: T[]): T {
  expect(results).toHaveLength(1);
  return results[0] as T;
}
