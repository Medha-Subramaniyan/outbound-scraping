/**
 * Contact discovery — the gap between a qualified org and a person to write to.
 *
 * Reads an org's own /about, /team, /contact pages. Nothing else: no contact
 * databases, no social profiles, no login walls. See docs/ETHICS.md.
 *
 * ── Two rules this file exists to enforce ────────────────────────────────────
 *
 * 1. **A named human beats a role address.** `booking@venue.com` is read by an
 *    intern or by nobody. The whole value of scraping the team page rather than
 *    buying a list is that it yields "Sarah Chen, Talent Buyer" — a person whose
 *    persona routes the message. Role addresses are still recorded, because a
 *    firehose is better than silence, but they are marked `role` so the export
 *    can sort them last and reply rates stay honest.
 *
 * 2. **Nothing is ever guessed.** The schema has an `inferred` provenance and
 *    this file never writes it. A pattern-guessed address that is wrong is spam
 *    sent to an uninvolved stranger, and the cost of that lands on someone who
 *    never entered this pipeline. If the address was not published, we do not
 *    have it.
 */
import crypto from 'crypto';
import { db } from '../lib/db';
import { fetchPage, stripChrome } from '../lib/fetch';
import { renderPage } from '../lib/render';
import { matchPersona } from '../icp';
import logger from '../lib/logger';
import type { EmailSource } from '../types';

/**
 * Pages that carry people, in order of how likely they are to name one.
 *
 * /team and /staff first because they are structurally a list of humans.
 * /contact often carries only a form and a role address, so it is tried but
 * expected to yield less.
 */
const CONTACT_PATHS = [
  '/about',
  '/about-us',
  '/team',
  '/our-team',
  '/staff',
  '/people',
  '/contact',
  '/contact-us',
  '/booking',
];

/**
 * Local-parts that are a function, not a person.
 *
 * Matched exactly against the part before the @. These become `role`; anything
 * else that appears near a human name becomes `published`.
 */
const ROLE_LOCALPARTS = new Set([
  'booking', 'bookings', 'book', 'talent', 'info', 'contact', 'hello', 'hi',
  'admin', 'office', 'mail', 'email', 'general', 'inquiries', 'enquiries',
  'press', 'media', 'marketing', 'events', 'event', 'shows', 'tickets',
  'boxoffice', 'box-office', 'support', 'help', 'sales', 'management',
  'submissions', 'submit', 'demos', 'epk', 'talentbuyer', 'privateevents',
  // Departmental mailboxes found on live venue contact pages. Without these
  // an address like accessibility@ is classified 'published', which in the
  // export reads as "a real person answers here" — it does not.
  'accessibility', 'ada', 'hr', 'jobs', 'careers', 'volunteer', 'security',
  'lostandfound', 'lost', 'rentals', 'venuerental', 'catering', 'merch',
  'production', 'tech', 'webmaster', 'billing', 'accounting', 'accounts',
  'noreply', 'no-reply', 'donotreply', 'newsletter', 'subscribe', 'feedback',
]);

/**
 * Addresses that are never a prospect.
 *
 * Image filenames and asset hashes routinely parse as valid email addresses
 * (`logo@2x.png`), and site-builder boilerplate leaks vendor addresses onto
 * every page of a template. Both would otherwise land in the database as real
 * contacts at the venue.
 */
const JUNK_DOMAINS = [
  'example.com', 'domain.com', 'yourdomain.com', 'email.com', 'sentry.io',
  'wixpress.com', 'squarespace.com', 'godaddy.com', 'wordpress.com',
  'shopify.com', 'cloudflare.com', 'schema.org', 'w3.org', 'googleapis.com',
  // Domain brokers. A venue whose site has lapsed gets parked, and the parking
  // page advertises a sales address — `interested@domainmarket.com` was
  // scraped as a live contact at a venue that no longer exists.
  'domainmarket.com', 'hugedomains.com', 'afternic.com', 'sedo.com',
  'dan.com', 'namecheap.com', 'buydomains.com', 'undeveloped.com',
];

const JUNK_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|mp4|pdf)$/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface FoundContact {
  fullName: string | null;
  title: string | null;
  email: string | null;
  emailSource: EmailSource | null;
  profileUrl: string | null;
  sourceUrl: string;
}

