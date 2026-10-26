"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VidSrc = void 0;
const cheerio = __importStar(require("cheerio"));
const error_1 = require("../error");
const types_1 = require("../types");
const utils_1 = require("../utils");
const Extractor_1 = require("./Extractor");
class VidSrc extends Extractor_1.Extractor {
    id = 'vidsrc';
    label = 'VidSrc';
    ttl = 10800000; // 3h
    domains;
    constructor(fetcher, logger, domains) {
        super(fetcher, logger);
        this.domains = domains;
    }
    supports(_ctx, url) {
        return null !== url.host.match(/vidsrc|vsrc|vsembed/);
    }
    async extractInternal(ctx, url, meta) {
        // While this is a crappy thing to do, they seem to be blocking overly strict IMO
        const randomIp = `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
        const newCtx = { ...ctx, ip: randomIp };
        return this.extractUsingRandomDomain(newCtx, url, meta, [...this.domains]);
    }
    ;
    async extractUsingRandomDomain(ctx, url, meta, domains) {
        if (domains.length === 0) {
            throw new error_1.NotFoundError('All VidSrc domains exhausted');
        }
        const domainIndex = Math.floor(Math.random() * domains.length);
        const [domain] = domains.splice(domainIndex, 1);
        const newUrl = new URL(url);
        newUrl.hostname = domain;
        let html;
        try {
            html = await this.fetcher.text(ctx, newUrl, { queueLimit: 1 });
        }
        catch (error) {
            if (domains.length && (error instanceof error_1.TooManyRequestsError || error instanceof error_1.BlockedError || error instanceof error_1.NotFoundError)) {
                return this.extractUsingRandomDomain(ctx, url, meta, domains);
            }
            throw error;
        }
        const $ = cheerio.load(html.replace(/<!--/g, '').replace(/-->/g, '')); // server HTML is commented-out
        // The iframe's src is injected by the page's JS bundle on the current VidSrc build — a plain
        // HTTP fetch sees an iframe without src (or no iframe at all, e.g. block pages). Treat both as
        // a dead domain and fall through to the next one instead of crashing on undefined.
        const iframeSrc = $('#player_iframe').attr('src');
        if (!iframeSrc) {
            if (domains.length) {
                return this.extractUsingRandomDomain(ctx, url, meta, domains);
            }
            throw new error_1.NotFoundError('No player iframe found (VidSrc pages now build the player with JS)');
        }
        const iframeUrl = new URL(iframeSrc.replace(/^\/\//, 'https://'));
        const title = $('title').text().trim();
        const servers = $('.server')
            .map((_i, el) => ({ serverName: $(el).text(), dataHash: $(el).data('hash') }))
            .toArray()
            .filter(({ serverName }) => serverName === 'CloudStream Pro');
        if (servers.length === 0) {
            if (domains.length) {
                return this.extractUsingRandomDomain(ctx, url, meta, domains);
            }
            throw new error_1.NotFoundError('No CloudStream Pro server found');
        }
        return Promise.all(servers.map(async ({ serverName, dataHash }) => {
            const rcpUrl = new URL(`/rcp/${dataHash}`, iframeUrl.origin);
            const iframeHtml = await this.fetcher.text(ctx, rcpUrl, { headers: { Referer: newUrl.origin } });
            const srcMatch = iframeHtml.match(`src:\\s?'(.*)'`);
            if (!srcMatch)
                throw new error_1.NotFoundError();
            const srcPath = srcMatch[1];
            const playerUrl = new URL(srcPath, iframeUrl.origin);
            const playerHtml = await this.fetcher.text(ctx, playerUrl, { headers: { Referer: rcpUrl.href } });
            let m3u8UrlStr = await this.extractM3u8Url(ctx, playerHtml, playerUrl);
            if (!m3u8UrlStr) {
                throw new error_1.NotFoundError('No stream URL found in player HTML');
            }
            const m3u8Url = new URL(m3u8UrlStr);
            return {
                url: m3u8Url,
                format: types_1.Format.hls,
                label: serverName,
                meta: {
                    ...meta,
                    height: await (0, utils_1.guessHeightFromPlaylist)(ctx, this.fetcher, m3u8Url, { headers: { Referer: playerUrl.href } }),
                    title,
                    referer: playerUrl.href,
                },
            };
        }));
    }
    async extractM3u8Url(ctx, playerHtml, playerUrl) {
        // New VidSRC/CloudStream player uses `var master_urls = "<url> or <fallback>"`, where each
        // URL contains a `__TOKEN__` placeholder that must be replaced via `/generate.php`.
        const masterMatch = playerHtml.match(/master_urls\s*=\s*["'](https?:\/\/[^"']+)["']/i);
        const masterRaw = masterMatch?.[1];
        if (masterRaw) {
            let raw = masterRaw.trim();
            if (raw.includes(' or ')) {
                const parts = raw.split(' or ');
                raw = parts[0].trim();
            }
            return this.resolveToken(ctx, playerHtml, raw, playerUrl);
        }
        // Legacy CloudStream paths: `{v#}` hostname placeholder.
        const legacyMatch = playerHtml.match(/(https:\/\/[^"']*?{v\d}.*?)\s+or/i);
        if (legacyMatch?.[1]) {
            return legacyMatch[1].replace(/{v\d}/g, playerUrl.host);
        }
        // Direct `.m3u8` URLs, possibly with a token placeholder.
        const directMatch = playerHtml.match(/https:\/\/[^"']*\.m3u8[^"']*/i);
        if (directMatch?.[0]) {
            return this.resolveToken(ctx, playerHtml, directMatch[0], playerUrl);
        }
        return undefined;
    }
    async resolveToken(ctx, playerHtml, m3u8Url, playerUrl) {
        if (!m3u8Url.includes('__TOKEN__'))
            return m3u8Url;
        const tokenGenMatch = playerHtml.match(/\$\.get\("([^"]+generate\.php[^"]*)"/i)
            ?? playerHtml.match(/["'](https?:\/\/[^"']+generate\.php[^"']*)["']/i);
        let tokenGenUrl = tokenGenMatch?.[1];
        if (!tokenGenUrl)
            return m3u8Url;
        // Support protocol-relative token URLs.
        if (tokenGenUrl.startsWith('//'))
            tokenGenUrl = `https:${tokenGenUrl}`;
        const tokenUrl = new URL(tokenGenUrl, playerUrl.href);
        try {
            const token = await this.fetcher.text(ctx, tokenUrl, { headers: { Referer: playerUrl.href }, timeout: 5000 });
            return m3u8Url.replace(/__TOKEN__/g, token.trim());
        }
        catch {
            return m3u8Url;
        }
    }
}
exports.VidSrc = VidSrc;
