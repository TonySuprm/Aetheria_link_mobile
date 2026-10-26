import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, findHeight, getHeadfulBrowser, Id } from '../utils';
import { Source, SourceResult } from './Source';

interface VidApiConfig {
  mediaType?: 'movie' | 'tv';
  mediaId?: string;
  idType?: 'imdb' | 'tmdb';
  season?: number | null;
  episode?: number | null;
  streamDataApiUrl?: string;
  playToken?: string;
  playTokenTs?: number;
}

interface StreamDataResponse {
  status_code?: string | number;
  data?: {
    stream_urls?: string[];
    file_name?: string;
  };
}

interface PlayerSession {
  config: VidApiConfig;
  cookieHeader?: string;
}

/** Solved player sessions (Turnstile pass + CONFIG + cookies), cached so repeat
 *  requests skip the expensive headful solve (which the site rate-limits). */
const playerSessionCache = new Map<string, { session: PlayerSession; ts: number }>();
const PLAYER_SESSION_TTL = 30 * 60 * 1000; // 30 min (playToken longevity is unknown; stay conservative)

const PLAYER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

/** Serializes headful solves — the site rate-limits Turnstile solves per IP, so two
 *  concurrent requests (e.g. movie + series probes) must not solve at once. */
let solveChain: Promise<unknown> = Promise.resolve();
const runSolveExclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    const run = solveChain.then(task, task);
    solveChain = run.catch(() => { /* keep the chain alive for the next waiter */ });
    return run;
};

export class ImdbSu extends Source {
    public override readonly id = 'imdbsu';
    public override readonly label = 'ImdbSu';
    public override readonly contentTypes: ContentType[] = ['movie', 'series'];
    public override readonly countryCodes: CountryCode[] = [CountryCode.multi];
    public override readonly baseUrl = 'https://imdb.su';

    private readonly fetcher: Fetcher;

    public constructor(fetcher: Fetcher) {
        super();
        this.fetcher = fetcher;
    }

    /**
     * Get a solved player session (CONFIG + cookies). Fast path: plain GET of the player
     * page (rarely works — it normally serves a Turnstile gate). Slow path: headful
     * browser with the embed referer; the Cloudflare Turnstile widget auto-solves there
     * and the page reloads with the verified session, after which CONFIG is present.
     * The subsequent streamData API call must carry the browser's ts_pass/session cookies.
     */
    private async getPlayerSession(ctx: Context, playerUrl: URL, embedUrl: string): Promise<PlayerSession | undefined> {
        const cached = playerSessionCache.get(playerUrl.href);
        if (cached && Date.now() - cached.ts < PLAYER_SESSION_TTL) {
            return cached.session;
        }

        const logger = this.fetcher.getLogger();

        // 1) plain fetch
        try {
            const html = await this.fetcher.text(ctx, playerUrl, {
                headers: { Referer: embedUrl, 'User-Agent': PLAYER_UA },
                timeout: 8000,
            });
            const config = this.parseConfig(html);
            if (config?.streamDataApiUrl && config.mediaId) {
                return { config };
            }
        } catch { /* fall through to headful */ }

        // 2) headful solve. The page reloads itself mid-solve, so CONFIG polls must
        //    survive "execution context destroyed".
        if (ctx.streamDeadline && Date.now() > ctx.streamDeadline - 30000) {
            logger.info(`ImdbSu: skipping headful solve — stream deadline too close`, ctx);
            return undefined;
        }

        const solve = async (): Promise<PlayerSession | undefined> => {
            const browser = await getHeadfulBrowser(logger);
            const page = await browser.newPage();
            try {
                await page.setViewport({ width: 1280, height: 900 });
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    // @ts-expect-error - window.chrome is not typed
                    window.chrome = { runtime: {} };
                });
                await page.goto(playerUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000, referer: embedUrl });