/** True when an address is a real, person-or-role address at a real domain. */
export function isUsableEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (JUNK_EXTENSIONS.test(lower)) return false;

  const at = lower.lastIndexOf('@');
  if (at < 1) return false;
  const domain = lower.slice(at + 1);

  if (JUNK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;

  // A domain with no dot, or a single-character TLD, is a parse artefact.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false;

  return true;
}

/**
 * Function words that make a local-part a role even inside a longer string.
 *
 * Exact matching alone misses the common real-world shapes:
 * `bowerypartnerships@`, `booking.fmam@`, `venue-info@`. These are still
 * mailboxes nobody owns personally, and marking them `published` tells the
 * export that a named human reads them.
 *
 * Kept deliberately short and unambiguous. A word like "media" would catch a
 * person called Amedia, so only strings that do not occur inside ordinary
 * given names are listed.
 */
const ROLE_SUBSTRINGS = [
  'booking', 'partnership', 'submission', 'boxoffice', 'box-office',
  'noreply', 'no-reply', 'donotreply', 'newsletter', 'inquir', 'enquir',
  'accessibility', 'volunteer', 'webmaster',
  // 'manager' alone is a mailbox, not a person: `manager@hideoutchicago.com`
  // has no name on it. A *named* manager still arrives as `jane@`, so this
  // costs nothing real.
  'manager@',
  // The wedding/private-event market is explicitly out of scope in src/icp.ts,
  // so `weddinginquiries@` is not merely a role address — it is the wrong
  // business entirely, and should never reach a concert-promoter sequence.
  'wedding', 'privateevent', 'privaterental', 'banquet',
];

/** `role` for a functional mailbox, `published` for anything else. */
export function classifyEmail(email: string): EmailSource {
  const bare = email.toLowerCase().split('@')[0];
  const local = bare.replace(/[._-]/g, '');

  if (ROLE_LOCALPARTS.has(bare) || ROLE_LOCALPARTS.has(local)) return 'role';

  // Compound and prefixed forms: `bowerypartnerships`, `booking.fmam`.
  // A pattern ending in '@' is matched against the whole local-part, so
  // 'manager@' catches `manager@venue.com` without demoting `tourmanager` or
  // a person surnamed Managerio.
  if (
    ROLE_SUBSTRINGS.some((w) => (w.endsWith('@') ? bare === w.slice(0, -1) : local.includes(w)))
  ) {
    return 'role';
  }

  return 'published';
}

/**
 * Pull "Name — Title" pairs out of a team page.
 *
 * Works on the *markup*, not on stripped text. This is the whole trick: a team
 * page renders as
 *
 *     <h3>Sarah Chen</h3><p>Talent Buyer</p>
 *
 * and flattening that to text gives "Sarah Chen Talent Buyer", where the
 * boundary between the name and the title — the only thing that says which
 * words are which — has been thrown away. So the tags are turned into explicit
 * separators first, and the pair is read across one of them.
 *
 * Deliberately conservative. A missed contact costs one manual lookup; a
 * fabricated one ("Privacy Policy, Director") is a fake person in the outreach
 * list, and that is the error that actually damages a campaign.
 */
export function extractPeople(html: string): { fullName: string; title: string }[] {
  const out: { fullName: string; title: string }[] = [];
  const seen = new Set<string>();

  // Collapse every tag to a newline, so an element boundary becomes a
  // separator the pattern below can anchor on. Entities are decoded first so a
  // name written `O&#39;Brien` survives as one token.
  const text = stripChrome(html)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');

  // A capitalised human name, then a separator (an element boundary, a dash, a
  // comma), then up to ~50 characters of title text.
  //
  // The name is capped at two words plus an optional middle initial. Allowing a
  // third word let link text bleed in — an "Email" link immediately before a
  // heading produced the contact "Email Marcus Webb".
  // The surname allows an internal capital after an apostrophe or hyphen, so
  // O'Brien and Smith-Jones parse as one name rather than being skipped.
  const re =
    /^[ \t]*([A-Z][a-z]{1,15}(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-z'’-]{1,20})[ \t]*[\n–—\-|,:]+[ \t]*([A-Za-z][A-Za-z &/'-]{2,50})/gm;

  for (const m of text.matchAll(re)) {
    const fullName = m[1].replace(/\s+/g, ' ').trim();
    const title = m[2].replace(/\s+/g, ' ').trim();

    // The title must match a persona. This is the single filter doing most of
    // the work: it rejects "Privacy Policy" and "Buy Tickets" while keeping
    // anything the ICP actually routes on.
    if (!matchPersona(title)) continue;

    // Reject names built from page furniture.
    if (/\b(Privacy|Cookie|Terms|Buy|Get|Sign|Read|View|Learn|All Rights|Box Office)\b/i.test(fullName)) {
      continue;
    }

    const key = fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ fullName, title });
  }

  return out;
}

