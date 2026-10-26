import bytes from 'bytes';
import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode, Meta } from '../types';
import { Fetcher, getTmdbId, getTmdbNameAndYear, Id } from '../utils';
import { Source, SourceResult } from './Source';

interface DownloadLink {
  url: URL;
  height: number;
  bytes: number | undefined;
  label: string;
}

const SIZE_RE = /([\d.]+)\s*(GB|MB)/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;

// Hoster URLs supported by this add-on's extractor registry.
//   - gdflix `/file/`        → GDFlix extractor (supports `/gdflix\./` host; resolves to Google video-downloads CDN, relayed)
//   - hubcloud `/drive/`|`/video/` (NOT `/packs/`) → HubCloud extractor (supports `/hubcloud/` host; resolves to seekable FSL/FSLv2 servers)
//   - gofile `/d/`           → GoFile extractor. Dual-audio (hindi) posts carry hubcloud/gdflix;
//                              hollywood posts route their top qualities via bbupload's ad-gated
//                              chunk downloader (no extractor) but usually keep a gofile fallback.
//   - links.kmhd.me `/file/` → dual-audio posts' download hub. Gated by a plain (captcha-free)
//                              SvelteKit form POST; resolveKmhd() unlocks it and maps the payload's
//                              per-hoster ids onto extractable mirrors (hubcloud/gdflix/send.cm).
// `drivehub.cfd` has no extractor — skipped.
// `*/pack/`|`*/packs/` → season/episode pack pages (not single playable files) — skipped.
const VALID_HOSTER_RE = /gdflix\.[a-z]+\/file\/|hubcloud\.[a-z]+\/(drive|video)\/|gofile\.io\/d\/|links\.kmhd\.me\/file\//i;
const KMHD_LINK_RE = /links\.kmhd\.me\/file\//i;

/** One resolved kmhd mirror set. */
interface KmhdMirrors {
  hubdrive?: URL;
  gdflix?: URL;
  sendcm?: URL;
  ffast?: URL;
  sizeBytes?: number;
  fileName?: string;
  /** SxxEyy parsed from the payload file name — series episodes only. */
  season?: number;
  episode?: number;
}


/** Parse "480p Links [1GB]" → { height: 480, bytes: ... }. 4K/2160p/1080p/720p only; 480p dropped. */
const parseQuality = (text: string): { height: number; bytes: number | undefined } => {
  let height = 0;
  if (/2160p|4k/i.test(text)) height = 2160;
  else if (/1080p/i.test(text)) height = 1080;
  else if (/720p/i.test(text)) height = 720;
  else if (/480p/i.test(text)) height = 480;

  let parsedBytes: number | undefined;
  const sizeMatch = text.match(SIZE_RE);
  if (sizeMatch) {
    parsedBytes = bytes.parse(`${sizeMatch[1]} ${sizeMatch[2]}`) ?? undefined;
  }
  return { height, bytes: parsedBytes };
};

export class KatMovieHD extends Source {
  public readonly id = 'katmoviehd';
  public readonly label = 'KatMovieHD';
  // Movies only: katmoviehd is primarily a Hindi-dubbed movie site. series posts use gated `links.kmhd.eu`
  // redirect pages + external `drivehub.cfd` hoster (neither has an extractor) and season/episode
  // `gdflix.dev/pack/<id>` / `hubcloud.foo/video/packs/<id>` pack-listing pages (not single
  // playable files). Adding series support would ship broken streams, so it is intentionally omitted.
  public readonly contentTypes: ContentType[] = ['movie'];
  public readonly countryCodes: CountryCode[] = [CountryCode.multi, CountryCode.hi];
  public readonly baseUrl = 'https://new2.katmoviehd.top';

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  public override async prewarm(ctx: Context): Promise<void> {
    try {
      await this.fetcher.text(ctx, new URL(this.baseUrl));
      this.fetcher.getLogger().info('KatMovieHD: pre-warm complete', ctx);
    } catch (error) {
      this.fetcher.getLogger().warn(`KatMovieHD: pre-warm failed: ${error}`, ctx);
    }
  }

