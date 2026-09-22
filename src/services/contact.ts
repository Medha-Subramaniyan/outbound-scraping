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
  // Job-title and department mailboxes. `gm@` and `owner@` read like a person
  // and were classified 'published', which put shared inboxes into the
  // --published-only working list. Exact-match only, and nothing here is also
  // a given name: 'art', 'dev', 'will' and 'pat' are deliberately absent.
  'gm', 'generalmanager', 'owner', 'owners', 'promo', 'promos', 'promotions',
  'hospitality', 'bar', 'ops', 'operations', 'staff', 'team', 'crew',
  'sponsorship', 'sponsorships', 'sponsors', 'advertising', 'ads', 'pr',
  'publicity', 'guestlist', 'vip', 'reservations', 'groupsales', 'ticketing',
  'programming', 'membership', 'members', 'development', 'donate', 'education',
  'finance', 'payroll', 'legal', 'privacy', 'customerservice', 'service',
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
 * What a human name looks like, shared by every extractor in this file.
 *
 * Two words plus an optional middle initial. The cap is deliberate — see the
 * note inside `extractPeople` about "Email Marcus Webb".
 */
const NAME_SHAPE = "[A-Z][a-z]{1,15}(?:\\s+[A-Z]\\.)?\\s+[A-Z][A-Za-z'’-]{1,20}";

/**
 * Words that make a name-shaped string page furniture, not a person.
 *
 * The second row is link text: "Email Cameron" and "Contact Us" are both
 * name-shaped, and both sit inside exactly the mailto links that
 * `extractMailtoPeople` reads.
 */
const NAME_FURNITURE =
  /\b(Privacy|Cookie|Terms|Buy|Get|Sign|Read|View|Learn|All Rights|Box Office|Email|E-mail|Mail|Contact|Message|Send|Click|Meet|Ask|Write)\b/i;

/**
 * Does this address plausibly belong to this person?
 *
 * Strict equality against the shapes people actually use — `cameron@`,
 * `sarah.chen@`, `jtaylor@`, `sarahc@` — rather than a substring test, which
 * would bind `art@` to Martin. Initials (`sc@`) are only accepted when the
 * caller has independent evidence the two belong together, because two letters
 * match far too many names to stand alone.
 */
export function nameMatchesLocal(
  fullName: string,
  email: string,
  opts: { allowInitials?: boolean } = {}
): boolean {
  const words = fullName
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter((w) => w.length > 1); // drops a middle initial
  if (words.length < 2) return false;

  const first = words[0];
  const last = words[words.length - 1];
  const local = email
    .toLowerCase()
    .split('@')[0]
    .replace(/[^a-z]/g, '');

  const shapes = [first, last, first + last, last + first, first[0] + last, first + last[0]];
  if (opts.allowInitials) shapes.push(first[0] + last[0]);
  return shapes.includes(local);
}

/**
 * Names published as the text of their own email link.
 *
 *     <a href="mailto:cameron@emptybottle.com">Cameron Diaz</a>
 *
 * This is the commonest staff-list shape on a small venue site, and it carries
 * no title, so `extractPeople` — which needs a persona-matching title to trust
 * a name — never sees it. Here the site itself has tied the name to the
 * address, which is stronger evidence than any title.
 *
 * Still conservative, for the same reason as everything else in this file: the
 * link text must be name-shaped, must not be furniture ("Contact Us"), must
 * match the address, and the address must not be a role mailbox. A link reading
 * "Sarah Chen" over `info@` names the inbox's current reader, not its owner.
 */
export function extractMailtoPeople(html: string): { fullName: string; email: string }[] {
  const out: { fullName: string; email: string }[] = [];
  const seen = new Set<string>();
  const nameOnly = new RegExp(`^${NAME_SHAPE}$`);

  const re = /<a\b[^>]*\bhref\s*=\s*["']mailto:([^"'?\s]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const m of stripChrome(html).matchAll(re)) {
    const email = m[1].trim().toLowerCase();
    if (!isUsableEmail(email) || classifyEmail(email) === 'role') continue;

    const fullName = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (!nameOnly.test(fullName) || NAME_FURNITURE.test(fullName)) continue;
    if (!nameMatchesLocal(fullName, email, { allowInitials: true })) continue;
    if (seen.has(email)) continue;
    seen.add(email);

    out.push({ fullName, email });
  }

  return out;
}

