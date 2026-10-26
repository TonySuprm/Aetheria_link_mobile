"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Fetcher = void 0;
/* istanbul ignore file */
const node_https_1 = require("node:https");
const async_mutex_1 = require("async-mutex");
const axios_1 = require("axios");
const cacheable_1 = require("cacheable");
const http_proxy_agent_1 = require("http-proxy-agent");
const https_proxy_agent_1 = require("https-proxy-agent");
const minimatch_1 = require("minimatch");
const socks_proxy_agent_1 = require("socks-proxy-agent");
const tough_cookie_1 = require("tough-cookie");
const error_1 = require("../error");
const types_1 = require("../types");
const env_1 = require("./env");
const puppeteer_1 = require("./puppeteer");
class Fetcher {
    static DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    DEFAULT_TIMEOUT = 20000;
    DEFAULT_QUEUE_LIMIT = 50;
    DEFAULT_QUEUE_TIMEOUT = 20000;
    DEFAULT_TIMEOUTS_COUNT_THROW = 30;
    TIMEOUT_CACHE_TTL = 60 * 60 * 1000; // 1h
    FLARESOLVERR_CACHE_TTL = 15 * 60 * 1000; // 15m
    MAX_WAIT_RETRY_AFTER = 10000;
    axios;
    logger;
    proxyConfig = new Map();
    rateLimitedCache = new cacheable_1.Cacheable({ primary: new cacheable_1.Keyv({ store: new cacheable_1.CacheableMemory({ lruSize: 1024 }) }) });
    semaphores = new Map();
    hostUserAgentMap = new Map();
    cookieJar = new tough_cookie_1.CookieJar();
    timeoutsCountCache = new cacheable_1.Cacheable({ primary: new cacheable_1.Keyv({ store: new cacheable_1.CacheableMemory({ lruSize: 1024 }) }) });
    timeoutsCountMutex = new async_mutex_1.Mutex();
    httpStatus = new Map();
    httpStatusMutex = new async_mutex_1.Mutex();
    flareSolverrCache = new cacheable_1.Cacheable({ primary: new cacheable_1.Keyv({ store: new cacheable_1.CacheableMemory({ lruSize: 1024 }) }) });
    flareSolverrMutexes = new Map();
    flareSolverrFailures = 0;
    flareSolverrOpenUntil = 0;
    FLARE_FAILURE_THRESHOLD = 5;
    FLARE_OPEN_DURATION = 30_000; // 30 seconds
    cfProtectedDomains = new Map();
    CF_DOMAIN_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    GOT_SCRAPING_BYPASS_TTL = 60 * 60 * 1000; // 1 hour
    static gotScrapingBypassedDomains = new Map();
    static gotScraping;
    PUPPETEER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    puppeteerCache = new cacheable_1.Cacheable({ primary: new cacheable_1.Keyv({ store: new cacheable_1.CacheableMemory({ lruSize: 512 }) }) });
    puppeteerMutexes = new Map();
    constructor(axios, logger) {
        this.axios = axios;
        this.logger = logger;
    }
    getLogger() {
        return this.logger;
    }
    stats() {
        return {
            httpStatus: Object.fromEntries(this.httpStatus),
            hostUserAgentMap: Object.fromEntries(this.hostUserAgentMap),
            cookieJar: this.cookieJar.toJSON(),
            flareSolverrCircuitOpen: Date.now() < this.flareSolverrOpenUntil,
            flareSolverrFailures: this.flareSolverrFailures,
            cfProtectedDomains: Object.fromEntries(this.cfProtectedDomains),
            gotScrapingBypassedDomains: Object.fromEntries(Fetcher.gotScrapingBypassedDomains),
            puppeteerBypassedDomains: Object.fromEntries(this.getPuppeteerCacheEntries()),
        };
    }
    ;
    async closeBrowser() {
        await (0, puppeteer_1.closeBrowser)(this.logger);
    }
    setCookie(url, cookieString) {
        this.cookieJar.setCookieSync(cookieString, typeof url === 'string' ? url : url.href);
    }
    async fetch(ctx, url, requestConfig) {
        return await this.queuedFetch(ctx, url, requestConfig);
    }
    ;
    async text(ctx, url, requestConfig) {
        return (await this.queuedFetch(ctx, url, requestConfig)).data;
    }
    ;
    async textPost(ctx, url, data, requestConfig) {
        return (await this.queuedFetch(ctx, url, { ...requestConfig, method: 'POST', data })).data;
    }
    ;
    async head(ctx, url, requestConfig) {
        return (await this.queuedFetch(ctx, url, { ...requestConfig, method: 'HEAD' })).headers;
    }
    ;
    async getFinalRedirectUrl(ctx, url, requestConfig, maxCount = 10, count) {
        const newRequestConfig = { ...requestConfig, method: 'HEAD', maxRedirects: 0 };
        if (count && maxCount && count >= maxCount) {
            return url;
        }
        const response = await this.queuedFetch(ctx, url, newRequestConfig);
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers['location'];
            if (!location)
                return url;
            return await this.getFinalRedirectUrl(ctx, new URL(location, url.href), newRequestConfig, maxCount, (count ?? 0) + 1);
        }
        return url;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async json(ctx, url, requestConfig) {
        const jsonRequestConfig = {
            headers: {
                Accept: 'application/json,text/plain,*/*',
            },
            ...requestConfig,
        };
        try {
            return JSON.parse(await this.text(ctx, url, jsonRequestConfig));
        }
        catch {
            throw new Error(`Invalid JSON response from ${url.href}`);
        }
    }
    async fetchWithTimeout(ctx, url, requestConfig, tryCount = 0) {
        const flareSolverrEndpoint = (0, env_1.envGet)('FLARESOLVERR_ENDPOINT');
        const cfDetectedAt = this.cfProtectedDomains.get(url.hostname);
        if (cfDetectedAt && !flareSolverrEndpoint) {
            const gotScrapingBypassedAt = Fetcher.gotScrapingBypassedDomains.get(url.hostname);
            const bypassIsFresh = gotScrapingBypassedAt !== undefined && Date.now() - gotScrapingBypassedAt < this.GOT_SCRAPING_BYPASS_TTL;
            // A fresh got-scraping bypass means the host IS reachable — a single
            // blocked path (e.g. Cloudflare-challenged /?s= search) must not fast-fail
            // every other path on the host for the whole CF_DOMAIN_CACHE_TTL.
            if (!bypassIsFresh && Date.now() - cfDetectedAt < this.CF_DOMAIN_CACHE_TTL) {
                this.logger.info(`Fast-fail CF-protected domain: ${url.hostname}`, ctx);
                throw new error_1.BlockedError(url, types_1.BlockedReason.cloudflare_challenge, {});
            }
            this.cfProtectedDomains.delete(url.hostname); // expired (or bypassable) — re-check
        }
        const proxyUrl = this.getProxyForUrl(ctx, url);
        let message = `Fetch ${requestConfig?.method ?? 'GET'} ${url}`;
        /* istanbul ignore if */
        if (requestConfig?.headers && requestConfig?.headers['Referer']) {
            message += ' with referer ' + requestConfig?.headers['Referer'];
        }
        /* istanbul ignore if */
        if (proxyUrl) {
            message += ' via proxy ' + proxyUrl;
        }
        this.logger.info(message, ctx);
        const isRateLimitedRaw = await this.rateLimitedCache.getRaw(url.host);
        /* istanbul ignore if */
        if (isRateLimitedRaw && isRateLimitedRaw.value && isRateLimitedRaw.expires) {
            const ttl = isRateLimitedRaw.expires - Date.now();
            if (ttl <= this.MAX_WAIT_RETRY_AFTER && tryCount < 1) {
                this.logger.info(`Wait out rate limit for ${url}`, ctx);
                await this.sleep(ttl);
                return await this.fetchWithTimeout(ctx, url, { ...requestConfig, queueLimit: 1 }, ++tryCount);
            }
            throw new error_1.TooManyRequestsError(url, (isRateLimitedRaw.expires - Date.now()) / 1000);
        }
        const timeouts = (await this.timeoutsCountCache.get(url.host)) ?? 0;
        if (!this.isFlareSolverrUrl(url) && timeouts >= (requestConfig?.timeoutsCountThrow ?? this.DEFAULT_TIMEOUTS_COUNT_THROW)) {
            throw new error_1.TooManyTimeoutsError(url);
        }
        let response;
        try {
            const finalUrl = new URL(url.href);
            finalUrl.username = '';
            finalUrl.password = '';
            const cookieString = this.cookieJar.getCookieStringSync(url.href);
            const forwardedProto = url.protocol.slice(0, -1);
            response = await this.axios.request({
                ...requestConfig,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en',
                    ...(url.username && { Authorization: 'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64') }),
                    'Priority': 'u=0',
                    'User-Agent': this.hostUserAgentMap.get(url.host) ?? Fetcher.DEFAULT_USER_AGENT,
                    ...(cookieString && { Cookie: cookieString }),
                    ...(ctx.ip && !requestConfig?.noProxyHeaders && {
                        'Forwarded': `by=unknown;for=${ctx.ip};host=${url.host};proto=${forwardedProto}`,
                        'X-Forwarded-For': ctx.ip,
                        'X-Forwarded-Host': url.host,
                        'X-Forwarded-Proto': forwardedProto,
                        'X-Real-IP': ctx.ip,
                    }),
                    ...requestConfig?.headers,
                },
                ...(proxyUrl && this.getProxyConfig(proxyUrl)),
                ...(!proxyUrl && { httpsAgent: new node_https_1.Agent({ rejectUnauthorized: false }) }),
                url: finalUrl.href,
                timeout: requestConfig?.timeout ?? this.DEFAULT_TIMEOUT,
                transformResponse: [data => data],
                validateStatus: () => true,
                ...(ctx.signal && { signal: ctx.signal }),
            });
        }
        catch (error) {
            await this.trackHttpStatus(ctx, url, 0);
            this.logger.info(`Got error ${error} for ${url}`, ctx);
            if (error instanceof axios_1.AxiosError && error.code === 'ECONNABORTED') {
                await this.increaseTimeoutsCount(url);
                throw new error_1.TimeoutError(url);
            }
            throw error;
        }
        await this.trackHttpStatus(ctx, url, response.status);
        this.logger.info(`Got ${response.status} (${response.statusText}) for ${url}`, ctx);
        const setCookieHeaders = response.headers['set-cookie'];
        if (setCookieHeaders) {
            const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
            for (const cookieStr of cookies) {
                try {
                    this.cookieJar.setCookieSync(cookieStr, url.href);
                }
                catch {
                    this.logger.info(`Failed to parse Set-Cookie: ${cookieStr.substring(0, 50)}`, ctx);
                }
            }
        }
        await this.decreaseTimeoutsCount(url);
        if (response.status === 429) {
            const retryAfter = parseInt(`${response.headers['retry-after']}`) * 1000;
            if (retryAfter <= this.MAX_WAIT_RETRY_AFTER && tryCount < 1) {
                this.logger.info(`Wait out rate limit for ${url.host}`, ctx);
                await this.sleep(retryAfter);
                return await this.fetchWithTimeout(ctx, url, { ...requestConfig, queueLimit: 1 }, ++tryCount);
            }
        }
        const triggeredCloudflareTurnstile = 'cf-turnstile' in response.headers;
        if (response.status && response.status >= 200 && response.status <= 399 && !triggeredCloudflareTurnstile) {
            return response;
        }
        if (response.status === 404) {
            throw new error_1.NotFoundError();
        }
        const isCloudflare403 = response.status === 403 && `${response.headers['server'] || ''}`.toLowerCase().includes('cloudflare');
        if (flareSolverrEndpoint && (response.headers['cf-mitigated'] === 'challenge' || triggeredCloudflareTurnstile || isCloudflare403)) {
            this.cfProtectedDomains.set(url.hostname, Date.now());
            let flareSolverrSuccess = false;
            // Check circuit breaker
            if (Date.now() >= this.flareSolverrOpenUntil) {
                // Check cache first
                const cachedSolution = await this.flareSolverrCache.get(url.href);
                if (cachedSolution) {
                    response.status = cachedSolution.status;
                    response.data = cachedSolution.response;
                    flareSolverrSuccess = true;
                }
                else {
                    const session = `${(0, env_1.envGetAppId)()}_${url.host}`;
                    let mutex = this.flareSolverrMutexes.get(session);
                    if (!mutex) {
                        mutex = new async_mutex_1.Mutex();
                        this.flareSolverrMutexes.set(session, mutex);
                    }
                    try {
                        const challengeResult = await mutex.runExclusive(async () => {
                            const baseData = {
                                cmd: 'request.get',
                                url: url.href,
                                session_ttl_minutes: 60,
                                maxTimeout: 60000,
                                disableMedia: true,
                                ...(proxyUrl && { proxy: { url: proxyUrl.href } }),
                            };
                            let lastResult;
                            for (let attempt = 1; attempt <= 2; attempt++) {
                                this.logger.info(`Query FlareSolverr for ${url.href} (attempt ${attempt})`, ctx);
                                const data = { ...baseData, session: `${session}_a${attempt}` };
                                const requestConfig = {
                                    method: 'POST',
                                    data,
                                    headers: { 'Content-Type': 'application/json' },
                                    timeout: 75000,
                                    queueTimeout: 120000,
                                };
                                try {
                                    lastResult = JSON.parse((await this.queuedFetch(ctx, new URL('/v1', flareSolverrEndpoint), requestConfig)).data);
                                    if (lastResult.status === 'ok') {
                                        return lastResult;
                                    }
                                    this.recordFlareSolverrResult(false);
                                    this.logger.warn(`FlareSolverr attempt ${attempt} issue: ${JSON.stringify(lastResult)}`, ctx);
                                }
                                catch (error) {
                                    // If the stream request was aborted because the 18s deadline fired, don't count
                                    // that as a FlareSolverr failure — it may still solve in the background and warm
                                    // the cookie cache for the next Stremio re-request.
                                    if (error instanceof axios_1.AxiosError && (error.code === 'ERR_CANCELED' || error.name === 'CanceledError')) {
                                        this.logger.info(`FlareSolverr attempt ${attempt} canceled by request deadline; challenge may still be solved in background`, ctx);
                                    }
                                    else {
                                        this.recordFlareSolverrResult(false);
                                        this.logger.warn(`FlareSolverr attempt ${attempt} failed for ${url.href}: ${error}`, ctx);
                                    }
                                }
                            }
                            return lastResult;
                        });
                        if (challengeResult && challengeResult.status === 'ok') {
                            this.recordFlareSolverrResult(true);
                            this.cfProtectedDomains.delete(url.hostname);
                            // Anchor the cookies at the SOLUTION's final URL, not the request URL: FlareSolverr
                            // follows redirects while solving (e.g. send.cm 302 → send.now), so the cf_clearance
                            // it returns belongs to the final host and tough-cookie rejects a cross-domain set
                            // ("Cookie not in this host's domain"). One bad cookie must never kill the solve.
                            const cookieAnchor = challengeResult.solution.url || url.href;
                            await Promise.all(challengeResult.solution.cookies.map(async (cookie) => {
                                if (!cookie.name.startsWith('cf_') && !cookie.name.startsWith('__cf') && !cookie.name.startsWith('__ddg')) {
                                    return;
                                }
                                try {
                                    await this.cookieJar.setCookie(new tough_cookie_1.Cookie({
                                        domain: cookie.domain.replace(/^\./, ''),
                                        expires: new Date(cookie.expiry * 1000),
                                        httpOnly: cookie.httpOnly,
                                        key: cookie.name,
                                        path: cookie.path,
                                        sameSite: cookie.sameSite,
                                        secure: cookie.secure,
                                        value: cookie.value,
                                    }), cookieAnchor);
                                }
                                catch (cookieError) {
                                    this.logger.info(`FlareSolverr: skipping cookie ${cookie.name} for ${cookie.domain}: ${cookieError instanceof Error ? cookieError.message : cookieError}`, ctx);
                                }
                            }));
                            this.hostUserAgentMap.set(url.host, challengeResult.solution.userAgent);
                            response.status = challengeResult.solution.status;
                            response.data = challengeResult.solution.response;
                            await this.flareSolverrCache.set(url.href, challengeResult.solution, this.FLARESOLVERR_CACHE_TTL);
                            flareSolverrSuccess = true;
                        }
                        else if (challengeResult) {
                            this.logger.warn(`FlareSolverr issue: ${JSON.stringify(challengeResult)}`, ctx);
                        }
                    }
                    catch (error) {
                        this.logger.warn(`FlareSolverr request failed for ${url.href}: ${error}`, ctx);
                    }
                }
            }
            else {
                this.logger.info(`FlareSolverr circuit breaker open — skipping for ${url.hostname}`, ctx);
            }
            if (flareSolverrSuccess) {
                return response;
            }
            // Fall through to got-scraping/Puppeteer below
        }
        if (response.headers['cf-mitigated'] === 'challenge' || triggeredCloudflareTurnstile || isCloudflare403) {
            // No FlareSolverr configured — fall through to got-scraping / Puppeteer below
            this.cfProtectedDomains.set(url.hostname, Date.now());
        }
        if (response.status === 403) {
            if (ctx.config?.mediaFlowProxyUrl && url.href.includes(ctx.config.mediaFlowProxyUrl)) {
                throw new error_1.BlockedError(url, types_1.BlockedReason.media_flow_proxy_auth, response.headers);
            }
            const gotScrapingResult = await this.fallbackToGotScraping(ctx, url, requestConfig);
            if (gotScrapingResult) {
                return gotScrapingResult;
            }
            const puppeteerResult = await this.fallbackToPuppeteer(ctx, url, requestConfig);
            if (puppeteerResult) {
                return puppeteerResult;
            }
            throw new error_1.BlockedError(url, types_1.BlockedReason.unknown, response.headers);
        }
        if (response.status === 451) {
            throw new error_1.BlockedError(url, types_1.BlockedReason.cloudflare_censor, response.headers);
        }
        if (response.status === 429) {
            const retryAfter = parseInt(`${response.headers['retry-after']}`);
            if (!isNaN(retryAfter)) {
                await this.rateLimitedCache.set(url.host, true, retryAfter * 1000);
                throw new error_1.TooManyRequestsError(url, retryAfter);
            }
            throw new error_1.TooManyRequestsError(url, 0);
        }
        throw new error_1.HttpError(url, response.status, response.statusText, response.headers);
    }
    ;
    async increaseTimeoutsCount(url) {
        await this.timeoutsCountMutex.runExclusive(async () => {
            const count = (await this.timeoutsCountCache.get(url.host)) ?? 0;
            const newCount = count + 1;
            await this.timeoutsCountCache.set(url.host, newCount, this.TIMEOUT_CACHE_TTL);
        });
    }
    async decreaseTimeoutsCount(url) {
        await this.timeoutsCountMutex.runExclusive(async () => {
            const count = (await this.timeoutsCountCache.get(url.host)) ?? 0;
            const newCount = Math.max(0, count - 1);
            await this.timeoutsCountCache.set(url.host, newCount, this.TIMEOUT_CACHE_TTL);
        });
    }
    getSemaphore(url, queueLimit, queueTimeout) {
        let sem = this.semaphores.get(url.host);
        if (!sem) {
            sem = (0, async_mutex_1.withTimeout)(new async_mutex_1.Semaphore(queueLimit), queueTimeout, new error_1.QueueIsFullError(url));
            this.semaphores.set(url.host, sem);
        }
        return sem;
    }
    async queuedFetch(ctx, url, requestConfig) {
        const queueLimit = requestConfig?.queueLimit ?? this.DEFAULT_QUEUE_LIMIT;
        const queueTimeout = requestConfig?.queueTimeout ?? this.DEFAULT_QUEUE_TIMEOUT;
        const semaphore = this.getSemaphore(url, queueLimit, queueTimeout);
        const [, release] = await semaphore.acquire();
        try {
            return await this.fetchWithTimeout(ctx, url, requestConfig);
        }
        finally {
            release();
        }
    }
    sleep(ms) {
        return new Promise(sleep => setTimeout(sleep, ms));
    }
    isFlareSolverrUrl(url) {
        const flareSolverrEndpoint = (0, env_1.envGet)('FLARESOLVERR_ENDPOINT');
        return !!flareSolverrEndpoint && url.href.startsWith(flareSolverrEndpoint);
    }
    getProxyForUrl(ctx, url) {
        if (ctx.config?.mediaFlowProxyUrl && url.href.includes(ctx.config.mediaFlowProxyUrl)) {
            return undefined;
        }
        if (this.isFlareSolverrUrl(url)) {
            return undefined;
        }
        const proxyConfig = process.env['PROXY_CONFIG'];
        if (proxyConfig) {
            for (const rule of proxyConfig.split(',')) {
                const [hostPattern, proxy] = rule.split(/:(.+)/);
                if (!hostPattern || !proxy) {
                    throw new Error(`Proxy rule "${rule}" is invalid.`);
                }
                if (hostPattern === '*' || (0, minimatch_1.minimatch)(url.host, hostPattern)) {
                    return proxy === 'false' ? undefined : new URL(proxy);
                }
            }
        }
        else if (process.env['ALL_PROXY']) {
            return new URL(process.env['ALL_PROXY']);
        }
        return undefined;
    }
    getProxyConfig(proxyUrl) {
        let proxyConfig = this.proxyConfig.get(proxyUrl.href);
        if (!proxyConfig) {
            const httpsAgent = proxyUrl.protocol === 'socks5:' ? new socks_proxy_agent_1.SocksProxyAgent(proxyUrl) : new https_proxy_agent_1.HttpsProxyAgent(proxyUrl);
            httpsAgent.options.rejectUnauthorized = false;
            proxyConfig = {
                httpAgent: proxyUrl.protocol === 'socks5:' ? new socks_proxy_agent_1.SocksProxyAgent(proxyUrl) : new http_proxy_agent_1.HttpProxyAgent(proxyUrl),
                httpsAgent,
                proxy: false,
            };
            this.proxyConfig.set(proxyUrl.href, proxyConfig);
        }
        return proxyConfig;
    }
    async trackHttpStatus(ctx, url, status) {
        if (ctx.config?.mediaFlowProxyUrl && url.href.includes(ctx.config.mediaFlowProxyUrl)) {
            return;
        }
        await this.httpStatusMutex.runExclusive(() => {
            const httpStatusCounts = this.httpStatus.get(url.host) ?? {};
            httpStatusCounts[status] = (httpStatusCounts[status] ?? 0) + 1;
            this.httpStatus.set(url.host, httpStatusCounts);
        });
    }
    recordFlareSolverrResult(success) {
        if (success) {
            this.flareSolverrFailures = 0;
        }
        else {
            this.flareSolverrFailures++;
            if (this.flareSolverrFailures >= this.FLARE_FAILURE_THRESHOLD) {
                this.flareSolverrOpenUntil = Date.now() + this.FLARE_OPEN_DURATION;
                this.flareSolverrFailures = 0;
            }
        }
    }
    async loadGotScraping() {
        if (Fetcher.gotScraping) {
            return Fetcher.gotScraping;
        }
        try {
            const mod = await import('got-scraping');
            Fetcher.gotScraping = mod.gotScraping;
            return Fetcher.gotScraping;
        }
        catch {
            return undefined;
        }
    }
    async fallbackToGotScraping(ctx, url, requestConfig) {
        if (ctx.signal?.aborted) {
            return null;
        }
        if (requestConfig?.method && requestConfig.method !== 'GET') {
            return null;
        }
        // Note: no "recently bypassed" short-circuit here. CF clearance cookies won
        // in got-scraping do not transfer to Node's TLS fingerprint, so the primary
        // axios attempt keeps 403-ing on CF-challenged hosts and every request
        // needs its own got-scraping pass (this is cheap — got-scraping reuses the
        // header generator and works consistently on challenged-but-cached paths).
        const gotScraping = await this.loadGotScraping();
        if (!gotScraping) {
            return null;
        }
        this.logger.info(`Retry with got-scraping for ${url}`, ctx);
        try {
            const cookieString = this.cookieJar.getCookieStringSync(url.href);
            const resp = await gotScraping.get(url.href, {
                headers: {
                    ...(cookieString && { Cookie: cookieString }),
                    ...(typeof requestConfig?.headers === 'object' && requestConfig.headers),
                },
                timeout: { request: requestConfig?.timeout ?? this.DEFAULT_TIMEOUT },
                ...(ctx.signal && { signal: ctx.signal }),
                throwHttpErrors: false,
            });
            if (resp.statusCode >= 200 && resp.statusCode <= 399) {
                this.logger.info(`got-scraping bypassed CF for ${url.hostname}`, ctx);
                Fetcher.gotScrapingBypassedDomains.set(url.hostname, Date.now());
                // We demonstrably know how to reach this host — lift the fast-fail mark
                // so the next request (e.g. a post page after a blocked search) retries
                // instead of throwing BlockedError for the whole CF_DOMAIN_CACHE_TTL.
                this.cfProtectedDomains.delete(url.hostname);
                const setCookieHeaders = resp.headers['set-cookie'];
                if (setCookieHeaders) {
                    const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
                    for (const cookieStr of cookies) {
                        try {
                            this.cookieJar.setCookieSync(cookieStr, url.href);
                        }
                        catch { /* ignore */ }
                    }
                }
                return {
                    status: resp.statusCode,
                    statusText: resp.statusMessage ?? '',
                    headers: resp.headers,
                    data: resp.body,
                    config: { headers: resp.headers },
                };
            }
        }
        catch (e) {
            this.logger.info(`got-scraping failed for ${url}: ${e}`, ctx);
        }
        return null;
    }
    async fallbackToPuppeteer(ctx, url, requestConfig) {
        if (ctx.signal?.aborted) {
            return null;
        }
        if (requestConfig?.method && requestConfig.method !== 'GET') {
            return null;
        }
        const bypassedAt = await this.puppeteerCache.get(url.hostname);
        if (bypassedAt && Date.now() - parseInt(bypassedAt) < this.PUPPETEER_CACHE_TTL) {
            return null;
        }
        this.logger.info(`Retry with Puppeteer for ${url}`, ctx);
        let mutex = this.puppeteerMutexes.get(url.host);
        if (!mutex) {
            mutex = new async_mutex_1.Mutex();
            this.puppeteerMutexes.set(url.host, mutex);
        }
        try {
            const html = await mutex.runExclusive(async () => {
                const browser = await (0, puppeteer_1.getBrowser)(this.logger);
                const page = await browser.newPage();
                const onAbort = () => {
                    page.close().catch(() => { });
                };
                ctx.signal?.addEventListener('abort', onAbort, { once: true });
                try {
                    await (0, puppeteer_1.stealthPage)(page);
                    await page.setUserAgent(this.hostUserAgentMap.get(url.host) ?? Fetcher.DEFAULT_USER_AGENT);
                    await page.setViewport({ width: 1280, height: 720 });
                    await page.setRequestInterception(true);
                    page.on('request', (req) => {
                        const rt = req.resourceType();
                        if (['image', 'stylesheet', 'font', 'media'].includes(rt))
                            req.abort();
                        else
                            req.continue();
                    });
                    const resp = await page.goto(url.href, { waitUntil: 'networkidle2', timeout: 60000 });
                    if (!resp || (resp.status() >= 400 && resp.status() !== 403)) {
                        throw new Error(`HTTP ${resp?.status() ?? 'failed'}: ${url.href}`);
                    }
                    return await page.content();
                }
                finally {
                    ctx.signal?.removeEventListener('abort', onAbort);
                    await page.close();
                }
            });
            if (html && html.length > 100) {
                // Don't cache false-positive: Cloudflare block/challenge pages are
                // >100 chars but are NOT the real page content.
                const isCfBlock = html.includes('Attention Required! | Cloudflare')
                    || html.includes('Sorry, you have been blocked')
                    || html.includes('cf-error')
                    || html.includes('Enable JavaScript and cookies to continue')
                    || html.includes('Just a moment');
                if (isCfBlock) {
                    this.logger.info(`Puppeteer got CF block page (not a real bypass) for ${url.hostname}`, ctx);
                    return null;
                }
                this.logger.info(`Puppeteer bypassed CF for ${url.hostname}`, ctx);
                await this.puppeteerCache.set(url.hostname, Date.now().toString(), this.PUPPETEER_CACHE_TTL);
                return {
                    status: 200,
                    statusText: 'OK',
                    headers: { 'content-type': 'text/html' },
                    data: html,
                    config: { headers: {} },
                };
            }
        }
        catch (e) {
            this.logger.info(`Puppeteer failed for ${url}: ${e}`, ctx);
        }
        return null;
    }
    getPuppeteerCacheEntries() {
        const entries = [];
        // Cacheable doesn't expose iterator, use internal store if accessible
        // For now return empty - can be enhanced later
        return entries;
    }
}
exports.Fetcher = Fetcher;
