/**
 * Browser-automation layer. Puppeteer is an OPTIONAL dependency: hosts with a
 * real desktop Chrome (PC / Docker image) get full anti-bot fallbacks; hosts
 * without one (Android on-device hosting) still boot and serve every source
 * whose fetch path does not need a browser — calls degrade with a clear error
 * instead of crashing the addon.
 */
import winston from 'winston';

// Minimal structural types so this module (and sources importing types from
// here) compile even when the puppeteer package is not installed.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Browser = any;
export type Page = any;
export type CookieParam = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let puppeteerModule: any = undefined;

function loadPuppeteer(): any {
  if (puppeteerModule !== undefined) return puppeteerModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    puppeteerModule = require('puppeteer');
  } catch {
    puppeteerModule = null;
  }
  return puppeteerModule;
}

export function browserAvailable(): boolean {
  return !!process.env['PUPPETEER_EXECUTABLE_PATH'] && !!loadPuppeteer();
}

let browser: Browser = null;
let browserPromise: Promise<Browser> | null = null;

const executablePath = process.env['PUPPETEER_EXECUTABLE_PATH'];

const DEFAULT_LAUNCH_OPTIONS = {
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-hang-monitor',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-extensions',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--safebrowsing-disable-auto-update',
    '--ignore-certificate-errors',
    '--ignore-ssl-errors',
    '--ignore-certificate-errors-spki-list',
    '--disable-blink-features=AutomationControlled',
  ],
};

export async function getBrowser(logger: winston.Logger): Promise<Browser> {
  if (browser && browser.connected) {
    return browser;
  }

  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    // Clear, non-fatal degradation: callers treat this as a per-source failure.
    throw new Error('No browser automation on this host (puppeteer not installed) — source unavailable, try another');
  }

  if (!browserPromise) {
    browserPromise = (async () => {
      logger.info('Launching Puppeteer browser...');
      let launchedBrowser: Browser;
      try {
        launchedBrowser = await puppeteer.launch(DEFAULT_LAUNCH_OPTIONS);
      } catch (error) {
        // No usable browser on this host (e.g. Android on-device hosting has no
        // desktop Chrome). Reset the promise so later calls retry, and surface a
        // clear error — callers treat this as a per-source failure, not a crash.
        browserPromise = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Puppeteer browser unavailable on this host: ${message}`);
        throw new Error(`Puppeteer browser unavailable on this host: ${message}`);
      }
      logger.info('Puppeteer browser launched');

      launchedBrowser.on('disconnected', () => {
        logger.warn('Puppeteer browser disconnected');
        browser = null;
        browserPromise = null;
      });

      return launchedBrowser;
    })();
  }

  browser = await browserPromise;
  return browser;
}

let headfulBrowser: Browser = null;
let headfulBrowserPromise: Promise<Browser> | null = null;

/**
 * Headful (visible window) browser singleton. Some anti-bot widgets — notably
 * Cloudflare Turnstile as used by HDEncode's Content Protector — refuse to run
 * in headless Chrome but auto-solve in a real window. The window is parked
 * off-screen so it does not steal focus on desktop hosts.
 */
export async function getHeadfulBrowser(logger: winston.Logger): Promise<Browser> {
  if (headfulBrowser && headfulBrowser.connected) {
    return headfulBrowser;
  }

  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    throw new Error('No browser automation on this host (puppeteer not installed) — source unavailable, try another');
  }

  if (!headfulBrowserPromise) {
    headfulBrowserPromise = (async () => {
      logger.info('Launching headful Puppeteer browser...');
      let launchedBrowser: Browser;
      try {
        launchedBrowser = await puppeteer.launch({
          ...DEFAULT_LAUNCH_OPTIONS,
          headless: false,
          args: [
            ...DEFAULT_LAUNCH_OPTIONS.args,
            '--window-position=-32000,-32000',
            '--window-size=1280,900',
          ],
        });
      } catch (error) {
        headfulBrowserPromise = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Headful Puppeteer browser unavailable on this host: ${message}`);
        throw new Error(`Headful Puppeteer browser unavailable on this host: ${message}`);
      }
      logger.info('Headful Puppeteer browser launched');

      launchedBrowser.on('disconnected', () => {
        logger.warn('Headful Puppeteer browser disconnected');
        headfulBrowser = null;
        headfulBrowserPromise = null;
      });

      return launchedBrowser;
    })();
  }

  headfulBrowser = await headfulBrowserPromise;
  return headfulBrowser;
}

