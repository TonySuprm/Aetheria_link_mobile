import { rewriteDailymotionMaster } from './dailymotion';

const MASTER_URL = 'https://www.dailymotion.com/cdn/manifest/video/x9wjqh4.m3u8?sec=abc';

/**
 * Shape matches a real `www.dailymotion.com/cdn/manifest` master (mobile app API):
 * relative `vod*.cf.dmcdn.net/sec2(...)` variant URIs, subtitles media group, the
 * 3840x1640 "2160@60" 4K tier on top of a 1080p/720p/480p ladder.
 */
const SAMPLE_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="en",DEFAULT=AUTO,AUTOSELECT=YES,LANGUAGE="en",URI="/cdn/playlist/source/sub.en.m3u8?sec=abc"',
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="mp4a.40.2,avc1.640028",RESOLUTION=1920x800,NAME="1080@60",SUBTITLES="subtitles"',
  '/cdn/manifest/video/x9wjqh4_1080.m3u8?sec=t1080',
  '#EXT-X-STREAM-INF:BANDWIDTH=20393920,CODECS="mp4a.40.2,avc1.640034",RESOLUTION=3840x1640,NAME="2160@60",SUBTITLES="subtitles"',
  '/cdn/manifest/video/x9wjqh4_2160.m3u8?sec=t2160',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="mp4a.40.2,avc1.64001f",RESOLUTION=1280x534,NAME="720",SUBTITLES="subtitles"',
  '/cdn/manifest/video/x9wjqh4_720.m3u8?sec=t720',
  '',
].join('\n');

const rewriteUrl = (url: URL): URL =>
  new URL(`/proxy/hls/manifest.m3u8?api_password=test&d=${encodeURIComponent(url.href)}`, 'https://addon.example.org');

const rewrittenVariantUrls = (output: string): string[] =>
  output.split('\n')
    .filter(line => line.startsWith('https://addon.example.org/'))
    .map(line => new URL(line).searchParams.get('d') ?? '');

describe('rewriteDailymotionMaster', () => {
  test('rewrites every variant to the proxy and sorts the ladder best-first (4K default)', () => {
    const output = rewriteDailymotionMaster({ master: SAMPLE_MASTER, hlsUrl: MASTER_URL, rewriteUrl });

    const urls = rewrittenVariantUrls(output);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('x9wjqh4_2160.m3u8');
    expect(urls[1]).toContain('x9wjqh4_1080.m3u8');
    expect(urls[2]).toContain('x9wjqh4_720.m3u8');

    // STREAM-INF lines stay attached to their (reordered) URI lines
    const lines = output.split('\n');
    const infOf = (uriPart: string): string | undefined => {
      const idx = lines.findIndex(l => l.startsWith('https://') && l.includes(uriPart));
      return idx > 0 ? lines[idx - 1] : undefined;
    };
    expect(infOf('x9wjqh4_2160.m3u8')).toContain('RESOLUTION=3840x1640');
  });

  test('keeps header comments and rewrites #EXT-X-MEDIA subtitle URIs', () => {
    const output = rewriteDailymotionMaster({ master: SAMPLE_MASTER, hlsUrl: MASTER_URL, rewriteUrl });

    expect(output.split('\n')[0]).toBe('#EXTM3U');
    const mediaLine = output.split('\n').find(l => l.startsWith('#EXT-X-MEDIA'));
    expect(mediaLine).toBeDefined();
    const rewrittenUri = mediaLine?.match(/URI="([^"]+)"/)?.[1];
    expect(rewrittenUri).toContain('https://addon.example.org/proxy/hls/manifest.m3u8');
    expect(new URL(rewrittenUri ?? '').searchParams.get('d')).toContain('sub.en.m3u8');
  });

  test('DM_FLAT keeps only the top-bandwidth (4K) variant', () => {
    const output = rewriteDailymotionMaster({ master: SAMPLE_MASTER, hlsUrl: MASTER_URL, flat: true, rewriteUrl });

    const urls = rewrittenVariantUrls(output);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('x9wjqh4_2160.m3u8');
    // subtitles media group survives so the SUBTITLES group-id stays resolvable
    expect(output).toContain('#EXT-X-MEDIA');
  });

  test('maxHeight cap drops taller tiers, keeping the best allowed one first', () => {
    const output = rewriteDailymotionMaster({ master: SAMPLE_MASTER, hlsUrl: MASTER_URL, maxHeight: 1080, rewriteUrl });

    const urls = rewrittenVariantUrls(output);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('x9wjqh4_1080.m3u8');
    expect(urls.some(u => u.includes('x9wjqh4_2160.m3u8'))).toBe(false);
  });

  test('a tier without RESOLUTION is never dropped by the cap', () => {
    const master = SAMPLE_MASTER.replace(',RESOLUTION=1280x534', '');
    const output = rewriteDailymotionMaster({ master, hlsUrl: MASTER_URL, maxHeight: 480, rewriteUrl });

    // the 720 tier has no resolution now -> kept; 2160/1080 dropped
    const urls = rewrittenVariantUrls(output);
    expect(urls.some(u => u.includes('x9wjqh4_720.m3u8'))).toBe(true);
    expect(urls).toHaveLength(1);
  });

  test('absolute variant URIs are preserved as-is when rewriting', () => {
    const master = SAMPLE_MASTER.replace('/cdn/manifest/video/x9wjqh4_2160.m3u8?sec=t2160', 'https://vod3.cf.dmcdn.net/sec2(abs)/manifest/x9wjqh4_2160.m3u8');
    const output = rewriteDailymotionMaster({ master, hlsUrl: MASTER_URL, flat: true, rewriteUrl });

    expect(new URL(rewrittenVariantUrls(output)[0])).toBeInstanceOf(URL);
    expect(rewrittenVariantUrls(output)[0]).toContain('vod3.cf.dmcdn.net/sec2(abs)/manifest/x9wjqh4_2160.m3u8');
  });
});
