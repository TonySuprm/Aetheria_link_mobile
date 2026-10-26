"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.lastSyncedConfig = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const axios_1 = __importDefault(require("axios"));
const axios_cache_interceptor_1 = require("axios-cache-interceptor");
const axios_retry_1 = __importDefault(require("axios-retry"));
const express_1 = __importDefault(require("express"));
// eslint-disable-next-line import/no-named-as-default
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const winston_1 = __importDefault(require("winston"));
const controller_1 = require("./controller");
const error_1 = require("./error");
const extractor_1 = require("./extractor");
const source_1 = require("./source");
const HomeCine_1 = require("./source/HomeCine");
const MeineCloud_1 = require("./source/MeineCloud");
const MostraGuarda_1 = require("./source/MostraGuarda");
const utils_1 = require("./utils");
const config_1 = require("./utils/config");
const syncedConfig_1 = require("./utils/syncedConfig");
if ((0, utils_1.envIsProd)()) {
    console.log = console.warn = console.error = console.info = console.debug = () => { };
}
const logger = winston_1.default.createLogger({
    transports: [
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.cli(), winston_1.default.format.timestamp(), winston_1.default.format.printf(({ level, message, timestamp, id }) => `${timestamp} ${level} ${id}: ${message}`)),
        }),
    ],
});
// Real-time file log. Node BLOCK-buffers stdout whenever it is redirected to a file or piped
// (e.g. `node dist/index.js > addon.log` or `| Tee-Object`), so the Console transport's output
// appears to freeze partway through a request — logs "don't reach the end" even though the HTTP
// response was already sent. This makes it look like the addon hung. When stdout is not a TTY we
// automatically mirror logs to a file that is written through (not buffered), so the full log
// sequence is always visible. WSMBG_LOG_FILE overrides the default path.
const wsmbgLogFile = (0, utils_1.envGet)('WSMBG_LOG_FILE') ?? (!process.stdout.isTTY ? 'addon-realtime.log' : undefined);
if (wsmbgLogFile) {
    logger.add(new winston_1.default.transports.File({
        filename: wsmbgLogFile,
        format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.printf(({ level, message, timestamp, id }) => `${timestamp} ${level} ${id}: ${message}`)),
    }));
}
// Surface the most common misconfiguration early. Without TMDB_ACCESS_TOKEN nearly every source
// throws at resolve time, the stream response ends up empty, and Stremio shows "no streams" —
// which looks identical to a hang. Warn loudly at startup instead of failing silently per request.
if (!(0, utils_1.envGet)('TMDB_ACCESS_TOKEN')) {
    logger.error('TMDB_ACCESS_TOKEN is not set. Most sources cannot resolve IDs and will return 0 streams — Stremio will show no results. Set it before starting (see start-all.ps1 / _run_addon.ps1).');
}
const crashLogPath = (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'wsmbg_crash.log');
const safeAppendCrashLog = (msg) => {
    try {
        (0, node_fs_1.appendFileSync)(crashLogPath, `${new Date().toISOString()} ${msg}\n`);
    }
    catch {
        // If we can't write the crash log, don't crash the error handler itself
    }
};
process.on('uncaughtException', (error) => {
    const msg = `Uncaught exception caught: ${error}, cause: ${error.cause}, stack: ${error.stack}`;
    console.error(msg);
    logger.error(msg);
    safeAppendCrashLog(msg);
    process.exit(1);
});
process.on('unhandledRejection', (error) => {
    const msg = `Unhandled rejection: ${error}, cause: ${error.cause}, stack: ${error.stack}`;
    console.error(msg);
    logger.error(msg);
    safeAppendCrashLog(msg);
});
process.on('SIGTERM', () => {
    const msg = 'SIGTERM received';
    console.error(msg);
    safeAppendCrashLog(msg);
    process.exit(0);
});
process.on('SIGINT', () => {
    const msg = 'SIGINT received';
    console.error(msg);
    safeAppendCrashLog(msg);
    process.exit(0);
});
const cachedAxios = (0, axios_cache_interceptor_1.setupCache)(axios_1.default, {
    interpretHeader: true,
    storage: (0, axios_cache_interceptor_1.buildMemoryStorage)(true, 3 * 60 * 60 * 1000, 4096, 12 * 60 * 60 * 1000),
    ttl: 15 * 60 * 1000, // 15m
});
(0, axios_retry_1.default)(cachedAxios, { retries: 3, retryDelay: () => 333 });
const fetcher = new utils_1.Fetcher(cachedAxios, logger);
const sources = (0, source_1.createSources)(fetcher);
const extractors = (0, extractor_1.createExtractors)(fetcher, logger);
const addon = (0, express_1.default)();
addon.set('trust proxy', true);
addon.use(express_1.default.json());
// ── CORS — MUST be the first middleware ─────────────────────────────
// Express terminates the chain at the first matching ROUTE, so any
// addon.get() registered before a middleware never sees it. These routes
// (/sources, /config, /app-sync, /donghua-*, /stats…) are registered as
// direct routes below, so this middleware has to come FIRST or their
// responses ship without Access-Control-Allow-Origin and the Niphelheim
// WebView (https://localhost) blocks them as CORS failures — "Failed to
// fetch" on the Addons screen even though curl sees a healthy 200.
addon.options('*', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.status(204).end();
});
addon.use((_req, res, next) => {
    res.setHeader('X-Request-ID', (0, node_crypto_1.randomUUID)());
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if ((0, utils_1.envIsProd)()) {
        res.setHeader('Cache-Control', 'public, max-age=10');
    }
    next();
});
addon.use('/public', express_1.default.static('public'));
let pendingSyncConfig = null;
exports.lastSyncedConfig = null;
// ── Persisted config file ────────────────────────────────────────────
// The webui's "Save & Apply" only pushed config into the in-memory
// lastSyncedConfig, which resets to null every time the addon server
// respawns (i.e. every Aetheria Prime restart). That silently wiped the
// user's source/extractor/resolution/language toggles — only the debrid
// keys survived (via the webui's localStorage). We now mirror the config
// to a JSON file in a stable data dir so it survives restarts.
// AETHERIA_DATA_DIR is injected by main.mjs as the Electron userData path
// (survives app updates); we fall back to the addon's CWD if unset.
const persistedConfigPath = (0, utils_1.envGet)('AETHERIA_DATA_DIR')
    ? (0, node_path_1.join)((0, utils_1.envGet)('AETHERIA_DATA_DIR'), 'aetheria-link-config.json')
    : (0, node_path_1.join)(process.cwd(), 'aetheria-link-config.json');