export async function closeBrowser(logger: winston.Logger): Promise<void> {
  if (browser) {
    logger.info('Closing Puppeteer browser...');
    await browser.close();
    browser = null;
    browserPromise = null;
  }
}

export interface PuppeteerFetchOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  waitForSelector?: string;
  waitForFunction?: string;
  timeout?: number;
  evaluate?: (page: Page) => Promise<string>;
}

export async function puppeteerFetch(
  logger: winston.Logger,
  url: string,
  options: PuppeteerFetchOptions = {},
): Promise<string> {
  const {
    waitUntil = 'networkidle2',
    waitForSelector,
    waitForFunction,
    timeout = 30000,
    evaluate,
  } = options;

  const browser = await getBrowser(logger);
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );

    await page.setViewport({ width: 1280, height: 720 });

    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const response = await page.goto(url, { waitUntil, timeout });

    if (!response || (response.status() >= 400 && response.status() !== 403)) {
      throw new Error(`HTTP ${response?.status() || 'failed'}: ${url}`);
    }

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: timeout ?? 30000 });
    }

    if (waitForFunction) {
      // 2nd arg is the options bag; 3rd would be predicate args. The string must
      // be an expression returning a boolean (a bare `() => …` arrow evaluates to
      // a truthy function object and resolves the wait immediately).
      await page.waitForFunction(waitForFunction, { timeout: timeout ?? 30000 });
    }

    if (evaluate) {
      return await evaluate(page);
    }

    return await page.content();
  } finally {
    await page.close();
  }
}

export interface FlareSolverrSolution {
  url: string;
  status: number;
  cookies: {
    domain: string;
    expiry: number;
    httpOnly: boolean;
    name: string;
    path: string;
    sameSite: string;
    secure: boolean;
    value: string;
  }[];
  userAgent: string;
  headers: Record<string, string>;
  response: string;
}

// Anti-bot stealth: many sites (e.g. MkvDrama) reject requests where
// `navigator.webdriver` is true. Apply this to every page before navigation.
export async function stealthPage(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    // @ts-expect-error - window.chrome is not typed
    window.chrome = { runtime: {} };
  });
}

export async function puppeteerFetchWithFlareSolverr(
  logger: winston.Logger,
  flareSolverrEndpoint: string,
  url: string,
  options: PuppeteerFetchOptions = {},
): Promise<string> {
  const baseEndpoint = flareSolverrEndpoint.replace(/\/v1\/?$/, '');

  logger.info(`FlareSolverr request.get for ${url}`);

  // Solve the Cloudflare challenge via FlareSolverr and obtain the clearance
  // cookies + user agent that the challenge was solved with.
  const getResult = await fetch(`${baseEndpoint}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
  });
  const getResultData = await getResult.json() as { status: string; message?: string; solution?: FlareSolverrSolution };
  if (getResultData.status !== 'ok' || !getResultData.solution) {
    throw new Error(`FlareSolverr request failed for ${url}: ${getResultData.message ?? JSON.stringify(getResultData)}`);
  }

  const solution = getResultData.solution;

  const browser = await getBrowser(logger);
  const page = await browser.newPage();

  try {
    await stealthPage(page);
    await page.setUserAgent(solution.userAgent);
    await page.setViewport({ width: 1280, height: 720 });

    // Inject the Cloudflare clearance cookies so the real browser can load the
    // page without triggering a fresh challenge.
    for (const cookie of solution.cookies) {
      const cookieParam: CookieParam = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain.replace(/^\./, ''),
        path: cookie.path || '/',
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite === 'Strict' ? 'Strict' : cookie.sameSite === 'Lax' ? 'Lax' : 'None',
      };
      if (cookie.expiry) {
        cookieParam.expires = cookie.expiry;
      }
      await page.setCookie(cookieParam);
    }

    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const response = await page.goto(url, { waitUntil: options.waitUntil ?? 'networkidle2', timeout: options.timeout ?? 60000 });

    if (!response || (response.status() >= 400 && response.status() !== 403)) {
      throw new Error(`HTTP ${response?.status() || 'failed'}: ${url}`);
    }

    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, { timeout: options.timeout ?? 60000 });
    }

    if (options.waitForFunction) {
      // 2nd arg is the options bag; 3rd would be predicate args (see note above).
      await page.waitForFunction(options.waitForFunction, { timeout: options.timeout ?? 60000 });
    }

    if (options.evaluate) {
      return await options.evaluate(page);
    }

    return await page.content();
  } finally {
    await page.close();
  }
}
