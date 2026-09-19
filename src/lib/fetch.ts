/**
 * The polite fetcher. Ported from seobot's competitor-mining module.
 *
 * Every rule here exists so that this reads public pages the way a person with
 * a browser does, only unattended: one request at a time per host, spaced,
 * robots.txt obeyed, identifying itself with a contact address. A site owner
 * who notices the traffic can tell what it is and ask it to stop.
 *
 * That posture is also what keeps the scope defensible. Event listings and
 * venue calendars are published to be read. Contact databases and social
 * networks that forbid automated access in their terms are a different
 * category, and nothing in this repo touches them — see docs/ETHICS.md.
 */
import https from 'https';
import http from 'http';
import dotenv from 'dotenv';
import logger from './logger';

// Loaded here, not only in db.ts. `UA` below is computed at import time, and
// module load order is not guaranteed to reach db.ts first — when it did not,
// CRAWLER_CONTACT was unset and every request went out with the fallback
// string. See the ASCII note on that fallback.
dotenv.config();

/**
 * The User-Agent, and why it is ASCII-only.
 *
 * Node rejects any header value outside Latin-1 with ERR_INVALID_CHAR, thrown
 * from `setHeader` before the request is ever made. The previous fallback here
 * contained an em-dash, so when CRAWLER_CONTACT was unset *every* fetch threw —
 * including the robots.txt fetch inside `isAllowed`, whose catch turned the
 * crash into `return false`. The crawler then logged "robots.txt disallows"
 * for every URL on every site and discovered nothing, while looking like it was
 * behaving politely. A contact address should never be able to break this, so
 * the value is sanitised rather than trusted.
 */
const RAW_CONTACT = process.env.CRAWLER_CONTACT?.trim();

// Strip anything a header cannot carry: non-ASCII, and the CR/LF that would
// otherwise allow header injection from a mis-set .env value.
const CONTACT = RAW_CONTACT
  ? RAW_CONTACT.replace(/[^\x20-\x7E]/g, '').replace(/[()]/g, '')
  : 'unset - set CRAWLER_CONTACT in .env';

if (!RAW_CONTACT) {
  logger.warn(
    'CRAWLER_CONTACT is unset — requests will not carry a contact address. See docs/ETHICS.md.'
  );
}

const UA = `outbound-scraping/0.1 (+prospect research; contact: ${CONTACT})`;

/**
 * Exported so the headless renderer identifies itself identically.
 *
 * Two different User-Agents from one crawl would make the traffic harder for a
 * site owner to attribute, which defeats the reason for carrying a contact
 * address at all.
 */
export const USER_AGENT = UA;

/** Minimum gap between two requests to the same host. */
const HOST_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Last request time per host.
 *
 * Per-host rather than global: a run touching twenty venue sites should not
 * serialise into a twenty-times-slower crawl when no single server is being
 * asked for more than one page at a time. The politeness that matters is
 * per-server.
 */
const lastHit = new Map<string, number>();

/**
 * Exported as `throttleHost` so the renderer shares this map rather than
 * keeping its own. A separate map would let a static fetch and a render hit
 * the same host simultaneously, quietly doubling the request rate the
 * politeness budget is supposed to cap.
 */
async function throttle(url: string): Promise<void> {
  const host = new URL(url).host;
  const since = Date.now() - (lastHit.get(host) ?? 0);
  if (since < HOST_DELAY_MS) await sleep(HOST_DELAY_MS - since);
  lastHit.set(host, Date.now());
}

function get(url: string, timeoutMs: number, redirectsLeft: number): Promise<string | null> {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    let req: http.ClientRequest;
    try {
      req = lib.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'text/html,application/json' }, timeout: timeoutMs },
      (res) => {
        const { statusCode, headers } = res;

        if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          // A couple of hops is normal (http→https, bare→www). A long chain
          // usually means a consent wall or a bot check, not a real page.
          if (redirectsLeft <= 0) return resolve(null);
          return resolve(get(new URL(headers.location, url).toString(), timeoutMs, redirectsLeft - 1));
        }

        if (statusCode === 429 || (statusCode && statusCode >= 500)) {
          res.resume();
          logger.warn(`  ${statusCode} from ${new URL(url).host} — backing off`);
          return resolve(null);
        }

        if (statusCode !== 200) {
          res.resume();
          return resolve(null);
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 3_000_000) req.destroy();
        });
        res.on('end', () => resolve(body));
      }
      );
    } catch (err) {
      // `lib.get` throws synchronously on a malformed request — most often a
      // header it cannot encode. That escapes the Promise, so it is caught here
      // and logged loudly: a crash that looks like "no data" is how a broken
      // crawler runs for an hour and reports zero findings.
      logger.error(`  request to ${url} could not be made: ${(err as Error).message}`);
      return resolve(null);
    }

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

export { throttle as throttleHost };

/** robots.txt, cached per origin for the life of the process. */
const robotsCache = new Map<string, string[]>();