// Load any previously persisted config into memory at startup so /config
// and the /configure page (which falls back to lastSyncedConfig) reflect
// the user's last-saved choices immediately.
try {
    if ((0, node_fs_1.existsSync)(persistedConfigPath)) {
        const saved = JSON.parse((0, node_fs_1.readFileSync)(persistedConfigPath, 'utf8'));
        if (saved && typeof saved === 'object' && Object.keys(saved).length > 0) {
            // [halcyon patch] migrate stale remote MediaFlow URLs to the embedded
            // sidecar on-device: the dailymotion sec= token is IP-bound, so a
            // remote MFP can never serve it — and the webui must not keep showing
            // a URL that cannot work.
            if ((0, config_1.embeddedMediaFlowAvailable)() &&
                typeof saved.mediaFlowProxyUrl === 'string' &&
                !saved.mediaFlowProxyUrl.includes('127.0.0.1')) {
                saved.mediaFlowProxyUrl = config_1.EMBEDDED_MEDIAFLOW_URL;
                if (!saved.mediaFlowProxyPassword)
                    saved.mediaFlowProxyPassword = 'aetheria-link-secret';
                try {
                    (0, node_fs_1.writeFileSync)(persistedConfigPath, JSON.stringify(saved, null, 2));
                }
                catch (e) {
                    logger.warn(`Failed to persist migrated config: ${e}`);
                }
                logger.info('Migrated persisted mediaFlowProxyUrl to the embedded sidecar (http://127.0.0.1:8889)');
            }
            exports.lastSyncedConfig = saved;
            pendingSyncConfig = saved;
            (0, syncedConfig_1.setSyncedConfig)(saved);
            logger.info(`Loaded persisted config from ${persistedConfigPath} (${Object.keys(saved).length} keys)`);
        }
    }
}
catch (e) {
    logger.warn(`Failed to load persisted config: ${e}`);
}
addon.get('/app-sync', (_req, res) => {
    if (pendingSyncConfig) {
        res.json({ synced: true, config: pendingSyncConfig });
        pendingSyncConfig = null;
    }
    else {
        res.json({ synced: false });
    }
});
addon.post('/app-sync', (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        // [halcyon patch] the embedded sidecar is authoritative on-device: the
        // webui re-saves whatever its localStorage holds, so a stale remote
        // MediaFlow URL would re-persist here after every "Save & Apply" and
        // defeat the boot migration. Strip it at the write path.
        if ((0, config_1.embeddedMediaFlowAvailable)() &&
            typeof req.body.mediaFlowProxyUrl === 'string' &&
            !req.body.mediaFlowProxyUrl.includes('127.0.0.1')) {
            req.body.mediaFlowProxyUrl = config_1.EMBEDDED_MEDIAFLOW_URL;
            if (!req.body.mediaFlowProxyPassword)
                req.body.mediaFlowProxyPassword = 'aetheria-link-secret';
        }
        pendingSyncConfig = req.body;
        exports.lastSyncedConfig = req.body;
        (0, syncedConfig_1.setSyncedConfig)(req.body);
        // Persist to disk so the config survives addon/server restarts.
        try {
            (0, node_fs_1.writeFileSync)(persistedConfigPath, JSON.stringify(req.body, null, 2));
        }
        catch (e) {
            logger.warn(`Failed to persist config to ${persistedConfigPath}: ${e}`);
        }
        res.json({ status: 'ok' });
    }
    else {
        res.status(400).json({ error: 'Empty body' });
    }
});
// Persisted config mirror for the main Aetheria Prime process to poll.
// The configure page only pushes to /app-sync; this endpoint lets the app
// reliably fetch the latest config even if an IPC message was missed.
// Returns the EFFECTIVE config (sidecar-forced on-device), never the raw
// persisted values, so nothing polling it can read back a dead remote URL.
addon.get('/config', (_req, res) => {
    res.json(exports.lastSyncedConfig && Object.keys(exports.lastSyncedConfig).length > 0 ? (0, config_1.getConfigWithEnvFallback)(exports.lastSyncedConfig) : {});
});
// Source registry for the Niphelheim app's Sources screen: every scraper with
// its id, label, category (debrid/hollywood/asiandrama/anime/donghua) and the
// CURRENT enabled state from the effective config. The app toggles via
// POST /app-sync with disableSource_<id> keys (same contract as the webui).
addon.get('/sources', (_req, res) => {
    const effective = (0, config_1.getConfigWithEnvFallback)(exports.lastSyncedConfig || {});
    res.json({
        sources: sources.map((s) => ({
            id: s.id,
            label: s.label,
            category: s.category,
            contentTypes: s.contentTypes,
            countryCodes: s.countryCodes,
            disabled: (0, config_1.isSourceDisabled)(effective, s),
        })),
    });
});
const node_child_process_1 = require("node:child_process");
addon.get('/debug-mediaflow', (_req, res) => {
    try {
        let output = '';
        output += '=== SUPERVISOR STATUS ===\n';
        try {
            output += (0, node_child_process_1.execSync)('supervisorctl status').toString() + '\n';
        }
        catch (e) {
            output += e.message + '\n';
        }
        output += '\n=== SUPERVISORD LOG ===\n';
        try {
            output += (0, node_child_process_1.execSync)('tail -n 100 /tmp/supervisord.log || true').toString() + '\n';
        }
        catch (e) {
            output += e.message + '\n';
        }
        res.setHeader('Content-Type', 'text/plain');
        res.send(output);
    }
    catch (err) {
        res.status(500).send(err.message);
    }
});
addon.get('/', (_req, res) => {
    res.redirect('/configure');
});
if ((0, utils_1.envIsProd)()) {
    // The MediaFlow Proxy relay (/proxy/*, /extractor/*, /_token_/*) streams
    // video: a player easily exceeds 30 segment/playlist requests per minute.
    // Local control endpoints are exempt too: the app's progress ticker polls
    // every 700ms and AddonsScreen polls /sources+/config, which otherwise
    // exhausts the 30/min window and breaks the whole settings screen.
    // Control endpoints are usually requested under a CONFIG-PREFIXED path
    // (/{encoded-config}/progress/..., /{encoded-config}/stream/...) by the
    // Niphelheim app, so a plain startsWith('/progress') check misses them and
    // the 700ms progress ticker alone exhausts the whole 30/min window — which
    // then 429s the stream request itself. Match anywhere in the path.
    // (Runs AFTER the CORS middleware above, so even a 429 carries ACAO.)
    const CONTROL_SEGMENTS = ['/progress/', '/sources', '/config', '/app-sync', '/ready', '/startup', '/stats', '/donghua'];
    const controlSkip = (req) => req.path.startsWith('/proxy/') || req.path.startsWith('/extractor/') || req.path.startsWith('/_token_')
        || req.path === '/progress' || req.path === '/sources' || req.path === '/config'
        || req.path === '/app-sync' || req.path === '/ready' || req.path === '/startup' || req.path === '/stats'
        || CONTROL_SEGMENTS.some((seg) => req.path.includes(seg));
    addon.use((0, express_rate_limit_1.default)({ windowMs: 60 * 1000, limit: 30, skip: controlSkip }));
}
const extractorRegistry = new extractor_1.ExtractorRegistry(logger, extractors);
addon.use('/', (new controller_1.ExtractController(logger, fetcher, extractorRegistry)).router);
addon.use('/', (new controller_1.ConfigureController(sources, extractors)).router);
addon.use('/', (new controller_1.ManifestController(sources, extractors)).router);
addon.use('/', (new controller_1.RelayController(logger)).router);
addon.use('/', (new controller_1.MediaFlowProxyController(logger)).router);
addon.use('/', (new controller_1.MegaProxyController(logger)).router);
const streamResolver = new utils_1.StreamResolver(logger, extractorRegistry);
addon.use('/', (new controller_1.StreamController(logger, sources, streamResolver)).router);
// error handler needs to stay at the end of the stack
addon.use((err, _req, _res, next) => {
    logger.error(`Error: ${err}, cause: ${err.cause}, stack: ${err.stack}`);
    return next(err);
});
addon.get('/startup', async (_req, res) => {
    res.json({ status: 'ok' });
});
// Clear the source-result cache on demand so users can force a fresh scrape
// (e.g. after toggling sources or updating the addon) without restarting.
addon.get('/clear-cache', async (_req, res) => {
    await source_1.Source.resetCache();
    logger.info('Source result cache cleared via /clear-cache endpoint.');
    res.json({ status: 'ok', message: 'Cache cleared' });
});
addon.get('/ready', async (_req, res) => {
    res.json({ status: 'ok' });
});
// ── Donghua Catalog Endpoint ──────────────────────────────────────────────
// Scrapes the LuciferDonghua homepage to surface the latest episode releases.
// The frontend polls this and renders items as a PosterCarousel.
// Each item contains: title, seriesTitle, episode, poster, episodeUrl, sourceUrl
addon.get('/donghua-catalog', async (_req, res) => {
    try {
        const cheerio = await import('cheerio');
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        const response = await fetch('https://luciferdonghua.in', { headers });
        const html = await response.text();
        const $ = cheerio.load(html);
        const items = [];
        const seen = new Set();
        // Latest releases section: .listupd .bsx, article.bs
        $('.listupd .bsx, .listupd article.bs').each((_, el) => {
            const $el = $(el);
            const anchor = $el.find('a[href]').first();
            const href = anchor.attr('href') || '';
            if (!href || !href.startsWith('http'))
                return;
            const headingText = $el.find('h2, h3, .tt').first().text().trim();
            const title = headingText || (anchor.attr('title') || anchor.text()).trim();
            if (!title || seen.has(href))
                return;
            seen.add(href);
            // Extract poster
            const imgEl = $el.find('img').first();
            const poster = imgEl.attr('src') && !imgEl.attr('src').includes('svg')
                ? imgEl.attr('src')
                : imgEl.attr('data-src') || '';
            // Parse episode number and quality from episode badge
            const epxText = $el.find('.epx').text().trim(); // e.g. "Ep 152", "Ep 152 [4K]"
            const epMatch = epxText.match(/[Ee]p[\s]+(\d+(?:\[\d+\])?)/);
            const episode = epMatch ? epMatch[1] : '';
            const qualityMatch = epxText.match(/\[([^\]]+)\]/);
            const quality = qualityMatch ? qualityMatch[1] : '';
            // Strip episode suffix from title to get the series name
            const cleanTitle = title
                .replace(/\s+[Ee]pisode\s+\d+.*$/i, '')
                .replace(/\s+[Ee]p\.?\s*\d+.*$/i, '')
                .replace(/\s+English Sub.*$/i, '')
                .replace(/\s+\(\d{4}\).*$/i, '')
                .trim();
            items.push({
                id: href,
                href,
                title: cleanTitle,
                fullTitle: title,
                episode,
                quality,
                poster,
                source: 'luciferdonghua',
            });
        });
        res.json({ items: items.slice(0, 50) });
    }
    catch (e) {
        logger.warn(`[DonghuaCatalog] Failed to fetch: ${e}`);
        res.json({ items: [] });
    }
});
// ── Donghua Search Endpoint ──────────────────────────────────────────────────
// Searches both LuciferDonghua and DonghuaStream in parallel with keyword expansion
// for the Aetheria Prime global search pipeline.
addon.get('/donghua-search', async (req, res) => {
    const q = (String(req.query['q'] ?? '')).trim();
    if (!q) {
        res.json({ items: [] });
        return;
    }
    try {
        const cheerio = await import('cheerio');
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        // Multi-tier query expansion for long titles with colons/subtitles
        const queries = [q];
        const cleanQ = q.replace(/[:\-—()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanQ !== q)
            queries.push(cleanQ);
        const colonParts = q.split(/[:\-—]/);
        if (colonParts.length > 1) {
            const baseTitle = colonParts[0].trim();
            const subtitle = colonParts.slice(1).join(' ').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
            if (subtitle)
                queries.push(subtitle);
            if (baseTitle)
                queries.push(baseTitle);
        }
        if (/immortal\s*slayer/i.test(q)) {
            queries.push('Battle of Immortal Slayer');
            queries.push('Battle of Gods');
        }
        else if (/battle\s*of\s*gods/i.test(q)) {
            queries.push('Battle of Immortal Slayer');
        }
        const items = [];
        const seen = new Set();
        const scrapeSite = async (baseUrl, sourceName) => {
            for (const searchQuery of queries) {
                try {
                    const searchUrl = `${baseUrl}/?s=${encodeURIComponent(searchQuery)}`;
                    const response = await fetch(searchUrl, { headers });
                    const html = await response.text();
                    const $ = cheerio.load(html);
                    let addedThisQuery = 0;
                    $('.listupd .bsx, .listupd article.bs, article.bs, .listupd article').each((_, el) => {
                        const $el = $(el);
                        const anchor = $el.find('a[href]').first();
                        const href = anchor.attr('href') || '';
                        if (!href || !href.startsWith('http'))
                            return;
                        if (seen.has(href))
                            return;
                        seen.add(href);
                        const headingText = $el.find('h2, h3, .tt').first().text().trim();
                        const title = headingText || (anchor.attr('title') || anchor.text()).trim();
                        if (!title)
                            return;
                        const imgEl = $el.find('img').first();
                        const poster = (imgEl.attr('src') && !imgEl.attr('src').includes('svg'))
                            ? imgEl.attr('src')
                            : imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || '';
                        const epxText = $el.find('.epx').text().trim();
                        const epMatch = epxText.match(/[Ee]p[\s]+(\d+)/);
                        const episode = epMatch ? epMatch[1] : '';
                        const cleanTitle = title
                            .replace(/\s+[Ee]pisode\s+\d+.*$/i, '')
                            .replace(/\s+[Ee]p\.?\s*\d+.*$/i, '')
                            .replace(/\s+English Sub.*$/i, '')
                            .replace(/\s+\(\d{4}\).*$/i, '')
                            .trim();
                        items.push({
                            id: href,
                            href,
                            title: cleanTitle,
                            fullTitle: title,
                            episode,
                            poster,
                            source: sourceName,
                            isDonghuaResult: true,
                        });
                        addedThisQuery++;
                    });
                    if (addedThisQuery > 0 && searchQuery === queries[0]) {
                        break;
                    }
                }
                catch { /* proceed to next query */ }
            }
        };
        await Promise.all([
            scrapeSite('https://luciferdonghua.in', 'luciferdonghua'),
            scrapeSite('https://donghuastream.org', 'donghuastream'),
        ]);
        res.json({ items: items.slice(0, 40) });
    }
    catch (e) {
        logger.warn(`[DonghuaSearch] Failed for query "${q}": ${e}`);
        res.json({ items: [] });
    }
});
// ── Donghua Series Episodes Endpoint ──────────────────────────────────────────
// Fetches the episode list for a direct series URL. Returns standard objects.
addon.get('/donghua-series-episodes', async (req, res) => {
    const url = (String(req.query['url'] ?? '')).trim();
    if (!url) {
        res.json({ items: [] });
        return;
    }
    try {
        const cheerio = await import('cheerio');
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        const response = await fetch(url, { headers });
        let html = await response.text();
        let $ = cheerio.load(html);
        let matchPoster = $('img.wp-post-image').attr('data-src') || $('img.wp-post-image').attr('data-lazy-src') || $('img.wp-post-image').attr('src') || '';
        if (matchPoster.includes('svg'))
            matchPoster = '';
        const matchTitle = $('.infox h1, .entry-title').text().trim();
        const items = [];
        const seenHrefs = new Set();
        const links = $('.eplister a, .bixbox.bxcl a, li.ep-item a, .episodesList a, ul.ep_list a, ul.eplister li a, a.ep-btn, a[href*="/episode-"], a[href*="/episode/"], a[href*="-movie-"]');
        links.each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href === '#' || href.endsWith('#') || href === url || href.includes('/anime/') || href.includes('/tag/') || href.includes('/category/') || href.includes('/genre/') || href.includes('/author/') || seenHrefs.has(href))
                return;
            seenHrefs.add(href);
            const text = $(el).text().trim().replace(/\s+/g, ' ');
            let epNumStr = text.match(/^0*(\d+)/)?.[1] || text.match(/(?:episode|part|pt)[^\d]*(\d+)/i)?.[1];
            if (!epNumStr && href) {
                epNumStr = href.match(/(?:episode|part|pt).*?(\d+)/i)?.[1] || href.match(/[-_]ep.*?(\d+)/i)?.[1];
            }
            const epNum = epNumStr ? parseInt(epNumStr, 10) : items.length + 1;
            items.push({
                href,
                episode: epNum,
                title: text || `Episode ${epNum}`,
                poster: matchPoster,
                seriesTitle: matchTitle
            });
        });
        // Fallback for ongoing stub pages without episodes (e.g. DonghuaStream Movie 2 page)
        if (items.length === 0 && url.includes('donghuastream.org') && url.includes('immortal-slayer')) {
            try {
                const altUrl = 'https://donghuastream.org/anime/renegade-immortal-movie-divine-descent/';
                const altResp = await fetch(altUrl, { headers });
                const altHtml = await altResp.text();
                const $alt = cheerio.load(altHtml);
                const altPoster = $alt('img.wp-post-image').attr('data-src') || $alt('img.wp-post-image').attr('data-lazy-src') || $alt('img.wp-post-image').attr('src') || matchPoster;
                $alt('.eplister a, .bixbox.bxcl a, li.ep-item a, ul.ep_list a').each((_, el) => {
                    const href = $alt(el).attr('href');
                    if (!href || href === '#' || href.endsWith('#') || href === altUrl || href.includes('/anime/') || href.includes('/tag/') || href.includes('/category/') || seenHrefs.has(href))
                        return;
                    seenHrefs.add(href);
                    const text = $alt(el).text().trim().replace(/\s+/g, ' ');
                    let epNumStr = text.match(/^0*(\d+)/)?.[1] || text.match(/(?:episode|part|pt)[^\d]*(\d+)/i)?.[1];
                    if (!epNumStr && href) {
                        epNumStr = href.match(/(?:episode|part|pt).*?(\d+)/i)?.[1] || href.match(/[-_]ep.*?(\d+)/i)?.[1];
                    }
                    const epNum = epNumStr ? parseInt(epNumStr, 10) : items.length + 1;
                    items.push({
                        href,
                        episode: epNum,
                        title: text || `Part ${epNum}`,
                        poster: altPoster.includes('svg') ? matchPoster : altPoster,
                        seriesTitle: matchTitle || 'Renegade Immortal Movie'
                    });
                });
            }
            catch { /* proceed with items */ }
        }
        // Sort ascending so Episode/Part 1 is first
        items.sort((a, b) => a.episode - b.episode);
        res.json({ items });
    }
    catch (e) {
        logger.warn(`[DonghuaEpisodes] Failed for url "${url}": ${e}`);
        res.json({ items: [] });
    }
});
// ── Donghua Stream Endpoint ──────────────────────────────────────────────────
// Scrapes embed iframes directly from an episode page URL.
addon.get('/donghua-stream', async (req, res) => {
    const url = (String(req.query['url'] ?? '')).trim();
    if (!url) {
        res.json({ streams: [] });
        return;
    }
    try {
        const cheerio = await import('cheerio');
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        const response = await fetch(url, { headers });
        const html = await response.text();
        const $ = cheerio.load(html);
        const STREAM_HOSTS = ['dailymotion.com', 'rumble.com', 'ok.ru', 'yurn.online', 'vimeo.com', 'streamtape.com', 'streamplay.co.in'];
        const isStreamHost = (src) => {
            try {
                return STREAM_HOSTS.some(h => new URL(src).hostname.includes(h));
            }
            catch {
                return false;
            }
        };
        const results = [];
        const seen = new Set();
        const addResult = (src, quality = undefined) => {
            if (!src || src.startsWith('about:') || src.startsWith('javascript:'))
                return;
            if (src.startsWith('//'))
                src = 'https:' + src;
            try {
                const parsed = new URL(src);
                if (seen.has(parsed.href))
                    return;
                seen.add(parsed.href);
                results.push(quality ? { url: parsed.href, quality, host: parsed.host } : { url: parsed.href, host: parsed.host });
            }
            catch { }
        };
        // 1. VideoObject Schema
        $('[itemtype*="VideoObject"], [itemtype*="videoobject"]').each((_, el) => {
            const embedUrl = $(el).find('[itemprop="embedUrl"]').attr('content');
            if (embedUrl)
                addResult(embedUrl, '4K');
        });
        // 2. Base64
        $('select option[value]').each((_, el) => {
            const value = $(el).attr('value');
            const label = $(el).text().trim().toLowerCase();
            if (!value || value.startsWith('http'))
                return;
            try {
                const decoded = Buffer.from(value, 'base64').toString('utf-8');
                const iframeMatch = decoded.match(/src=["']([^"']+)["']/);
                if (iframeMatch?.[1]) {
                    let quality = '4K';
                    if (label.includes('1080'))
                        quality = '1080p';
                    else if (label.includes('720'))
                        quality = '720p';
                    addResult(iframeMatch[1], quality);
                }
            }
            catch { }
        });
        // 3. Mirrors — fetch mirrors to collect all servers
        const mirrorUrls = [];
        $('select.mirror option[value], select[name="mirror"] option[value]').each((_, el) => {
            const value = $(el).attr('value') || '';
            if (value.startsWith('http') && (value.includes('/v/') || value.includes('/mirror/')))
                mirrorUrls.push(value);
        });
        for (const mirrorUrl of mirrorUrls.slice(0, 5)) {
            try {
                const mirrorHtml = await (await fetch(mirrorUrl, { headers })).text();
                const $m = cheerio.load(mirrorHtml);
                $m('[itemtype*="VideoObject"] [itemprop="embedUrl"]').each((_, el) => {
                    const embedUrl = $m(el).attr('content');
                    if (embedUrl)
                        addResult(embedUrl, '4K');
                });
                $m('iframe[src]').each((_, el) => {
                    let src = $m(el).attr('src') || '';
                    if (src.startsWith('//'))
                        src = 'https:' + src;
                    if (src && isStreamHost(src))
                        addResult(src, '4K');
                });
            }
            catch { }
        }
        // 4. Direct iframes on the episode page
        $('iframe[src]').each((_, el) => {
            let src = $(el).attr('src') || '';
            if (src.startsWith('//'))
                src = 'https:' + src;
            if (src && isStreamHost(src))
                addResult(src, '4K');
        });
        const blacklisted = ['doods.pro', 'doodstream', 'playmogo.com', 't.co', 'blogspot.com', 'luciferdonghua.in', 'donghuastream.org'];
        const filtered = results.filter(r => !blacklisted.some(host => r.host.includes(host)));
        const OKRU_QUALITY_RANK = { ultra: 8, quad: 7, full: 6, hd: 5, sd: 4, low: 3, lowest: 2, mobile: 1 };
        const extractedResults = [];
        await Promise.all(filtered.map(async (r) => {
            // ── Rumble pre-extraction (handles Cloudflare 403 and extracts master adaptive HLS) ──
            if (r.host.includes('rumble.com')) {
                try {
                    let rumbleHtml = '';
                    let rumbleStatus = 0;
                    try {
                        rumbleHtml = await fetcher.text({}, new URL(r.url), {
                            noProxyHeaders: true,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                                'Accept-Language': 'en-US,en;q=0.9',
                            },
                        });
                        rumbleStatus = 200;
                    }
                    catch {
                        const httpsModule = await import('node:https');
                        rumbleHtml = await new Promise((resolve, reject) => {
                            const u = new URL(r.url);
                            const req = httpsModule.get({
                                hostname: u.hostname,
                                path: u.pathname + u.search,
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                    'Accept-Language': 'en-US,en;q=0.9',
                                    'Referer': 'https://rumble.com/',
                                },
                            }, (res) => {
                                rumbleStatus = res.statusCode ?? 0;
                                let d = '';
                                res.on('data', chunk => { d += chunk; });
                                res.on('end', () => resolve(d));
                            });
                            req.on('error', reject);
                            req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
                        });
                    }
                    // 410 Gone = video permanently deleted from Rumble channel. 404 = not found.
                    // Skip these entirely — returning the embed URL would produce an unplayable stream.
                    if (rumbleStatus === 410 || rumbleStatus === 404) {
                        logger.warn(`Rumble embed ${r.url} returned HTTP ${rumbleStatus} (deleted) — skipping dead stream`);
                        return;
                    }
                    if (rumbleHtml) {
                        const unescaped = rumbleHtml.split('\\/').join('/');
                        // 1. HLS VOD master playlist — HIGHEST PRIORITY (multi-bitrate, mpv picks highest automatically)
                        const hlsVodMatch = unescaped.match(/(https:[^\s"'\\]+hls-vod[^\s"'\\]+playlist\.m3u8[^\s"'\\]*)/) ||
                            unescaped.match(/(https:[^\s"'\\]+hls-vod[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
                        const hlsVodUrl = hlsVodMatch?.[1];
                        if (hlsVodUrl) {
                            extractedResults.push({ url: hlsVodUrl, host: 'rumble.com', quality: '4K', isHls: true });
                            return;
                        }
                        // 2. Chunklist HLS sorted by resolution — pick the highest, skip the 320x148 sprite
                        const chunkEntries = [];
                        const blockRe = /"tar"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+chunklist[^"]+)"[^}]*\}[^}]*"meta"\s*:\s*\{[^}]*"w"\s*:\s*(\d+)[^}]*"h"\s*:\s*(\d+)/g;
                        for (const bm of unescaped.matchAll(blockRe)) {
                            const w = parseInt(bm[2] ?? '0', 10);
                            const h = parseInt(bm[3] ?? '0', 10);
                            const cu = bm[1];
                            if (w > 320 && cu)
                                chunkEntries.push({ w, h, chunkUrl: cu });
                        }
                        if (chunkEntries.length > 0) {
                            chunkEntries.sort((a, b) => b.w - a.w);
                            const best = chunkEntries[0];
                            logger.warn(`Rumble: selected chunklist ${best.w}x${best.h}`);
                            extractedResults.push({ url: best.chunkUrl, host: 'rumble.com', quality: `${best.h}p`, isHls: true });
                            return;
                        }
                        // 3. Any other .m3u8 as HLS fallback
                        const anyHlsMatch = unescaped.match(/"url"\s*:\s*"(https:[^"]+\.m3u8[^"]*)"/);
                        const anyHlsUrl = anyHlsMatch?.[1];
                        if (anyHlsUrl) {
                            extractedResults.push({ url: anyHlsUrl, host: 'rumble.com', quality: r.quality || '4K', isHls: true });
                            return;
                        }
                        // 4. MP4 fallback — exclude the tiny sprite/thumbnail (size <= 2MB)
                        const mp4BlockRe = /"mp4"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+\.mp4[^"]*)"[^}]*\}[^}]*"meta"\s*:\s*\{[^}]*"size"\s*:\s*(\d+)/g;
                        let bestMp4 = null;
                        for (const mm of unescaped.matchAll(mp4BlockRe)) {
                            const size = parseInt(mm[2] ?? '0', 10);
                            const mpUrl = mm[1];
                            if (mpUrl && size > 2_000_000 && (!bestMp4 || size > bestMp4.size)) {
                                bestMp4 = { url: mpUrl, size };
                            }
                        }
                        if (bestMp4) {
                            extractedResults.push({ url: bestMp4.url, host: 'rumble.com', quality: r.quality || 'HD', isHls: false });
                            return;
                        }
                    }
                }
                catch (e) {
                    logger.warn(`Rumble donghua extraction failed: ${e}`);
                }
                extractedResults.push(r);
                return;
            }
            // ── Dailymotion pre-extraction ────────────────────────────────────────────
            // geo.dailymotion.com/player/xxx.html?video=ID is an HTML player page —
            // mpv cannot play it directly. Convert to canonical dailymotion.com/video/ID
            // so mpv's yt-dlp integration handles auth, Cloudflare, and CDN token generation.
            // NOTE: The DM metadata API returns HLS URLs from cdndirector.dailymotion.com
            // which return HTTP 403 when fetched server-side. The yt-dlp path is the only
            // reliable approach.
            if (r.host.includes('dailymotion.com')) {
                try {
                    const dmUrl = new URL(r.url);
                    const videoId = dmUrl.searchParams.get('video') ||
                        dmUrl.pathname.match(/\/video\/([a-zA-Z0-9_-]+)/)?.[1];
                    if (videoId) {
                        const canonUrl = `https://www.dailymotion.com/video/${videoId}`;
                        extractedResults.push({ url: canonUrl, host: 'www.dailymotion.com', quality: r.quality || '4K', isHls: true });
                        return;
                    }
                }
                catch { /* skip */ }
                // No video ID found — keep original embed URL as last resort
                extractedResults.push(r);
                return;
            }
            // ── ok.ru pre-extraction ──────────────────────────────────────────────────
            if (!r.host.includes('ok.ru')) {
                extractedResults.push(r);
                return;
            }
            try {
                const embedHtml = await (await fetch(r.url, { headers })).text();
                const dataOptsMatch = embedHtml.match(/data-options="([^"]+)"/);
                if (!dataOptsMatch) {
                    extractedResults.push(r);
                    return;
                }
                const decoded = (dataOptsMatch[1] || '')
                    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
                    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
                const opts = JSON.parse(decoded);
                let meta = opts?.flashvars?.metadata || opts?.metadata;
                let flashvars = opts?.flashvars || opts;
                if (typeof meta === 'string') {
                    try {
                        meta = JSON.parse(meta);
                    }
                    catch { }
                }
                const hlsUrl = flashvars?.hlsManifestUrl || meta?.hlsManifestUrl;
                if (hlsUrl) {
                    extractedResults.push({ url: hlsUrl, host: new URL(hlsUrl).host, quality: r.quality || '4K', isHls: true });
                    return;
                }
                const videos = meta?.videos || flashvars?.videos || [];
                if (videos.length > 0) {
                    const best = videos.sort((a, b) => (OKRU_QUALITY_RANK[b.name] || 0) - (OKRU_QUALITY_RANK[a.name] || 0))[0];
                    if (best?.url) {
                        extractedResults.push({ url: best.url, host: new URL(best.url).host, quality: best.name });
                        return;
                    }
                }
                extractedResults.push(r);
            }
            catch {
                extractedResults.push(r);
            }
        }));
        // Format into standard stream array
        const formatted = extractedResults.map((r, index) => {
            const host = typeof r.host === 'string' ? r.host : '';
            const providerLabel = host.includes('rumble') || host.includes('cdn.rumble') ? 'Rumble'
                : host.includes('ok.ru') || host.includes('mycdn.me') || host.includes('vkuservideo') || host.includes('vkuser') || host.includes('okcdn') ? 'OK.ru'
                    : host.includes('dailymotion') || host.includes('cdndirector') ? 'Dailymotion'
                        : host.includes('streamplay') ? 'Streamplay'
                            : 'Direct';
            return {
                url: r.url,
                name: providerLabel,
                title: r.quality ? `${providerLabel} [${r.quality}]` : `${providerLabel} HD`,
                _addonIndex: -100 + index,
                provider: 'donghua-native'
            };
        });
        res.json({ streams: formatted });
    }
    catch (e) {
        logger.warn(`[DonghuaStream] Failed for url "${url}": ${e}`);
        res.json({ streams: [] });
    }
});
let lastLiveProbeRequestsTimestamp = 0;
addon.get('/live', async (req, res) => {
    const ctx = (0, utils_1.contextFromRequestAndResponse)(req, res);
    const sources = [
        new HomeCine_1.HomeCine(fetcher),
        new MeineCloud_1.MeineCloud(fetcher),
        new MostraGuarda_1.MostraGuarda(fetcher),
    ];
    const hrefs = [
        ...sources.map(source => source.baseUrl),
        'https://cloudnestra.com',
    ];
    const results = new Map();
    let blockedCount = 0;
    let errorCount = 0;
    const fetchFactories = hrefs.map(href => async () => {
        const url = new URL(href);
        try {
            await fetcher.head(ctx, url);
            results.set(url.host, 'ok');
        }
        catch (error) {
            if (error instanceof error_1.BlockedError) {
                results.set(url.host, 'blocked');
                blockedCount++;
            }
            else {
                results.set(url.host, 'error');
                errorCount++;
            }
            (0, error_1.logErrorAndReturnNiceString)(ctx, logger, href, error);
        }
    });
    if (Date.now() - lastLiveProbeRequestsTimestamp > 60000 || 'force' in req.query) { // every minute
        await Promise.all(fetchFactories.map(fn => fn()));
        lastLiveProbeRequestsTimestamp = Date.now();
    }
    const details = Object.fromEntries(results);
    if (blockedCount > 0) {
        // TODO: fail health check and try to get a clean IP if infra is ready
        logger.warn('IP might be not clean and leading to blocking.', ctx);
        res.json({ status: 'ok', details });
    }
    else if (errorCount === sources.length) {
        res.status(503).json({ status: 'error', details });
    }
    else {
        res.json({ status: 'ok', ipStatus: 'ok', details });
    }
});
addon.get('/stats', async (_req, res) => {
    res.json({
        extractorRegistry: extractorRegistry.stats(),
        fetcher: fetcher.stats(),
        sources: source_1.Source.stats(),
    });
});
// Explicit prewarm trigger: called by main.mjs after FlareSolverr becomes ready.
// This re-triggers source prewarming in case the initial attempt ran before
// FlareSolverr was available (race condition during app startup).
let prewarmInProgress = false;
addon.get('/prewarm', async (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString(), inProgress: prewarmInProgress });
    if (prewarmInProgress)
        return;
    prewarmInProgress = true;
    logger.info('[Prewarm] Received explicit /prewarm trigger — re-warming sources...');
    const prewarmHost = ((0, utils_1.envGet)('HOST')?.trim() || (0, utils_1.envGet)('BEAMUP_HOST')) ?? `http://127.0.0.1:${parseInt((0, utils_1.envGet)('PORT') || '51546')}`;
    const prewarmCtxLocal = {
        hostUrl: new URL(prewarmHost),
        id: 'prewarm',
        config: (0, config_1.getConfigWithEnvFallback)(undefined),
    };
    // Re-warm Puppeteer if FlareSolverr endpoint is now available
    if ((0, utils_1.envGet)('FLARESOLVERR_ENDPOINT')) {
        (0, utils_1.getBrowser)(logger).catch((e) => logger.warn(`[Prewarm] Puppeteer re-warm failed: ${e}`));
    }
    // Re-warm all sources in background
    (async () => {
        try {
            await Promise.allSettled(sources.map(s => s.prewarm(prewarmCtxLocal).catch(() => { })));
            logger.info('[Prewarm] All source prewarms complete.');
        }
        finally {
            prewarmInProgress = false;
        }
    })().catch(() => { prewarmInProgress = false; });
});
const port = parseInt((0, utils_1.envGet)('PORT') || '51546');
(async () => {
    // Clear stale caches first so the first request doesn't hit old URLs.
    if ((0, utils_1.envGet)('CACHE_FILES_DELETE_ON_START')) {
        await (0, utils_1.clearCache)(logger);
    }
    // ALWAYS clear the in-memory + SQLite source-result cache on startup so that
    // scraper/extractor fixes take effect immediately. Without this, results from
    // before a code change are served from the 12h SQLite-backed cache and users
    // see stale (e.g. empty) stream lists until the TTL expires.
    // NOTE: resetCache() is async — we must await it so the SQLite secondary store
    // is fully wiped before any stream request is served.
    await source_1.Source.resetCache();
    logger.info('Source result cache cleared on startup.');
    // The public hostname used during pre-warm. HOST must either be unset or a
    // valid origin; an empty string would make `new URL()` throw and kill startup.
    const startupHost = ((0, utils_1.envGet)('HOST')?.trim() || (0, utils_1.envGet)('BEAMUP_HOST')) ?? `http://127.0.0.1:${port}`;
    const startupCtx = {
        hostUrl: new URL(startupHost),
        id: 'prewarm',
        config: (0, config_1.getConfigWithEnvFallback)(undefined),
    };
    // Guarantee the embedded MediaFlow Proxy sidecar is up even when the
    // host starts the process directly (no supervisor script) — without it
    // every /proxy/* playback dies with ECONNREFUSED. Runs in the
    // background: it must never delay the /startup healthcheck.
    (0, utils_1.ensureEmbeddedMediaFlowProxy)(logger).catch((error) => logger.warn(`MediaFlow Proxy sidecar bootstrap failed: ${error instanceof Error ? error.message : String(error)}`));
    (0, utils_1.startMediaFlowWatchdog)(logger);
    // Start listening immediately so the /startup healthcheck passes before
    // any slow sidecars or pre-warms have finished. Bind to 0.0.0.0 so
    // IPv4-only clients can always reach the port.
    addon.listen(port, '0.0.0.0', () => {
        logger.info(`Add-on Repository URL: http://0.0.0.0:${port}/manifest.json (BOUND)`);
    });
    // Pre-warm Puppeteer browser if FLARESOLVERR_ENDPOINT is configured.
    // Run in the background so it does not delay the healthcheck.
    if ((0, utils_1.envGet)('FLARESOLVERR_ENDPOINT')) {
        (async () => {
            try {
                logger.info('Pre-warming Puppeteer browser...');
                await (0, utils_1.getBrowser)(logger);
                logger.info('Puppeteer browser ready');
            }
            catch (error) {
                logger.warn(`Failed to pre-warm Puppeteer: ${error}`);
            }
        })().catch(() => { });
    }
    // Pre-warm "critical" sources so the first requests already see populated
    // caches. This is run in the background because it can take 10s-60s on a
    // cold start, and we must answer the /startup probe first.
    const criticalSourceIds = new Set();
    if ((0, utils_1.envGet)('FLARESOLVERR_ENDPOINT')) {
        criticalSourceIds.add('ddlvalley');
    }
    criticalSourceIds.add('oneddl');
    criticalSourceIds.add('hdencode');
    const prewarmPromise = (source) => source.prewarm(startupCtx).catch((error) => {
        logger.warn(`${source.id} pre-warm failed: ${error}`);
    });
    (async () => {
        const criticalPrewarms = [];
        const nonCriticalPrewarms = [];
        for (const source of sources) {
            if (criticalSourceIds.has(source.id)) {
                criticalPrewarms.push(prewarmPromise(source));
            }
            else {
                nonCriticalPrewarms.push(prewarmPromise(source));
            }
        }
        await Promise.race([
            Promise.allSettled(criticalPrewarms),
            new Promise(resolve => setTimeout(resolve, 60_000)),
        ]);
        logger.info('Critical source pre-warms complete (or safety timeout reached)');
        for (const promise of nonCriticalPrewarms) {
            promise.catch(() => { });
        }
    })().catch(() => { });
})().catch((error) => {
    logger.error(`Fatal startup error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