                // Turnstile auto-solves in headful; the page then reloads itself with the
                // verified session and CONFIG appears. waitForFunction survives that navigation.
                // (String IIFE — no DOM types are compiled in this project. A bare `() => …`
                // string would evaluate to a truthy function object and resolve instantly,
                // so the wait must be an expression returning a boolean.)
                await page
                    .waitForFunction('(() => /const\\s+CONFIG\\s*=/.test(document.documentElement.innerHTML))()', { timeout: 55000 })
                    .catch(() => { /* timed out — report below */ });
                const html = await page.content();
                const configMatch = html.match(/const\s+CONFIG\s*=\s*({[\s\S]*?});/);
                if (!configMatch?.[1]) {
                    logger.info(`ImdbSu: headful solve produced no CONFIG for ${playerUrl.href} (rate-limited?)`, ctx);
                    return undefined;
                }

                const config = JSON.parse(configMatch[1]) as VidApiConfig;
                if (!config?.streamDataApiUrl || !config.mediaId) return undefined;

                // The streamData API validates the Turnstile-pass cookies from this session.
                const cookies = await page.cookies();
                const cookieHeader = cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
                const session: PlayerSession = { config, cookieHeader };
                playerSessionCache.set(playerUrl.href, { session, ts: Date.now() });
                return session;
            } finally {
                await page.close().catch(() => { /* already closed */ });
            }
        };

        // One solve at a time — concurrent solves trip the site's per-IP Turnstile limit.
        return await runSolveExclusive(solve);
    }

    public override async handleInternal(ctx: Context, type: string, id: Id): Promise<SourceResult[]> {
        const results: SourceResult[] = [];
        const isTv = type === 'series';

        const queryId = String(id.id);

        // 1) Load the imdb.su player embed page. It contains an iframe that points to the
        // actual nextgen player (e.g. nextgencloudfabric.com). That page exposes a CONFIG
        // object with the real streamDataApiUrl and anti-abuse playToken.
        let embedUrl: string;
        if (isTv && id.season !== undefined && id.episode !== undefined) {
            embedUrl = `https://player.imdb.su/embed/tv/${encodeURIComponent(queryId)}/${id.season}/${id.episode}`;
        } else {
            embedUrl = `https://player.imdb.su/embed/movie/${encodeURIComponent(queryId)}`;
        }

        let embedHtml: string;
        try {
            embedHtml = await this.fetcher.text(ctx, new URL(embedUrl), {
                headers: { Referer: this.baseUrl },
                timeout: 8000,
            });
        } catch (err) {
            this.fetcher.getLogger().warn(`ImdbSu: failed to load embed page ${embedUrl}: ${err}`, ctx);
            return [];
        }

        // Extract the nextgen iframe src from the player page.
        const iframeMatch = embedHtml.match(/<iframe[^>]+src\s*=\s*"(https:\/\/[^"]+)"/i);
        if (!iframeMatch?.[1]) {
            this.fetcher.getLogger().info(`ImdbSu: no player iframe found in ${embedUrl}`, ctx);
            return [];
        }
        const playerUrl = new URL(iframeMatch[1]);

        // 2) Read CONFIG from the player page (plain fetch first, headful Turnstile
        //    solve as fallback — see getPlayerSession).
        const session = await this.getPlayerSession(ctx, playerUrl, embedUrl);
        if (!session) {
            this.fetcher.getLogger().info(`ImdbSu: no CONFIG found in ${playerUrl.href}`, ctx);
            return [];
        }
        const config = session.config;
        if (!config.streamDataApiUrl || !config.mediaId) {
            this.fetcher.getLogger().info(`ImdbSu: incomplete CONFIG in ${playerUrl.href}`, ctx);
            return [];
        }

        // 3) Hit the streamData API with the correct referer. The API expects the id
        // in the query string (imdb=... or tmdb=...) plus type and, for TV, season/episode.
        // It validates the Turnstile-pass cookies from the solved session, so forward them.
        const streamDataUrl = new URL(config.streamDataApiUrl);
        streamDataUrl.searchParams.set(config.idType === 'tmdb' ? 'tmdb' : 'imdb', config.mediaId ?? '');
        streamDataUrl.searchParams.set('type', isTv ? 'tv' : 'movie');
        if (isTv && config.season != null && config.episode != null) {
            streamDataUrl.searchParams.set('season', String(config.season));
            streamDataUrl.searchParams.set('episode', String(config.episode));
        }
        streamDataUrl.searchParams.set('_', Date.now().toString());

        let dataText: string;
        try {
            dataText = await this.fetcher.text(ctx, streamDataUrl, {
                headers: {
                    Referer: `${playerUrl.origin}/`,
                    'User-Agent': PLAYER_UA,
                    ...(session.cookieHeader && { Cookie: session.cookieHeader }),
                },
                timeout: 8000,
            });
        } catch (err) {
            this.fetcher.getLogger().warn(`ImdbSu: streamData API error: ${err}`, ctx);
            return [];
        }

        if (!dataText) return [];

        let data: StreamDataResponse;
        try {
            data = JSON.parse(dataText);
        } catch {
            this.fetcher.getLogger().info(`ImdbSu: invalid JSON from streamData API`, ctx);
            return [];
        }

        const statusCode = data.status_code;
        if ((statusCode !== '200' && statusCode !== 200) || !data.data || !data.data.stream_urls) {
            return [];
        }

        const streamUrls: string[] = data.data.stream_urls;
        if (!streamUrls || streamUrls.length === 0) return [];

        // Prefer master.m3u8 mirrors; fall back to any m3u8 if none contain "master".
        const masterUrlStr = streamUrls.find(u => u.includes('master.m3u8'))
            ?? streamUrls.find(u => u.includes('.m3u8'))
            ?? streamUrls[0];
        if (!masterUrlStr) return [];

        const masterUrl = new URL(masterUrlStr);
        let masterM3u8: string;
        try {
            masterM3u8 = await this.fetcher.text(ctx, masterUrl, { timeout: 5000 });
        } catch {
            return [];
        }

        // Parse resolutions and extract ALL available tracks
        const lines = masterM3u8.split('\n');
        const streamsAdded: SourceResult[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]?.trim();
            if (!line) continue;

            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                let height = resMatch ? parseInt(resMatch[1]!, 10) : 0;

                let streamUrl = '';
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j] && !lines[j]!.trim().startsWith('#')) {
                        streamUrl = lines[j]!.trim();
                        break;
                    }
                }

                if (streamUrl) {
                    if (!height) height = findHeight(streamUrl) || findHeight(data.data.file_name || '') || 1080;

                    let finalStreamUrl = streamUrl;
                    if (!streamUrl.startsWith('http')) {
                        finalStreamUrl = streamUrl.startsWith('/')
                            ? masterUrl.origin + streamUrl
                            : masterUrlStr.substring(0, masterUrlStr.lastIndexOf('/') + 1) + streamUrl;
                    }

                    streamsAdded.push({
                        url: new URL(finalStreamUrl),
                        meta: {
                            title: `[ImdbSu] ${height >= 2160 ? '[4K]' : height >= 1080 ? '[1080p]' : `[${height}p]`}`,
                            bytes: 0,
                            height,
                            countryCodes: this.countryCodes,
                            season: id.season,
                            episode: id.episode,
                        }
                    });
                }
            }
        }

        // Fallback to the master M3U8 if parsing yields zero mapped chunks (e.g. standard Direct Index)
        if (streamsAdded.length === 0) {
            const fallbackHeight = findHeight(data.data.file_name || '') || 1080;
            streamsAdded.push({
                url: new URL(masterUrlStr),
                meta: {
                    title: `[ImdbSu] Auto-Select ${fallbackHeight >= 2160 ? '[4K]' : fallbackHeight >= 1080 ? '[1080p]' : `[${fallbackHeight}p]`}`,
                    bytes: 0,
                    height: fallbackHeight,
                    countryCodes: this.countryCodes,
                    season: id.season,
                    episode: id.episode,
                }
            });
        }

        results.push(...streamsAdded);

        return results;
    }

    private parseConfig(html: string): VidApiConfig | undefined {
        const match = html.match(/const\s+CONFIG\s*=\s*({[\s\S]*?});/);
        if (!match?.[1]) return undefined;
        try {
            return JSON.parse(match[1]) as VidApiConfig;
        } catch {
            return undefined;
        }
    }
}