/**
 * Flatten markup to text with every element boundary kept as a newline.
 *
 * The boundary is the only thing that says where a name ends, so it is turned
 * into an explicit separator before any pattern runs. Entities are decoded
 * first so `O&#39;Brien` survives as one token.
 */
function elementLines(html: string): string {
  return stripChrome(html)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

/**
 * Find the name of whoever a bare personal address belongs to, on one page.
 *
 * `extractPeople` only trusts a name that sits beside a persona-matching
 * title, which is right for deciding who to *route* to — but it means a
 * production manager or a co-owner listed without a title is never offered for
 * binding, and their published address is stored with no name on it. That was
 * 398 of the first 419 contacts.
 *
 * Here the address is the evidence instead of the title: `dana@` plus a
 * "Dana Lopez" on the same page. No title is needed and none is returned.
 *
 * Returns null — not a best guess — when nobody matches, when two people do, or
 * when the address is a role mailbox. An unnamed address costs one manual
 * lookup; a wrong name on a real inbox is an email that opens by calling
 * someone by a colleague's name.
 */
export function nameForEmail(html: string, email: string): string | null {
  if (!isUsableEmail(email) || classifyEmail(email) === 'role') return null;

  const re = new RegExp(`^[ \\t]*(${NAME_SHAPE})[ \\t]*(?=$|[–—\\-|,:])`, 'gm');
  const matches = new Set<string>();

  for (const m of elementLines(html).matchAll(re)) {
    const fullName = m[1].replace(/\s+/g, ' ').trim();
    if (NAME_FURNITURE.test(fullName)) continue;
    if (nameMatchesLocal(fullName, email)) matches.add(fullName);
  }

  return matches.size === 1 ? [...matches][0] : null;
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
  const text = elementLines(html);

  // A capitalised human name, then a separator (an element boundary, a dash, a
  // comma), then up to ~50 characters of title text.
  //
  // The name is capped at two words plus an optional middle initial. Allowing a
  // third word let link text bleed in — an "Email" link immediately before a
  // heading produced the contact "Email Marcus Webb".
  // The surname allows an internal capital after an apostrophe or hyphen, so
  // O'Brien and Smith-Jones parse as one name rather than being skipped.
  const re = new RegExp(
    `^[ \\t]*(${NAME_SHAPE})[ \\t]*[\\n–—\\-|,:]+[ \\t]*([A-Za-z][A-Za-z &/'-]{2,50})`,
    'gm'
  );

  for (const m of text.matchAll(re)) {
    const fullName = m[1].replace(/\s+/g, ' ').trim();
    const title = m[2].replace(/\s+/g, ' ').trim();

    // The title must match a persona. This is the single filter doing most of
    // the work: it rejects "Privacy Policy" and "Buy Tickets" while keeping
    // anything the ICP actually routes on.
    if (!matchPersona(title)) continue;

    // Reject names built from page furniture.
    if (NAME_FURNITURE.test(fullName)) continue;

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
 * Everything one page says about who to write to.
 *
 * Pure — no network, no database — so the rules for combining the three
 * extractors are testable on a string. In order of how much each is trusted:
 *
 *   1. `extractPeople`       a name beside a persona title. Carries the title.
 *   2. `extractMailtoPeople` a name that is the text of its own email link.
 *   3. `nameForEmail`        a bare address whose owner is named on the page.
 *
 * A later step never overrides an earlier one: it fills an email a titled
 * person was missing, or names an address nobody had claimed. An address that
 * no step can name is still recorded, unnamed, so the export can rank it last.
 */
export function contactsFromPage(html: string, sourceUrl: string): FoundContact[] {
  const found: FoundContact[] = [];
  const claimed = new Set<string>();

  const emails: string[] = [];
  for (const e of (stripChrome(html).match(EMAIL_RE) ?? []).filter(isUsableEmail)) {
    if (!emails.some((x) => x.toLowerCase() === e.toLowerCase())) emails.push(e);
  }

  const people = extractPeople(html);
  const bound = bindEmails(people, emails);

  for (const person of people) {
    const email = bound.get(person.fullName) ?? null;
    if (email) claimed.add(email.toLowerCase());
    found.push({
      fullName: person.fullName,
      title: person.title,
      email,
      emailSource: email ? classifyEmail(email) : null,
      profileUrl: null,
      sourceUrl,
    });
  }

  /** Attach a named address: to the titled person if listed, else as a new row. */
  const attach = (fullName: string, email: string): boolean => {
    const existing = found.find((f) => f.fullName?.toLowerCase() === fullName.toLowerCase());
    if (existing?.email) return false; // they already have an address; do not swap it
    claimed.add(email.toLowerCase());
    if (existing) {
      existing.email = email;
      existing.emailSource = classifyEmail(email);
    } else {
      found.push({
        fullName,
        title: null,
        email,
        emailSource: classifyEmail(email),
        profileUrl: null,
        sourceUrl,
      });
    }
    return true;
  };

  for (const { fullName, email } of extractMailtoPeople(html)) {
    if (!claimed.has(email)) attach(fullName, email);
  }

  for (const email of emails) {
    if (claimed.has(email.toLowerCase())) continue;
    const owner = nameForEmail(html, email);
    if (owner && attach(owner, email)) continue;

    claimed.add(email.toLowerCase());
    found.push({
      fullName: null,
      title: null,
      email,
      emailSource: classifyEmail(email),
      profileUrl: null,
      sourceUrl,
    });
  }

  return found;
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

    for (const c of contactsFromPage(html, url)) {
      const key = c.email?.toLowerCase();

      if (!c.fullName) {
        // Unattached addresses are still worth keeping — a booking@ is a way
        // in, just a worse one — but only once per site.
        if (!key || seenEmails.has(key)) continue;
        seenEmails.add(key);
        found.push(c);
        continue;
      }

      if (key) {
        // /contact often shows the bare address before /team names its owner.
        // Drop the earlier unnamed sighting so the inbox is listed once.
        const earlier = found.findIndex((f) => !f.fullName && f.email?.toLowerCase() === key);
        if (earlier >= 0) found.splice(earlier, 1);
        seenEmails.add(key);
        namedWithEmail++;
      }
      found.push(c);
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

  const conn = db();

  const write = conn.transaction(() => {
    conn
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

    // A name found for an address that was previously stored bare. The bare
    // row is keyed on the address and the named row on the person, so without
    // this they sit side by side and the working list carries one inbox twice.
    // Outreach history moves to the named row first: deleting the bare row
    // would otherwise cascade it away.
    if (!c.fullName || !c.email) return;

    // Only once the named row really holds this address. The upsert above never
    // swaps one published address for another, so a person already stored under
    // cdiaz@ keeps it — and the bare cameron@ row is then the only record of an
    // address the venue published.
    const stored = conn.prepare(`SELECT email FROM people WHERE id = ?`).get(id) as
      | { email: string | null }
      | undefined;
    if (stored?.email?.toLowerCase() !== c.email.toLowerCase()) return;

    const bare = conn
      .prepare(
        `SELECT id FROM people
         WHERE org_id = ? AND full_name IS NULL AND lower(email) = lower(?) AND id != ?`
      )
      .all(orgId, c.email, id) as { id: string }[];

    for (const row of bare) {
      conn
        .prepare(`UPDATE OR IGNORE outreach SET person_id = ? WHERE person_id = ?`)
        .run(id, row.id);
      conn.prepare(`DELETE FROM people WHERE id = ?`).run(row.id);
    }
  });

  write();
}
