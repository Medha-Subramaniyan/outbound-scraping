/**
 * Headless rendering, for the pages plain HTTP cannot read.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Measured across seven independent venues, static fetch found 2 email
 * addresses in total and rendering found 18 — including named people
 * (`jtaylor@thecedar.org`, `bruce@emptybottle.com`, `tracey@thechapelsf.com`)
 * that were simply not in the served HTML. Those are the contacts worth having:
 * docs/ROADMAP.md's rule is that a named human beats a role mailbox, and on a
 * modern venue site the named human is usually behind a client-side render.
 *
 * ── Why it is opt-in rather than the default ─────────────────────────────────
 *
 * A browser costs roughly 20x the time and memory of an HTTP GET, and it runs
 * the site's JavaScript — a meaningfully larger footprint on someone else's
 * server than the "read it like a person with a browser, only unattended"
 * posture in docs/ETHICS.md. So the static path stays the default and stays
 * first: rendering is a fallback for when the cheap read came back empty, not
 * a replacement for it.
 *
 * Everything the static fetcher promises still holds here. Rendering goes
 * through the same robots.txt check and the same per-host delay, carries the
 * same identifying User-Agent, and loads no resource the page does not ask for.
 *
 * ── Playwright is a dev dependency, on purpose ───────────────────────────────
 *
 * It is required lazily, inside the function. Anyone who never renders never
 * needs the browser binary installed, and `discover`/`score`/`export` keep
 * working on a machine that has not run `npx playwright install chromium`.
 * A missing install degrades to "no data from here", the same as a timeout.
 */
import { isAllowed, throttleHost, USER_AGENT } from './fetch';
import logger from './logger';

/** One browser for the whole process, started on first use. */
let browser: unknown = null;
let launchFailed = false;

/**
 * Resource types a prospecting crawl never needs.
 *
 * Blocking these is both faster and politer: it avoids pulling megabytes of
 * imagery and third-party tracking off a venue's CDN to read a contact page.
 */
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet']);

async function getBrowser(): Promise<unknown | null> {
  if (browser) return browser;
  if (launchFailed) return null;

  try {
    // Lazy require, not a top-level import: it keeps Playwright optional at
    // runtime, so the rest of the CLI works on a machine with no browser
    // installed. See the header note.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright') as typeof import('playwright');
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    return browser;
  } catch (err) {
    launchFailed = true;
    logger.warn(
      `Headless rendering unavailable (${(err as Error).message.split('\n')[0]}). ` +
        `Run: npx playwright install chromium`
    );
    return null;
  }
}

/** Close the shared browser. Safe to call when one was never started. */
export async function closeBrowser(): Promise<void> {
  if (!browser) return;
  try {
    await (browser as { close(): Promise<void> }).close();
  } catch {
    // A browser that already died is the state we wanted anyway.
  }
  browser = null;
}

/**
 * Fetch a page with a real browser, returning its rendered HTML.
 *
 * Returns null on anything that is not a clean render — robots.txt refusal, a
 * timeout, a missing Playwright install. Callers treat null as "no data from
 * here", exactly as they do for `fetchPage`.
 */
export async function renderPage(url: string, timeoutMs = 25000): Promise<string | null> {
  if (!(await isAllowed(url))) {
    logger.info(`  robots.txt disallows ${url} — skipping`);
    return null;
  }

  const b = await getBrowser();
  if (!b) return null;

  // The same per-host spacing the static fetcher uses. Rendering is heavier per
  // page, so skipping the delay here would be the rudest thing in the repo.
  await throttleHost(url);

  const context = await (
    b as { newContext(o: unknown): Promise<PlaywrightContext> }
  ).newContext({
    userAgent: USER_AGENT,
    javaScriptEnabled: true,
    // A desktop viewport: some sites render a reduced DOM at phone widths, and
    // a contact page that collapses its team list would defeat the point.
    viewport: { width: 1280, height: 900 },
  });

  try {
    const page = await context.newPage();

    await page.route('**/*', (route: PlaywrightRoute) => {
      const type = route.request().resourceType();
      return BLOCKED_RESOURCES.has(type) ? route.abort() : route.continue();
    });

    // `domcontentloaded` rather than `networkidle`: a page with an analytics
    // heartbeat or a live chat widget never goes idle, and waiting for it
    // burns the full timeout on sites that rendered fine a second in.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Give client-side content a moment to mount. This is the whole reason for
    // rendering, so it is worth a fixed, small wait even when the DOM is ready.
    await page.waitForTimeout(1200);

    return await page.content();
  } catch (err) {
    logger.info(`  render failed for ${url}: ${(err as Error).message.split('\n')[0]}`);
    return null;
  } finally {
    await context.close();
  }
}

// Minimal structural types for the lazily-required Playwright API. Importing
// its real types at module scope would make the dependency non-optional.
interface PlaywrightRoute {
  request(): { resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

interface PlaywrightPage {
  route(pattern: string, handler: (route: PlaywrightRoute) => unknown): Promise<void>;
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  content(): Promise<string>;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