async function disallowedPaths(origin: string): Promise<string[]> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  await throttle(origin);
  const body = await get(`${origin}/robots.txt`, 5000, 2);

  const rules: string[] = [];

  // A site with no robots.txt often answers /robots.txt with its SPA shell:
  // 200, text/html, no rules. Parsing that as robots is harmless today, but a
  // page whose copy happens to contain "Disallow:" at the start of a line would
  // silently forbid the whole crawl, so an HTML body is rejected outright.
  const looksLikeHtml = body != null && /^\s*(<!doctype html|<html)/i.test(body);
  if (looksLikeHtml) {
    logger.info(`  ${origin}/robots.txt returned HTML, not robots rules — treating as absent`);
  }

  if (body && !looksLikeHtml) {
    // Only the wildcard group — this crawler has no named group anywhere.
    const section = body.split(/User-agent:/i).find((s) => s.trim().startsWith('*'));
    if (section) {
      for (const line of section.split('\n')) {
        // Stop at the next group, or a bare Disallow list runs past its scope.
        if (/^\s*User-agent:/i.test(line)) break;
        const m = line.match(/^\s*Disallow:\s*(\S+)/i);
        if (m) rules.push(m[1]);
      }
    }
  }

  robotsCache.set(origin, rules);
  return rules;
}

/**
 * A disallowed path is skipped, not fetched anyway.
 *
 * Only a genuine robots.txt rule returns false here. An unparseable URL is
 * reported as such rather than folded into the same answer: "the site refused"
 * and "this crawler is broken" are different facts, and reporting the second as
 * the first is what hid the User-Agent bug above for a whole run.
 */
export async function isAllowed(url: string): Promise<boolean> {
  let origin: string;
  let pathname: string;
  try {
    ({ origin, pathname } = new URL(url));
  } catch {
    logger.warn(`  unparseable URL, skipping: ${url}`);
    return false;
  }

  return !(await disallowedPaths(origin)).some((p) => pathname.startsWith(p));
}

/**
 * Fetch a public page, respecting robots.txt and per-host rate limits.
 *
 * Returns null on anything that is not a clean 200 — a disallowed path, a
 * timeout, a bot wall. Callers treat null as "no data from here" and move on;
 * nothing in this pipeline retries around a refusal.
 */
export async function fetchPage(url: string, timeoutMs = 15000): Promise<string | null> {
  if (!(await isAllowed(url))) {
    logger.info(`  robots.txt disallows ${url} — skipping`);
    return null;
  }
  await throttle(url);
  return get(url, timeoutMs, 3);
}

/** Fetch and parse JSON from an API endpoint. */
export async function fetchJson<T>(url: string, timeoutMs = 15000): Promise<T | null> {
  await throttle(url);
  const body = await get(url, timeoutMs, 3);
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    logger.warn(`  malformed JSON from ${url}`);
    return null;
  }
}

// ── Dates ────────────────────────────────────────────────────────────────────

/**
 * Parse a listing's date, rejecting the ones that are not real.
 *
 * Both failure modes here were found in live AXS feeds and both corrupt the
 * show count, which is the number the whole ICP gate rests on:
 *
 *   "TBD"        — a placeholder for an unannounced date. Stored naively it
 *                  sorts after every real date as a string.
 *   "2083-08-15" — a typo'd year. `Date.parse` accepts it without complaint,
 *                  and one such row stretched an observation window to 57
 *                  years, which *divides* the annualised rate down and makes a
 *                  busy venue look like it sits inside the ICP band. That is
 *                  the dangerous direction: it manufactures false positives.
 *
 * So a date is only accepted if it parses AND falls in a plausible window
 * around now. Anything else returns null and the event is kept without a date —
 * still evidence the org exists, just not evidence of when it books.
 */
export function parseEventDate(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;

  const year = new Date(t).getUTCFullYear();
  const now = new Date().getUTCFullYear();

  // Announcements run ~18 months out; anything past next year plus two is a
  // data error, and anything before last decade is not this pipeline's concern.
  if (year < now - 10 || year > now + 3) return null;

  // Keep the *local* calendar date the listing states, rather than converting
  // to UTC. A 20:00 show on the US east coast is 00:00 UTC the following day,
  // so normalising through UTC would file every late-evening show under
  // tomorrow — shifting dates across a boundary for a whole class of events.
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  return new Date(t).toISOString().slice(0, 10);
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

export function stripChrome(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
}

export function textOf(html: string): string {
  return stripChrome(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract JSON-LD blocks.
 *
 * This is the highest-value parse in the repo. Schema.org `Event` markup is how
 * venues tell Google what is on, so the data arrives typed — name, startDate,
 * location, organizer, offers — instead of being guessed from prose. Any venue
 * that cares about search traffic publishes it, which is most of them. The HTML
 * heuristics elsewhere are the fallback for those that do not.
 */
export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      // A @graph wrapper is common; flatten it so callers see a plain list.
      if (parsed && typeof parsed === 'object' && '@graph' in parsed) {
        const graph = (parsed as { '@graph': unknown })['@graph'];
        if (Array.isArray(graph)) blocks.push(...graph);
      } else if (Array.isArray(parsed)) {
        blocks.push(...parsed);
      } else {
        blocks.push(parsed);
      }
    } catch {
      // Hand-written JSON-LD is frequently invalid. Skip it silently; the
      // fallback parser will have a go at the same page.
    }
  }
  return blocks;
}