  private clean(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private get logger() {
    return this.fetcher.getLogger();
  }

  protected async handleInternal(ctx: Context, type: ContentType, id: Id): Promise<SourceResult[]> {
    if (type !== 'movie' && type !== 'series') return [];

    const tmdbId = await getTmdbId(ctx, this.fetcher, id);
    const [name, year] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
    if (!name) return [];

    const postUrls = await this.findPosts(ctx, name, year, tmdbId.season, 2);
    if (!postUrls.length) {
      this.logger.info(`KatMovieHD: no post matched TMDB "${name}" ${year ?? ''}`, ctx);
      return [];
    }

    const results: SourceResult[] = [];
    // A title usually has a dual-audio post (kmhd hub) and/or an english post; merge both.
    for (const postUrl of postUrls) {
      // Fetch the SvelteKit data payload for the post — the content HTML (with
      // hoster anchors) is embedded inside it.
      const dataUrl = new URL(`${postUrl.pathname.replace(/\/+$/, '')}/__data.json`, this.baseUrl);
      let body: string;
      try {
        body = await this.fetcher.text(ctx, dataUrl, { headers: { Referer: this.baseUrl }, timeout: 15000 });
      } catch {
        this.logger.info(`KatMovieHD: post data fetch failed for ${postUrl.pathname}`, ctx);
        continue;
      }

      const targets = this.collectDownloadLinks(body);

      // Series posts list every episode's kmhd links (grouped 1080p/720p/480p, in episode
      // order) — resolve in order until the requested episode's qualities are found.
      const isSeries = type === 'series';
      const season = tmdbId.season ?? 1;
      const episode = tmdbId.episode ?? 1;
      let episodeHits = 0;

      for (const target of targets) {
        // 4K (2160p) + 1080p + 720p only; 480p dropped (matching SSRmovies/Worldfree4u). Users can still
        // exclude a resolution via the add-on's "Exclude resolution" config (StreamResolver honours it downstream).
        if (target.height !== 2160 && target.height !== 1080 && target.height !== 720) continue;

        // kmhd hub links expand into their extractable mirrors (hubcloud/gdflix/send.cm …).
        if (KMHD_LINK_RE.test(target.url.href)) {
          if (isSeries && episodeHits >= 2) break; // got both 1080p+720p of the episode
          if (ctx.streamDeadline && Date.now() > ctx.streamDeadline - 8000) break;

          const mirrors = await this.resolveKmhd(ctx, target.url);
          if (!mirrors) continue;

          if (isSeries) {
            // Episode identity only shows up in the payload's file name ("… S01E05 …").
            if (mirrors.season !== season || mirrors.episode !== episode) continue;
            episodeHits++;
          }

          const suffix = isSeries ? ` S${season}E${episode}` : '';
          const mirrorList: { url: URL; tag: string }[] = [
            ...(mirrors.hubdrive ? [{ url: mirrors.hubdrive, tag: 'HubCloud' }] : []),
            ...(mirrors.gdflix ? [{ url: mirrors.gdflix, tag: 'GDFlix' }] : []),
            ...(mirrors.sendcm ? [{ url: mirrors.sendcm, tag: 'SendCm' }] : []),
            ...(mirrors.ffast ? [{ url: mirrors.ffast, tag: 'Fast' }] : []),
          ];
          for (const mirror of mirrorList) {
            results.push({
              url: mirror.url,
              meta: {
                countryCodes: this.countryCodes,
                height: target.height,
                title: `${target.label}${suffix} [${mirror.tag}]`,
                ...((mirrors.sizeBytes ?? target.bytes) && { bytes: mirrors.sizeBytes ?? target.bytes }),
                ...(isSeries && { season, episode }),
                sourceLabel: this.label,
              },
            });
          }
          continue;
        } else if (isSeries) {
          // Direct hoster anchors on series posts are season packs or the watch-online
          // player — not per-episode files. Skip.
          continue;
        }

        // No `referer`: matching SSRmovies/4KHDHub format: Setting meta.referer would make
        // StreamResolver attach proxyHeaders (Referer = katmoviehd post) to the lazy /extract URL,
        // forcing Stremio to wrap it through its internal proxy and forward that Referer to the
        // final HubCloud/GDFlix CDN link — which rejects the foreign Referer and playback stalls at 0:00.
        const meta: Meta = {
          countryCodes: this.countryCodes,
          height: target.height,
          title: target.label,
          ...(target.bytes && { bytes: target.bytes }),
          sourceLabel: this.label,
        };

        results.push({ url: target.url, meta });
      }
    }

    return results;
  }

  /**
   * Unlock a links.kmhd.me/file/<slug> hub page and map its devalue payload onto
   * extractable mirrors. The gate is a SvelteKit form action: POST `<path>?/unlock&redirect=<b64>`
   * with X-Sveltekit-Action → sets an `unlocked` cookie (kept in the Fetcher jar) → the plain
   * /file/<slug> page then embeds `upload_links:{hubdrive_res:"<id>",gdflix_res:"<id>",…}` plus
   * URL templates in `links:{hubdrive_res:{link:"https://hubcloud.ist/drive/"}}` and a byte size.
   */
  private async resolveKmhd(ctx: Context, kmhdUrl: URL): Promise<KmhdMirrors | undefined> {
    // The `unlocked` cookie only covers the ONE file page named in `redirect` — every
    // /file/<slug> needs its own unlock POST (cheap, captcha-free).
    try {
      const slug = kmhdUrl.pathname.replace(/^\/file\//, '').replace(/\/+$/, '');
      const redirectB64 = Buffer.from(`/file/${slug}`).toString('base64');
      const unlockUrl = new URL(`https://links.kmhd.me/locked?/unlock&redirect=${encodeURIComponent(redirectB64)}`);
      await this.fetcher.textPost(ctx, unlockUrl, '', {
        headers: {
          // SvelteKit form actions only answer with the JSON redirect payload when the
          // request looks like a JS fetch (action header + JSON accept).
          'Accept': 'application/json',
          'X-Sveltekit-Action': 'true',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://links.kmhd.me',
          'Referer': `https://links.kmhd.me/locked?redirect=${encodeURIComponent(redirectB64)}`,
        },
        timeout: 15000,
      });
    } catch (e) {
      this.logger.info(`KatMovieHD: kmhd unlock failed for ${kmhdUrl.pathname}: ${e instanceof Error ? e.message : e}`, ctx);
    }

    try {
      const html = await this.fetcher.text(ctx, kmhdUrl, {
        headers: { Referer: 'https://links.kmhd.me/' },
        timeout: 15000,
      });

      const idOf = (key: string): string | undefined => {
        const m = html.match(new RegExp(`${key}_res\\s*:\\s*"([^"?][^"]*)"`));
        return m?.[1] && m[1] !== 'None' ? m[1] : undefined;
      };
      const templateOf = (key: string): string | undefined => {
        const m = html.match(new RegExp(`${key}_res\\s*:\\s*\\{[^}]*?link\\s*:\\s*"(https?://[^"]+)"`));
        return m?.[1];
      };
      const build = (key: string): URL | undefined => {
        const id = idOf(key);
        const tpl = templateOf(key);
        if (!id || !tpl) return undefined;
        try { return new URL(`${tpl}${id}`); } catch { return undefined; }
      };

      const hubdrive = build('hubdrive');
      // gd.kmhd.me 302s to gdflix.dev — emit the canonical host the extractor matches.
      const gdflixId = idOf('gdflix');
      const gdflix = gdflixId ? new URL(`https://gdflix.dev/file/${gdflixId}`) : undefined;
      const sendcmId = idOf('sendcm');
      const sendcm = sendcmId ? new URL(`https://send.cm/${sendcmId}`) : undefined;
      // fuckingfast.net/<id> — Buzzheavier-style direct host; left to ExternalUrl if unregistered.
      const ffastId = idOf('ffast');
      const ffastTpl = templateOf('ffast');
      const ffast = ffastId && ffastTpl ? (() => { try { return new URL(`${ffastTpl}${ffastId}`); } catch { return undefined; } })() : undefined;

      const sizeMatch = html.match(/size\s*:\s*(\d+)/);
      // File names end "…ESub-KatmovieHD.mkv" OR "…ESub-KatmovieHD mkv" (space before ext).
      const nameMatch = html.match(/name\s*:\s*"([^"]{5,200}?)[.\s](?:mkv|mp4|avi)"/i);
      // Series payloads: "Apollo Has Fallen S01E05 1080p WEB-DL …" — movies have no SxxEyy.
      const seMatch = nameMatch?.[1]?.match(/\bS(\d{1,2})E(\d{1,3})\b/i);

      if (!hubdrive && !gdflix && !sendcm && !ffast) {
        this.logger.info(`KatMovieHD: kmhd payload had no usable mirrors for ${kmhdUrl.pathname}`, ctx);
        return undefined;
      }

      return {
        ...(hubdrive && { hubdrive }),
        ...(gdflix && { gdflix }),
        ...(sendcm && { sendcm }),
        ...(ffast && { ffast }),
        ...(sizeMatch?.[1] && { sizeBytes: parseInt(sizeMatch[1], 10) }),
        ...(nameMatch?.[1] && { fileName: nameMatch[1] }),
        ...(seMatch?.[1] && seMatch?.[2] && { season: parseInt(seMatch[1], 10), episode: parseInt(seMatch[2], 10) }),
      };
    } catch (e) {
      this.logger.info(`KatMovieHD: kmhd file page failed for ${kmhdUrl.pathname}: ${e instanceof Error ? e.message : e}`, ctx);
      return undefined;
    }
  }

  /**
   * The site migrated to a SvelteKit SPA (2026) with no server-side search
   * (`/search/__data.json` answers success:false; `?s=` is ignored). Posts are
   * browsable through the SvelteKit data endpoints:
   *   /category/<cat>/__data.json?page=<n>  → streamed post list (title+slug+thumb)
   *   /<slug>/__data.json                   → streamed post incl. content HTML with hoster links
   * So discovery = scan the site's category feeds (newest-first) and match the
   * TMDB name+year against post titles.
   */
  private static readonly CATEGORY_SLUGS = [
    // dual-audio first: its posts carry the links.kmhd.me hub (multi-quality mirrors);
    // hollywood-eng posts often route top qualities through bbupload (unextractable).
    'dual-audio',
    'hollywood-eng',
    'movie-hindi-dubbed',
    'tv-series-dubbed',
    'web-series',
  ];

  /** (title, slug) pairs from a SvelteKit streamed-data payload. Values appear
   *  contiguously in the devalue array: "...","<title>","<slug>","https://<thumb>". */
  private static extractPosts(text: string): { title: string; slug: string }[] {
    const posts: { title: string; slug: string }[] = [];
    const seen = new Set<string>();
    const re = /"((?:[^"\\]|\\.){10,180}?)","([a-z0-9]+(?:-[a-z0-9]+){2,})","https?:\/\//g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1] ?? '';
      const title = raw.replace(/\\"/g, '"').replace(/&amp;/g, '&');
      const slug = m[2] ?? '';
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        posts.push({ title, slug });
      }
    }
    return posts;
  }

  /** All matching posts, in category order, capped at `limit`. */
  private async findPosts(ctx: Context, name: string, year: number | undefined, season: number | undefined, limit: number): Promise<URL[]> {
    const nameClean = this.clean(name);
    // Sites rebrand titles ("Apollo Has Fallen" vs TMDB's "Has Fallen", "Marvel's The
    // Punisher" vs slug "the-punisher-s2-hindi") — when the strict startsWith match
    // finds nothing, accept a post containing every significant name word, or a
    // majority of them when the name has several (TMDB prefixes like "Marvel's" never
    // appear in slugs).
    const nameWords = name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
    const seasonRe = season ? new RegExp(`\\bS0?${season}\\b|\\bSeason\\s+${season}\\b`, 'i') : undefined;
    const found: URL[] = [];
    const seen = new Set<string>();

    for (const category of KatMovieHD.CATEGORY_SLUGS) {
      // Pages 1..4 per category (12 posts each) — the SPA itself only surfaces
      // recent posts, so deep catalog matching isn't possible; new releases are.
      for (let page = 1; page <= 4; page++) {
        const dataUrl = new URL(`/category/${category}/__data.json${page > 1 ? `?page=${page}` : ''}`, this.baseUrl);
        let body: string;
        try {
          body = await this.fetcher.text(ctx, dataUrl, { headers: { Referer: this.baseUrl }, timeout: 12000 });
        } catch {
          break;
        }

        for (const { title, slug } of KatMovieHD.extractPosts(body)) {
          const slugClean = this.clean(slug);
          const titleClean = this.clean(title);
          const combinedClean = this.clean(`${slug} ${title}`);
          const present = nameWords.filter(w => combinedClean.includes(w)).length;
          const looseMatch = nameWords.length > 0
            && (present === nameWords.length || (nameWords.length >= 2 && present >= Math.ceil(nameWords.length / 2)));
          if (!slugClean.startsWith(nameClean) && !titleClean.startsWith(nameClean) && !looseMatch) continue;

          const matchText = `${slug} ${title}`;
          // Year filter only for movies — series titles embed the site's dub year
          // ("[2026 Canal+ Series]") which differs from TMDB's first-air year.
          const yearMatch = matchText.match(YEAR_RE);
          if (season === undefined && year && yearMatch && Math.abs(parseInt(yearMatch[0], 10) - year) > 1) continue;
          if (seasonRe && !seasonRe.test(matchText)) continue;

          if (!seen.has(slug)) {
            seen.add(slug);
            found.push(new URL(`/${slug}/`, this.baseUrl));
            if (found.length >= limit) return found;
          }
        }
      }
    }

    return found;
  }

  /**
   * Post data payload: the content HTML carries centered `<h2>` anchors to the
   * hosters, e.g. `<a href="https://hubcloud.ist/drive/x">1080p HEVC DD5.1 [4.8GB]</a>`.
   * Only collect hoster URLs supported by the extractor registry (VALID_HOSTER_RE).
   */
  private collectDownloadLinks(rawData: string): DownloadLink[] {
    // The payload embeds the content HTML as a JSON string: unescape \uXXXX
    // and \" sequences before matching anchors.
    const html = rawData
      .replace(/\\u003C/gi, '<')
      .replace(/\\u003E/gi, '>')
      .replace(/\\u0026/gi, '&')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

    const links: DownloadLink[] = [];
    const anchorRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>((?:[^<]|<(?!\/a>))*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null) {
      const href = m[1] ?? '';
      const text = (m[2] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!href || !text) continue;
      if (!VALID_HOSTER_RE.test(href)) continue;
      // Skip non-file hoster links: season/episode packs + the watch-online player.
      if (/\/packs?\/|\/play\?/i.test(href)) continue;
      const { height, bytes } = parseQuality(text);
      if (!height) continue;
      try {
        links.push({ url: new URL(href), height, bytes, label: text });
      } catch { /* invalid URL */ }
    }

    const seen = new Set<string>();
    const unique: DownloadLink[] = [];
    for (const link of links) {
      if (seen.has(link.url.href)) continue;
      seen.add(link.url.href);
      unique.push(link);
    }
    return unique;
  }
}
