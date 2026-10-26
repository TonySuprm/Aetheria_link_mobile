"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isElfHostedInstance = exports.envIsTest = exports.envIsProd = exports.envGetAppName = exports.envGetAppId = exports.envGetRequired = exports.envGet = void 0;
const DEFAULT_ENV = {
    TMDB_ACCESS_TOKEN: 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJiYzM0YTE5NDdjM2MyM2IzZmJiMjdmYzk3NTY5MWJjYyIsIm5iZiI6MTc4Mjg1NTMwOS4wMDg5OTk4LCJzdWIiOiI2YTQ0MzY4ZDg3ZTE0NzIwNjVlNzFjYTMiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.GT88mkp2fpG3BdD0NFlIvL9W-Jh75rCludxR4FadUC8',
    // Default to the locally co-run FlareSolverr (start-all.ps1 / supervisord
    // shape) so Cloudflare-challenged fetches use it even when the process is
    // started directly. When it is absent, connection-refused trips the Fetcher's
    // circuit breaker quickly and the got-scraping/Puppeteer fallbacks take over.
    FLARESOLVERR_ENDPOINT: 'http://127.0.0.1:8191/v1',
};
const envGet = (name) => process.env[name] ?? DEFAULT_ENV[name];
exports.envGet = envGet;
const envGetRequired = (name) => {
    const value = (0, exports.envGet)(name);
    if (!value) {
        throw new Error(`Environment variable "${name}" is not configured.`);
    }
    return value;
};
exports.envGetRequired = envGetRequired;
const envGetAppId = () => process.env['MANIFEST_ID'] || 'aethlink';
exports.envGetAppId = envGetAppId;
const envGetAppName = () => process.env['MANIFEST_NAME'] || 'AethLink';
exports.envGetAppName = envGetAppName;
const envIsProd = () => process.env['NODE_ENV'] === 'production';
exports.envIsProd = envIsProd;
const envIsTest = () => process.env['NODE_ENV'] === 'test';
exports.envIsTest = envIsTest;
const isElfHostedInstance = (req) => req.hostname.endsWith('elfhosted.com');
exports.isElfHostedInstance = isElfHostedInstance;
