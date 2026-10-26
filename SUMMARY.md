# SUMMARY.md — Session state for the next AI session

**Date of this session:** 2026-10-23 (session 2 — playability verification + extractor repairs + Prime port)
**Task:** Verify playability (sources → extractors → HTTP-check) of all fixed sources, repair broken extractors, port to Aetheria Prime.
**(This file REPLACES the 2026-10-23 session-1 summary. All fixes compile (`npx tsc` clean) and are verified live unless marked otherwise.)**

---

## 1. PROJECT ARCHITECTURE (how this addon works)

### Two repos, nearly identical code
- **Primary working repo:** `E:\New Coding Projects\Niphelheim\Aetheria Link` (git, branch main)
- **Port target (DONE this session):** `E:\New Coding Projects\Aetheria Prime\Aetheria link` (NOT git) — 26 fixed files copied, `npx tsc` clean, probe + UHD-extractor chain verified there. **Prime's `src/index.ts` was NOT ported** (it's Link-specific: /sources endpoint, embedded MediaFlow); **Prime's Vadapav.ts variant untouched**.

### Build/run
- TypeScript → `dist/` via `npx tsc` (do NOT use `npm run build` — it rimrafs dist). Node 22, CommonJS.
- tsconfig: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, **NO DOM lib** (don't use `document` in page callbacks inside evaluate; use string pageFunctions or `page.content()`).
- Source scrapers: `src/source/<Name>.ts`, subclasses of `Source` (`src/source/Source.ts`). Registry: `src/source/index.ts` `createSources(fetcher)`.
- **Source result cache:** SQLite `source-cache-v3`, 12h TTL, **only caches non-empty results** (empty = always retried). `Source.resetCache()` clears in scripts.
- Fetcher (`src/utils/Fetcher.ts`): axios + retries + tough-cookie jar + CF chain (axios → FlareSolverr → got-scraping → Puppeteer). Default headers include `Accept: text/html` — SvelteKit form actions need `Accept: application/json` + `X-Sveltekit-Action: true`.
- IDs: `new ImdbId('tt5950044')` / `new ImdbId('tt4574334', 5, 5)`. TMDB helpers in `src/utils/tmdb.ts`. **TMDB lookups flake transiently** — retry before diagnosing a source.
- Playability chain: Source → StreamResolver (`src/utils/StreamResolver.ts`) → `ExtractorRegistry.handle(ctx, url, meta)` (list time: allowLazy=true → /extract/ proxies; **play time (ExtractController): allowLazy omitted → eager extraction → final URLs**).

### CRITICAL runtime env
- **FlareSolverr**: docker `aetheria-flaresolverr` port 8191 — running. Health: `curl http://127.0.0.1:8191/health`.
- **MediaFlow Proxy**: `mediaflow-proxy/mediaflow-proxy.exe` port 8890 — **it dies occasionally (background shell reaped); restart if MFP:000**. Relaunch: `cd mediaflow-proxy && CONFIG_PATH="E:\New Coding Projects\Niphelheim\Aetheria Link\mediaflow-config.toml" APP__SERVER__HOST=127.0.0.1 APP__SERVER__PORT=8890 ./mediaflow-proxy.exe` (background). Password `aetheria-link-secret`.
- **`FLARESOLVERR_ENDPOINT` defaults to `http://127.0.0.1:8191/v1`** in `src/utils/env.ts` DEFAULT_ENV.
- **Headful Chrome**: probe scripts MUST set `process.env.PUPPETEER_EXECUTABLE_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'` (probe-sources.cjs does). HDEncode + ImdbSu + SendCm(headful fallback) need it.
- **AllDebrid API key:** `WgLVvqPpeX2A44vYjKZ0`
- User's own runtime: `start-all.ps1` / `_run_addon.ps1` (port 51546).

### Probe / test tooling
- **`scratch/probe-sources.cjs`** — live source probe. `node scratch/probe-sources.cjs [sourceId ...]`. Tests: movie=Superman tt5950044, series=StrangerThings tt4574334 S05E05, anime=DemonSlayer tt9335498 S01E01, donghua=PerfectWorld tt14986786 S01E01, berserk=tt22445494 S01E01, drama=SquidGame tt10919420 S01E01, recentmovie=Moana2026 tt27419466, recentseries=PunisherS2 tt5675620 S02E01. Writes `scratch/probe-results.json`.
- **`scratch/verify-playability.cjs`** — NEW this session: full playability harness. Runs source.handle → ExtractorRegistry eager extraction (play-time path) → HTTP-checks every final URL (m3u8 = #EXTM3U + variant hop, files = Range 206/200, /relay = unwraps inner url, embedded-MFP origins rewritten to configured MFP). Usage: `node scratch/verify-playability.cjs [sourceId:testKey ...]`. Writes `scratch/playability-results.json`.
- Do NOT run ts-node (hangs). Don't run jest (stale fixtures). After any src edit: `npx tsc` then re-probe.
- **Git Bash heredocs eat backslashes** — always use the Write tool for scratch scripts. `node -e` with `$`/backticks is fragile — prefer files.

---

## 2. WORK COMPLETED THIS SESSION (session 2)

### Bugs found & fixed (root cause → fix → verified)
1. **ImdbSu — waitForFunction string-arrow BUG (broke the headful solve).** `page.waitForFunction('() => …')` evaluates the string as an EXPRESSION — a bare arrow function is a truthy function object, so the wait resolved in ~26ms without ever running the predicate; `page.content()` then read the spinner page → "no CONFIG". Fix: IIFE form `'(() => …)()'`. Verified with a live predicate test (`scratch/test-waitforfn.cjs`: arrow resolves instantly, IIFE correctly waits/matches). ALSO: added `runSolveExclusive` mutex (concurrent movie+series solves tripped the per-IP Turnstile limit). **VERIFIED playable: movie 3/3 m3u8 streams.** Same arg-order bug fixed in `src/utils/puppeteer.ts` (options bag was passed as 3rd arg = predicate args).
2. **UHDMovies extractor — lp-flow SOLVED** (was blocked by "Session expired"). New chain on `en.thenaukriadda.in`: `#lp-land` (POST `_lp_http`) → `#lp-s1-form` (POST `_lp_http2/_lp_token/_lp_chain/_lp_hop_index` **after a server-enforced ~10s countdown — submitting early kills the chain**) → response JS `sc("<cookieName>","<value>",<mins>)` + `?lp_go=<name>` link → set cookie + GET → JS `window.location.replace("https://driveseed.org/r?key=…")` → driveseed file page → googleusercontent direct. `resolveSidLpFlow()` implemented, legacy WP flow kept as fallback, deadline-guard skips the 12s wait when <16s remain. **VERIFIED: 200 video/mkv 25.4GB content-length. Verified in Prime too.**
3. **Gdflix extractor — links moved into HTML comments.** File page now hides `fastcdn-dl.pages.dev/?url=<r2.dev-tokened direct link>` inside `<!-- … -->` (cheerio `$('a')` sees nothing); busycdn interstitial gone. Fix: scan RAW HTML for the pages.dev wrapper (`PAGES_WRAPPER_RE`), also keep legacy busycdn flow + direct r2.dev/googleusercontent regex fallback. r2.dev serves Range natively (206 + content-range) → returned DIRECT (no relay); googleusercontent still routed via /relay. **VERIFIED: r2.dev 206 video/x-matroska.**
4. **Fetcher — FlareSolverr cookie-domain bug.** FlareSolverr follows redirects while solving (send.cm → send.now) and returns cookies for the FINAL host; the Fetcher anchored them at the request URL → tough-cookie threw "Cookie not in this host's domain" → the whole solve failed. Fix: anchor at `solution.url`, per-cookie try/catch so one bad cookie never kills the solve.
5. **SendCm — headful fallback + honest verdict.** send.cm 302s to send.now which serves a "Download Challenge" Turnstile (`turnstile_callback` + `op=download1` form). Headless Puppeteer never solves it; switched fallback to `getHeadfulBrowser` — but even headful, **the Turnstile widget iframe never renders (only a hidden 1×1 stub) — Cloudflare stalls the challenge against automated Chrome.** Current state: plain-HTTP download2 path (when unchallenged) + headful fallback; **send.now extraction remains broken — document, don't chase.** kmhd's hubcloud/gdflix mirrors cover the content.
6. **VidSrc extractor — site redesign crash fixed.** vsembed.ru now builds `#player_iframe`'s src via a runtime-computed rotating-subdomain bundle (core-js webpack); static fetch sees an iframe with NO src, and the CloudStream/rcp flow is gone. Old code crashed (`attr('src') as string` → TypeError). Fix: null-check → try next domain → NotFoundError('pages now build the player with JS'). **vidsrc extraction is dead pending a headful rewrite — reported honestly, crash removed.** (vixsrc.to itself is CF-403 right now — site-side, MFP relays the 403.)
7. **DDLValley — stream deadline guard** added to `fetchArchiveDays` (5-day × 2-attempt archive scan could outlive the deadline; HDEncode pattern).
8. **vadapav** — flaky under concurrent FlareSolverr load only; solo re-probe OK (movie 2 / series 1).

### Hoster-side verdicts (no fix possible — documented)
- **GoFile: guest API closed.** `api.gofile.io/contents/<id>` returns 401 `error-notPremium` for guest tokens (the `wt` website token is now obfuscated JS-computed and guest access is premium-gated regardless). worldfree4u's gofile links are unplayable until policy changes.
- **Buzzheavier/fuckingfast: CDN session-bound.** Extraction itself works (file page → hx-get `/download?t=`), but the tokens are single-use, minted per solving session, and the final `ts.buzzheavier.com/d/…?v=` 403s `{"error":"forbidden"}` for ANY cold client (browser UA, Referer, session cookies, FlareSolverr UA — all tried). **Direct-play is impossible without proxying through the addon with the solving session's cookies.** SinFlix (buzzheavier-only) is effectively unplayable; KatMovieHD unaffected (hubcloud/gdflix mirrors verified).
- **VidSrc/vsembed:** JS-built player (see #6). **vixsrc.to:** CF-403 (site-side, transient?).
- **Animexin's MFP embeds (Dailymotion/DoodStream/GDrivePlayer):** MFP `/extractor/video` returns 401/502 for them — MFP's extractors are failing on these hosts (mediaflow side, not our code).

### Design flaw discovered (NOT fixed — needs a decision)
- **Kitsu emits unplayable URLs.** `handleInternal` returns `kitsu.io/api/edge/anime/<id>/episodes/<ep>` **API metadata URLs** as SourceResults — no extractor can ever resolve them. Probe "n=26" was hollow; Kitsu contributes 0 playable streams. Fix would be rewriting the source to emit actual stream/video URLs (Kitsu doesn't host videos — it would need to map to a player). Recommend: disable or repurpose; ask user.

### Playability results (verify-playability.cjs, this session)
**PLAYABLE (verified 200/206/HLS end-to-end):** katmoviehd recentmovie (6× hubcloud FSLv2/FSL + 2× gdflix r2.dev direct), katmoviehd recentseries (hubcloud), ddlvalley movie+series (AllDebrid; some links 404 but ≥1 playable each), hdencode (3/3 AllDebrid), hdhub4u (7/9 hubcloud), 4khdhub (6/8), oneddl movie (5/8 AllDebrid), animesalt (HLS master+variant 191 segs), kissasiantv (Vidmoly HLS 344 segs), kayoanime (Drive relay file 206, 290MB), acermovies (2/2 direct files 1.3/3.1GB), medeberiya (8/8 AllDebrid), imdbsu (3/3 m3u8), vadapav (source-OK solo; relay URLs by design), uhdmovies (googleusercontent direct — FIXED this session).
**NOT playable:** worldfree4u (gofile premium-gated), sinflix (buzzheavier session-bound), oneddl:series (rapidgator/nitroflare links 404-dead on the hoster side), animexin (MFP extractor failures), kitsu (unplayable API URLs), vidsrc (JS redesign), vixsrc (CF 403).

### Port to Prime — DONE
26 files copied (`git status` list minus index.ts): utils/{Fetcher,env,puppeteer,tmdb}, 17 sources (AcerMovies, Animesalt, Animexin, DDLValley, FourKHDHub, HDEncode, HDHub4u, ImdbSu, KatMovieHD, Kayoanime, KissAsianTV, Kitsu, MkvHub, SSRmovies, UHDMovies, VidVault, WorldFree4u), extractors {Gdflix, SendCm, UHDMovies, VidSrc}. Prime `npx tsc` clean; probe: uhdmovies 5/17, kissasiantv 2, kitsu 26, animesalt 1, katmoviehd 15/8 all OK; UHD extractor chain verified (200 video/mkv 25GB). **Prime's index.ts deliberately NOT overwritten** (Link's has /sources + embedded MediaFlow that Prime lacks).

---

## 2b. CRITICAL FIXES — "all links unplayable" session (2026-10-23 session 3)

1. **The port regression (THE cause of "all unplayable").** npm resolved `express ^4.21.2` to **4.22.3**, where `req.host` returns the hostname WITHOUT the port (Link; Prime runs express 5.2.1 — same semantics). `resolveHostUrl()` built every `/extract/`, `/relay/`, MediaFlow URL from `req.host` → ALL generated stream URLs pointed at `http://127.0.0.1/` (port 80, nothing there) → every link unplayable in Stremio. **Fix (both repos):** use the raw `req.headers.host` (carries the port exactly as the client addressed us) with `req.hostname` fallback. Also `env.ts` `isElfHostedInstance` now uses `req.hostname`. Verified: 228 streams, 0 portless URLs.
2. **stream_label fragments for MOVIES (user request: ".mkv/.mp4 links with the title in them").** `StreamResolver.buildUrl` previously only labeled `SxxEyy` series titles and excluded /extract/ proxies. Now every non-direct-file URL gets `#stream_label=<Sanitized.Title>.<ext>`: series `Show.Name.SxxEyy`, movies full title; the extension prefers the release's own (`…CiNEPHiLES.mkv` → label ends `.mkv`), falls back `.mp4`, `.m3u8` for HLS. Direct-video-file URLs (DramaSuki goindex etc.) stay unlabeled (hosts 403 fragmented URLs). Ported to Prime's StreamResolver too.
3. **hubdrive.bar → pixel.hubcloud.ist ad-gate (stale cache).** HubCloud-extracted `pixel.hubcloud.ist/?id=…` chains: pixel → `pixel.rohitkiskk.workers.dev` → `cryptonewz.online/dl.php?link=<google>` = HTML ad page (unplayable). Fresh hubdrive extraction now returns [] anyway: its `/file/<id>` page is a JS app (`#down-id` → POST `/ajax.php?ajax=download` → `localStorage("dls")` → `/newdl` reads it); the ajax returns an EMPTY body for non-browser sessions (`ajax=direct-download` answers `code:408 "Direct Download Unavailable"`). **Fix:** HubCloud `cacheVersion` 12→13 (both repos) to purge the poisoned cache — hubdrive links now simply don't appear instead of serving an ad-gate. hubcloud.ist results unaffected (re-extract fine).
4. **Prime "just says configure" root cause:** its saved webui config `aetheria-link-config.json` had **31 sources disabled** (everything) → `StreamController`'s language/disable filter passed 0 sources → the `⚠️ re-configure` placeholder stream. Reset to match the user's Link prefs (only oneddl/ddlvalley/hdencode/misterdonghua/donghuastream/luciferdonghua disabled). **Prime's `_run_addon.ps1` also hardcoded PORT=51546 — Link's port; Prime could never start alongside Link (EADDRINUSE).** Now 51547, MFP 8890, log path fixed to Prime's own dir.
5. **Session-3 file changes (Link):** `src/utils/context.ts` (Host header), `src/utils/env.ts` (hostname), `src/utils/StreamResolver.ts` (fragments), `src/extractor/HubCloud.ts` (cacheVersion 13). **Prime (same 4 + config/launcher):** `src/utils/context.ts`, `src/utils/StreamResolver.ts`, `src/extractor/HubCloud.ts`, `aetheria-link-config.json`, `_run_addon.ps1`. Both compile clean; both verified live (Link 51999: 228 streams / 0 portless / 0 double-ext; Prime 51547: 205 streams / 39 fragments / 0 portless).
6. **HubCloud-only filter (user request) — MkvHub, 4KHDHub, HDHub4u** (both repos). New `filterHubHosts()` in `src/utils/hub.ts` keeps only hub-family URLs (hubcloud/hubdrive/hubcdn) at each source's `handleInternal` return. Rationale: those sources' other mirrors (gofile premium-gated, send.now Turnstile-walled, misc dead hosters) never resolve for players AND their lazy-extraction prewarms dragged the sources past the first-response deadline — the "no hdhub/mkvhub links the first time" complaint. Verified cache-cleared: MkvHub n=3 hubcloud.ist only (both titles); 4khdhub n=12 / hdhub4u n=19 all hubdrive.bar; hubdrive extraction → signed r2.cloudflarestorage.com URLs play (206, correct size, filename in path). NOTE: **the 12h source cache bypasses handleInternal** — stale unfiltered results persist until cache expiry or restart (start-all.ps1 clears it each launch; `Source.resetCache()` in scripts).
7. **hubdrive.bar extraction nuance:** SOME hubdrive files extract fine (redirect → links page → r2.cloudflarestorage.com signed URL — Spider-Man ones verified playable, 88GB remux incl.), others serve the JS-only `/newdl` "Instant-DL" page (`localStorage("dls")` flow; `/ajax.php?ajax=download` returns empty for non-browser sessions) → []. Per-file variance; not fixable via plain HTTP for the JS variant.
8. **Medeberiya + Spider-Man: Brand New Day = 0 is CORRECT** — the site has no Spider-Man posts at all (its own `?s=Spider-Man` returns nothing); Superman yields 228. Not a code bug.

---

## 3. REMAINING WORK (priority order)


1. **Kitsu decision** — unplayable-by-design URLs (§2). Disable or rewrite; needs user input.
2. **VidSrc JS redesign** — needs a headful rewrite if wanted (vixsrc CF-403 CLEARED in final probe — both vixsrc tests OK again).
3. **Animexin MFP embeds** — Dood/Dailymotion/GDrivePlayer via MFP 401/502; investigate MFP versions or native extractors.
4. **Final full probe — DONE (session 2):** 35/49 pairs WORKING. Remaining empties all documented: imdbsu (Turnstile per-IP rate-limit after a day of hammering — was 3/3 playable earlier; self-heals), ddlvalley|movie (probe 100s timeout; deadline guard added), vidvault (backend dead), dramacoolg (dead), miruro (IP-ban), series-0 on ssrmovies/worldfree4u/mkvhub/acermovies/paheink/moviebox/hdencode (known/low-value), sinflix+dramasuki+dramacoolg drama singles (buzzheavier session-bound / working-but-not-retested).
5. **Keep this SUMMARY.md updated.**

### Environment caveats for the next session
- **MFP dies occasionally** — check `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8890/` before blaming extractors.
- Turnstile rate-limits per IP: HDEncode (~3 pages sequential), ImdbSu (mutex'd, 30-min session cache) — space out.
- TMDB flakes transiently — retry before diagnosing.
- Subagent fan-out hits quota — work inline.
- Do not commit to git unless the user asks.

---

## 4. KEY TECHNICAL RECIPES (reusable, new this session)

- **`waitForFunction` string gotcha:** a string pageFunction is evaluated as an expression — `'() => …'` is a truthy function object and resolves IMMEDIATELY. Always use an IIFE string: `'(() => …)()'` (see `scratch/test-waitforfn.cjs` for the proof). Also: 2nd arg is the options bag; passing `{}` + timeout as 3rd arg sends the timeout as a PREDICATE ARGUMENT.
- **UHDMovies lp-flow (en.thenaukriadda.in):** `#lp-land` POST `_lp_http` → `#lp-s1-form` POST after a **mandatory ~10s wait (server-validated)** → `sc("name","value",mins)` cookie + `?lp_go=name` → GET with cookie → JS `location.replace(driveseed.org/r?key=…)`. The "Session expired" wall = submitting the s1 form too early.
- **Gdflix comment-hidden links:** download wrappers sit inside `<!-- -->` — scan raw HTML, not cheerio anchors. Current shape: `fastcdn-dl.pages.dev/?url=<r2.dev or googleusercontent>`; r2.dev is Range-native (serve direct), googleusercontent 400s on Range (relay it).
- **FlareSolverr cross-domain cookies:** anchor solution cookies at `solution.url` (post-redirect host), not the request URL; wrap each setCookie in try/catch.
- **Playability harness pattern** (`scratch/verify-playability.cjs`): source.handle → registry.handle WITHOUT allowLazy (= play-time eager path) → classify final URL (relay → unwrap `url` param; MFP hls → GET #EXTM3U + variant hop; files → Range 0-0). Embedded-MFP URLs on ctx.hostUrl must be origin-rewritten to the configured MFP for offline verification.
- **Single-use hoster tokens (buzzheavier):** if the final CDN URL 403s for cold clients even with perfect headers, the token is session-bound — don't burn time; report as proxy-or-dead.
- **GoFile guest closure:** accounts API works, contents API 401s `error-notPremium` — guest era over.
- **Carried from session 1:** SvelteKit form-action unlock (Accept: application/json + X-Sveltekit-Action); kmhd per-file unlock cookie; Turnstile headful + mandatory Referer (ImdbSu); rotating FirePlayer hosts; Kitsu page[limit] 20 + links.next; word-overlap title matching; WP search ranking retry; zumivids data-video attrs; HDEncode Turnstile reveal; greenmotors decode; hubcloud TLD rotation.

---

## 5. VERIFIED RESULTS TABLE (latest per source, sessions 1+2)

| source | movie | series | playability |
|---|---|---|---|
| katmoviehd | 15 (Moana2026) | 8 (PunisherS2E1) | ✅ hubcloud + gdflix verified; sendcm/buzzheavier mirrors dead |
| ddlvalley | 3 | 9 | ✅ AllDebrid (≥1 playable per test; some 404 links) |
| hdencode | 3 | 0 | ✅ 3/3 AllDebrid |
| oneddl | 20 | 32 | ✅ movie 5/8; series links 404 on hoster side |
| vidsrc / vixsrc | 1 / 1 | 1 / 1 | ❌ vidsrc JS redesign; vixsrc CF-403 CLEARED (final probe OK — was transient) |
| hdhub4u | 8 | 4 | ✅ 7/9 hubcloud |
| 4khdhub | 12 | 5 | ✅ 6/8 |
| ssrmovies | 3 | 0 | series 0 (undiagnosed, low value) |
| worldfree4u | 2 | 0 | ❌ gofile premium-gated (all its links) |
| uhdmovies | 5 | 17 | ✅ **FIXED session 2** — googleusercontent direct 25GB verified (Link + Prime) |
| mkvhub | 8 | 0 | series 0 (undiagnosed, low value) |
| acermovies | 2 | 0 | ✅ 2/2 direct files |
| vadapav | 2 | 1 | ✅ source OK (relay URLs); flaky only under FlareSolverr contention |
| vidvault | 0 | 0 | their backend dead site-wide |
| medeberiya | 228 | 7 | ✅ 8/8 AllDebrid (vik1ngfile links unextractable) |
| paheink | 26 | 0 | movie-focused site |
| kissasian | — | 3 | working (not re-verified session 2) |
| kissasiantv | — | 2 | ✅ Vidmoly HLS verified |
| dramasuki | — | 1 | working (not re-verified) |
| dramacoolg | — | 0 | DEAD (redirect carousel) |
| anidap | — | 2 | working (not re-verified) |
| kayoanime | — | 1 (Berserk) | ✅ Drive relay file verified |
| animesalt | 1 | 1 | ✅ HLS verified (ravok.buzz) |
| kitsu | — | 26 | ❌ **unplayable by design** (API URLs; §2 decision needed) |
| animexin | — | 8 | ❌ MFP embed extractors fail (401/502) |
| sinflix | — | 3 | ❌ buzzheavier session-bound CDN |
| imdbsu | 3 | 3 | ✅ **FIXED session 2** (waitForFunction IIFE + mutex) — m3u8 verified; final-probe EMPTY = per-IP Turnstile cooldown after a day of solving (self-heals) |
| miruro | — | 0 | CF WAF IP-ban — needs residential proxy |
| moviebox | 1 | 0 | by-design movie-only |