/**
 * Attach emails to the people named on the same page.
 *
 * Proximity is the only signal available in flat text, and it is a weak one, so
 * the rule is narrow: an address is bound to a person only when that person's
 * first or last name appears inside the address's local-part. Everything else
 * is recorded unattached rather than guessed onto whoever was nearest, because
 * binding the wrong address to a real name is worse than leaving it loose.
 */
function bindEmails(
  people: { fullName: string; title: string }[],
  emails: string[]
): Map<string, string> {
  const bound = new Map<string, string>();

  for (const person of people) {
    const parts = person.fullName.toLowerCase().split(/\s+/).filter((p) => p.length > 2);

    for (const email of emails) {
      const local = email.toLowerCase().split('@')[0];
      if (classifyEmail(email) === 'role') continue;
      if (parts.some((p) => local.includes(p.replace(/[^a-z]/g, '')))) {
        bound.set(person.fullName, email);
        break;
      }
    }
  }

  return bound;
}

/**
 * Does this HTML contain anything worth extracting?
 *
 * Used to decide whether a page is worth re-reading with a browser. A usable
 * email or a persona-matching name means the cheap read already worked; the
 * absence of both on a 200 response is the signature of a client-rendered
 * page, which is exactly what rendering fixes.
 */
function hasContactSignal(html: string | null): boolean {
  if (!html) return false;
  const emails = (stripChrome(html).match(EMAIL_RE) ?? []).filter(isUsableEmail);
  if (emails.length > 0) return true;
  return extractPeople(html).length > 0;
}

export interface FindContactsOptions {
  /**
   * Re-read a page with a headless browser when the served HTML yielded
   * nothing. Off by default: see the cost note in src/lib/render.ts.
   */
  render?: boolean;
}

/**
 * Crawl one org's site for contacts.
 *
 * Tries each contact path in turn and stops early once a named person with an
 * email has been found — the marginal value of a fourth page is low and the
 * politeness budget is the scarce resource on a national run.
 *
 * With `render`, a page whose served HTML produced no contact is fetched again
 * through a browser. The order matters: static first, always, and the browser
 * only for pages the cheap read could not answer. On a sample of seven venues
 * that turned 2 addresses into 18, and — the reason it is worth the cost —
 * turned zero named people into three.
 */
export async function findContacts(
  domain: string,
  opts: FindContactsOptions = {}
): Promise<FoundContact[]> {
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    logger.warn(`  unparseable domain: ${domain}`);
    return [];
  }

  const found: FoundContact[] = [];
  const seenEmails = new Set<string>();
  let namedWithEmail = 0;
  let fruitlessRenders = 0;

  /**
   * Give up on rendering a site after this many renders that found nothing.
   *
   * Most sites have two or three of the nine candidate paths; the rest 404.
   * Rendering all nine on a site whose first few came back empty is the single
   * biggest cost in a national run — at ~3s a render it was turning a 10s org
   * into a 45s one. A site that has yielded nothing after this many browser
   * attempts almost never yields on the next.
   */
  const RENDER_GIVE_UP = 3;

  for (const path of CONTACT_PATHS) {
    if (namedWithEmail > 0 && found.length >= 3) break;

    const url = `${origin}${path}`;
    let html = await fetchPage(url);

    // Re-read through a browser when the served HTML has nothing to offer.
    // `hasContactSignal` is checked rather than "did we fetch anything",
    // because these sites return a full 200 shell — the page is there, the
    // contact details are just not in it yet.
    //
    // A path that returned no HTML at all is skipped: that is a 404 or a
    // refusal, and a browser will be told the same thing more slowly.
    if (opts.render && html && !hasContactSignal(html) && fruitlessRenders < RENDER_GIVE_UP) {
      const rendered = await renderPage(url);
      if (rendered && hasContactSignal(rendered)) {
        logger.info(`    ${path}: rendered (static HTML had no contact details)`);
        html = rendered;
        fruitlessRenders = 0;
      } else {
        fruitlessRenders++;
      }
    }

    if (!html) continue;

    const clean = stripChrome(html);

    const emails = [...new Set((clean.match(EMAIL_RE) ?? []).filter(isUsableEmail))];
    const people = extractPeople(html);
    const bound = bindEmails(people, emails);

    for (const person of people) {
      const email = bound.get(person.fullName) ?? null;
      found.push({
        fullName: person.fullName,
        title: person.title,
        email,
        emailSource: email ? classifyEmail(email) : null,
        profileUrl: null,
        sourceUrl: url,
      });
      if (email) {
        namedWithEmail++;
        seenEmails.add(email.toLowerCase());
      }
    }

    // Unattached addresses are still worth keeping — a booking@ is a way in,
    // just a worse one. Recorded with no name so the export can rank it last.
    for (const email of emails) {
      if (seenEmails.has(email.toLowerCase())) continue;
      seenEmails.add(email.toLowerCase());
      found.push({
        fullName: null,
        title: null,
        email,
        emailSource: classifyEmail(email),
        profileUrl: null,
        sourceUrl: url,
      });
    }
  }

  return found;
}

/**
 * Persist a contact, idempotently.
 *
 * ── Why the conflict target is the primary key ───────────────────────────────
 *
 * The table's UNIQUE(org_id, full_name, title) cannot carry this on its own. A
 * role address like `booking@` has no name and no title, so those columns are
 * NULL — and in SQL, NULL is not equal to NULL, so two identical role rows do
 * not conflict on that index at all. The first re-run therefore skipped the
 * unique index and collided on the primary key instead, which had no conflict
 * clause, and the whole org's enrichment aborted with a constraint error.
 *
 * `id` is a hash of (org, name, title, email), so it is stable across runs for
 * the same contact and distinct for different ones. Targeting it makes both
 * named and unnamed contacts re-runnable.
 *
 * An email is only ever *upgraded*: a later `role` find never overwrites a
 * `published` one, because re-running should not quietly downgrade the best
 * address already held for a person.
 */
export function saveContact(orgId: string, c: FoundContact, source: string): void {
  const persona = c.title ? matchPersona(c.title) : null;

  // The id keys a *person*, not a sighting of them. For a named contact that
  // is (org, name, title): including the email would mint a fresh id the day
  // their address changes, and the new row would then collide on the table's
  // UNIQUE(org_id, full_name, title) index instead. Unnamed role addresses have
  // no name to key on, so the address itself is the identity.
  const identity = c.fullName
    ? `${orgId}|${c.fullName.toLowerCase()}|${(c.title ?? '').toLowerCase()}`
    : `${orgId}|role|${(c.email ?? '').toLowerCase()}`;

  const id = crypto.createHash('sha1').update(identity).digest('hex').slice(0, 16);

  db()
    .prepare(
      `INSERT INTO people
         (id, org_id, full_name, title, persona_key, persona_tier,
          email, email_source, profile_url, source, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = CASE
           WHEN people.email IS NULL THEN excluded.email
           WHEN people.email_source = 'role' AND excluded.email_source = 'published'
             THEN excluded.email
           ELSE people.email END,
         email_source = CASE
           WHEN people.email IS NULL THEN excluded.email_source
           WHEN people.email_source = 'role' AND excluded.email_source = 'published'
             THEN excluded.email_source
           ELSE people.email_source END,
         profile_url = COALESCE(people.profile_url, excluded.profile_url),
         source_url  = COALESCE(people.source_url, excluded.source_url)`
    )
    .run(
      id, orgId, c.fullName, c.title,
      persona?.key ?? null, persona?.tier ?? null,
      c.email, c.emailSource, c.profileUrl, source, c.sourceUrl
    );
}
