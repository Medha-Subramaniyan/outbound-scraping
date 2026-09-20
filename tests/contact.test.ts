import { extractPeople, isUsableEmail, classifyEmail } from '../src/services/contact';
import { hostOf } from '../src/services/store';
import { readSeeds } from '../src/services/seeds';
import { getMetro, METROS } from '../src/metros';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('email usability', () => {
  it('accepts real addresses', () => {
    expect(isUsableEmail('sarah@varietyplayhouse.com')).toBe(true);
    expect(isUsableEmail('booking@the-earl.co.uk')).toBe(true);
  });

  it('rejects image filenames that parse as addresses', () => {
    // `logo@2x.png` is valid per the naive regex and appears on most sites.
    expect(isUsableEmail('logo@2x.png')).toBe(false);
    expect(isUsableEmail('hero@3x.jpg')).toBe(false);
  });

  it('rejects site-builder and vendor boilerplate', () => {
    expect(isUsableEmail('hello@squarespace.com')).toBe(false);
    expect(isUsableEmail('noreply@wixpress.com')).toBe(false);
    expect(isUsableEmail('x@example.com')).toBe(false);
  });

  it('rejects malformed domains', () => {
    expect(isUsableEmail('someone@localhost')).toBe(false);
    expect(isUsableEmail('@nothing.com')).toBe(false);
  });
});

describe('email provenance', () => {
  it('marks functional mailboxes as role', () => {
    for (const e of ['booking@v.com', 'info@v.com', 'box-office@v.com', 'submissions@v.com']) {
      expect(classifyEmail(e)).toBe('role');
    }
  });

  it('marks personal addresses as published', () => {
    expect(classifyEmail('sarah@v.com')).toBe('published');
    expect(classifyEmail('m.webb@v.com')).toBe('published');
  });

  it('never returns inferred — nothing in this pipeline guesses an address', () => {
    const samples = ['booking@v.com', 'sarah@v.com', 'first.last@v.com'];
    for (const e of samples) expect(classifyEmail(e)).not.toBe('inferred');
  });
});

describe('people extraction', () => {
  it('reads a heading/paragraph team layout', () => {
    const html = `<h3>Sarah Chen</h3><p>Talent Buyer</p><h3>Marcus Webb</h3><p>General Manager</p>`;
    expect(extractPeople(html)).toEqual([
      { fullName: 'Sarah Chen', title: 'Talent Buyer' },
      { fullName: 'Marcus Webb', title: 'General Manager' },
    ]);
  });

  it('does not absorb adjacent link text into the name', () => {
    // An "Email" link before a heading previously yielded "Email Marcus Webb".
    const html = `<a href="mailto:s@v.com">Email</a><h3>Marcus Webb</h3><p>General Manager</p>`;
    expect(extractPeople(html)).toEqual([{ fullName: 'Marcus Webb', title: 'General Manager' }]);
  });

  it('handles br-separated, comma-inline, dash and table layouts', () => {
    expect(extractPeople(`<p>Dana Ruiz<br>Booking Manager</p>`)[0].fullName).toBe('Dana Ruiz');
    expect(extractPeople(`<li>Alex Moreno, Talent Buyer</li>`)[0].fullName).toBe('Alex Moreno');
    expect(extractPeople(`<div>Priya Nair — Director of Booking</div>`)[0].fullName).toBe('Priya Nair');
    expect(extractPeople(`<tr><td>Chris O'Brien</td><td>Booker</td></tr>`)[0].fullName).toBe("Chris O'Brien");
  });

  it('keeps names with an internal capital after an apostrophe or hyphen', () => {
    expect(extractPeople(`<h3>Chris O'Brien</h3><p>Booker</p>`)[0].fullName).toBe("Chris O'Brien");
    expect(extractPeople(`<h3>Ana Smith-Jones</h3><p>Owner</p>`)[0].fullName).toBe('Ana Smith-Jones');
  });

  it('invents nobody from page furniture', () => {
    // The damaging failure: a fabricated contact in the outreach list.
    const html = `<p>Privacy Policy</p><p>Buy Tickets</p><a>Box Office</a><p>Manager</p>
                  <h2>Upcoming Shows</h2><p>General Admission</p><p>All Rights Reserved</p>`;
    expect(extractPeople(html)).toEqual([]);
  });

  it('ignores people whose title is outside the ICP personas', () => {
    const html = `<h3>Jane Smith</h3><p>Head Chef</p><h3>Bob Lee</h3><p>Sound Engineer</p>`;
    expect(extractPeople(html)).toEqual([]);
  });

  it('deduplicates a person repeated across a page', () => {
    const html = `<h3>Sarah Chen</h3><p>Talent Buyer</p><h3>Sarah Chen</h3><p>Talent Buyer</p>`;
    expect(extractPeople(html)).toHaveLength(1);
  });
});

describe('org domain attribution', () => {
  it('takes the bare host, dropping www', () => {
    expect(hostOf('https://www.varietyplayhouse.com/events')).toBe('varietyplayhouse.com');
  });

  it('refuses aggregator hosts, which are nobody’s own site', () => {
    // Recording these would point contact discovery at a ticketing platform
    // for every venue that sells through it.
    expect(hostOf('https://www.axs.com/venues/123/events')).toBeNull();
    expect(hostOf('https://bandsintown.com/a/456')).toBeNull();
    expect(hostOf('https://www.ticketmaster.com/event/abc')).toBeNull();
  });

  it('is null for a missing or unparseable url', () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf('not a url')).toBeNull();
  });
});

describe('metro seeds', () => {
  it('has unique slugs', () => {
    const slugs = METROS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('looks up a metro case-insensitively', () => {
    expect(getMetro('Nashville')?.region).toBe('TN');
    expect(getMetro('nope')).toBeUndefined();
  });

  it('normalises pasted URLs and comments out of a seed file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeds-'));
    fs.writeFileSync(
      path.join(dir, 'testmetro.txt'),
      ['# a comment', '', 'variety-playhouse.com', 'https://www.terminalwestatl.com/events',
       'VARIETY-PLAYHOUSE.COM', '  spaced.com  '].join('\n')
    );

    const prev = process.env.SEED_DIR;
    process.env.SEED_DIR = dir;
    jest.resetModules();
    // Re-import so the module picks up the patched SEED_DIR.

    const { readSeeds: read } = require('../src/services/seeds');
    const seeds = read('testmetro');
    process.env.SEED_DIR = prev;

    expect(seeds).toEqual(['variety-playhouse.com', 'terminalwestatl.com', 'spaced.com']);
  });

  it('returns nothing for a metro with no seed file', () => {
    expect(readSeeds('definitely-not-a-metro')).toEqual([]);
  });
});

describe('departmental mailboxes found on live sites', () => {
  it('classifies department addresses as role, not published', () => {
    // From thecrocodile.com/contact — previously marked 'published', which in
    // an export reads as "a named person answers here".
    expect(classifyEmail('accessibility@thecrocodile.com')).toBe('role');
    for (const l of ['hr', 'jobs', 'rentals', 'production', 'noreply', 'billing']) {
      expect(classifyEmail(`${l}@venue.com`)).toBe('role');
    }
  });
});

describe('contact persistence is re-runnable', () => {
  // The people table has UNIQUE(org_id, full_name, title). A role address has
  // NULL in both name columns, and NULL never equals NULL, so two identical
  // role rows do not conflict on that index — the insert fell through to the
  // primary key, which had no conflict clause, and aborted the whole org.
  const tmp = path.join(os.tmpdir(), `people-${Date.now()}.db`);

  afterAll(() => {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  });

  it('writes an unnamed role address twice without a constraint error', () => {
    process.env.DATABASE_PATH = tmp;
    jest.resetModules();

    const { db, close } = require('../src/lib/db');
    db().exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
    db().prepare(`INSERT INTO orgs (id, name, slug) VALUES ('o1', 'Venue', 'venue')`).run();

    const { saveContact } = require('../src/services/contact');
    const role = {
      fullName: null, title: null, email: 'booking@venue.com',
      emailSource: 'role' as const, profileUrl: null, sourceUrl: 'https://venue.com/contact',
    };

    expect(() => {
      saveContact('o1', role, 'site-crawl');
      saveContact('o1', role, 'site-crawl');
    }).not.toThrow();

    expect((db().prepare(`SELECT COUNT(*) AS n FROM people`).get() as { n: number }).n).toBe(1);
    close();
  });

  it('upgrades a role address to a published one, never the reverse', () => {
    process.env.DATABASE_PATH = tmp.replace('.db', '-b.db');
    jest.resetModules();

    const { db, close } = require('../src/lib/db');
    db().exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
    db().prepare(`INSERT INTO orgs (id, name, slug) VALUES ('o1', 'Venue', 'venue')`).run();

    const { saveContact } = require('../src/services/contact');
    const base = { fullName: 'Sarah Chen', title: 'Talent Buyer', profileUrl: null, sourceUrl: 'u' };

    saveContact('o1', { ...base, email: 'booking@venue.com', emailSource: 'role' }, 'site-crawl');
    saveContact('o1', { ...base, email: 'sarah@venue.com', emailSource: 'published' }, 'site-crawl');
    // A later role sighting must not clobber the better address.
    saveContact('o1', { ...base, email: 'info@venue.com', emailSource: 'role' }, 'site-crawl');

    const row = db().prepare(`SELECT email, email_source, persona_tier FROM people`).get() as
      { email: string; email_source: string; persona_tier: string };

    expect(row.email).toBe('sarah@venue.com');
    expect(row.email_source).toBe('published');
    expect(row.persona_tier).toBe('primary');

    close();
    try { fs.unlinkSync(tmp.replace('.db', '-b.db')); } catch { /* ignore */ }
  });
});

describe('domain attribution guards against cross-venue leakage', () => {
  const { domainMatchesName } = require('../src/services/store');

  it('matches a venue to its own domain', () => {
    expect(domainMatchesName('nectarlounge.com', 'Nectar Lounge')).toBe(true);
    expect(domainMatchesName('thecrocodile.com', 'The Crocodile')).toBe(true);
    expect(domainMatchesName('thecrocodile.com', 'Crocodile')).toBe(true);
  });

  it('refuses another venue listed on the same calendar', () => {
    // Nectar's calendar carries Hidden Hall and Neumos dates. Without this,
    // all three orgs were given nectarlounge.com and contact discovery would
    // file Nectar's staff as working at Neumos.
    expect(domainMatchesName('nectarlounge.com', 'Neumos')).toBe(false);
    expect(domainMatchesName('nectarlounge.com', 'Hidden Hall')).toBe(false);
  });
});

describe('render fallback gating', () => {
  // The renderer is only worth its cost on pages the cheap read could not
  // answer, so the decision hinges on this predicate. It is exercised through
  // the exported helpers it is built from, since it is module-private.
  const { isUsableEmail: usable, extractPeople: people } = require('../src/services/contact');

  it('treats a page with a usable email as already answered', () => {
    const html = `<p>Reach us at booking@venue.com</p>`;
    const found = (html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).filter(usable);
    expect(found.length).toBeGreaterThan(0);
  });

  it('treats a page with a named person as already answered', () => {
    expect(people(`<h3>Sarah Chen</h3><p>Talent Buyer</p>`).length).toBeGreaterThan(0);
  });

  it('treats an empty SPA shell as needing a render', () => {
    // The real signature: a full 200 response whose body carries no contact
    // detail at all, because the content mounts client-side.
    const shell = `<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    const emails = (shell.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).filter(usable);
    expect(emails).toHaveLength(0);
    expect(people(shell)).toHaveLength(0);
  });
});

describe('published-only filtering', () => {
  const { classifyEmail: cls } = require('../src/services/contact');

  // `--published-only` drops role mailboxes from a run's output. The filter is
  // a one-liner in enrich.ts; what matters is that classifyEmail draws the
  // line in the right place, because that is what the filter keys on.
  it('keeps personal addresses and drops functional ones', () => {
    const found = [
      'bruce@emptybottle.com', 'matt@emptybottle.com', 'jtaylor@thecedar.org',
      'booking@thecedar.org', 'info@emptybottle.com', 'boxoffice@thechapelsf.com',
    ];
    const published = found.filter((e) => cls(e) === 'published');

    expect(published).toEqual([
      'bruce@emptybottle.com', 'matt@emptybottle.com', 'jtaylor@thecedar.org',
    ]);
  });

  it('does not mistake an initial-plus-surname local part for a role', () => {
    // jtaylor@ is a person; the role list must not swallow short local parts.
    expect(cls('jtaylor@thecedar.org')).toBe('published');
    expect(cls('mwebb@venue.com')).toBe('published');
  });
});

describe('classifier fixes found in a live national crawl', () => {
  const { classifyEmail: cls, isUsableEmail: usable } = require('../src/services/contact');

  it('rejects domain-broker addresses from parked venue sites', () => {
    // A venue whose domain lapsed gets parked, and the parking page's sales
    // address was scraped as a live contact at a venue that no longer exists.
    expect(usable('interested@domainmarket.com')).toBe(false);
    expect(usable('sales@hugedomains.com')).toBe(false);
  });

  it('catches functional mailboxes that are compounds, not exact matches', () => {
    expect(cls('bowerypartnerships@bowerypresents.com')).toBe('role');
    expect(cls('booking.fmam@gmail.com')).toBe('role');
    expect(cls('artistsubmissions@venue.com')).toBe('role');
  });

  it('still treats real personal addresses as published', () => {
    for (const e of ['bruce@emptybottle.com', 'jtaylor@thecedar.org', 'tracey@thechapelsf.com']) {
      expect(cls(e)).toBe('published');
    }
  });

  it('does not let a role substring swallow an ordinary name', () => {
    // The substring list excludes words that occur inside real names, so a
    // surname is not demoted to a role mailbox. 'Brooking' and 'Amedia' are
    // both real surnames and both stay published.
    expect(cls('amedia@venue.com')).toBe('published');
    expect(cls('brooking@venue.com')).toBe('published');
  });
});

describe('out-of-scope and bare-function mailboxes', () => {
  const { classifyEmail: cls } = require('../src/services/contact');

  it('treats a bare manager@ as a mailbox, not a person', () => {
    expect(cls('manager@hideoutchicago.com')).toBe('role');
    // ...but a compound containing it is a plausible person or a real role
    // title, so it is left alone.
    expect(cls('tourmanager@band.com')).toBe('published');
  });

  it('demotes the wedding/private-event market, which the ICP excludes', () => {
    // src/icp.ts EXCLUDED_CATEGORIES keeps weddings out of this list entirely;
    // a weddinginquiries@ address is the wrong business, not just a firehose.
    expect(cls('weddinginquiries@mrsmalls.com')).toBe('role');
    expect(cls('privateevents@venue.com')).toBe('role');
    expect(cls('banquets@venue.com')).toBe('role');
  });
});

describe('seed files with inline provenance comments', () => {
  it('strips a trailing comment from a seed line', () => {
    // `npm run directory` writes provenance inline, so the parser has to cut
    // at the '#'. Without this the whole comment became part of the hostname
    // and the crawler tried to resolve "eddiesattic.com  # eddie's attic...".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeds-ivw-'));
    fs.writeFileSync(
      path.join(dir, 'testmetro.txt'),
      [
        '# from Independent Venue Week, read 2026-09-19',
        "eddiesattic.com  # Eddie's Attic — IVW member (https://independentvenueweek.com/us/venues-us/eddies-attic-2/)",
        'plainvenue.com',
      ].join('\n')
    );

    const prev = process.env.SEED_DIR;
    process.env.SEED_DIR = dir;
    jest.resetModules();

    const { readSeeds: read } = require('../src/services/seeds');
    const seeds = read('testmetro');
    process.env.SEED_DIR = prev;

    expect(seeds).toEqual(['eddiesattic.com', 'plainvenue.com']);
  });
});

describe('IVW directory parsing', () => {
  // The address and capacity live in Elementor icon-list items keyed by a
  // font-awesome class. Fixture mirrors the real markup shape.
  const page = (addr: string, cap: string, site: string) => `
    <html><head><title>Eddie&#039;s Attic - Independent Venue Week US</title></head>
    <body>
      <i class="fas fa-map-marker-alt"></i>
      <span class="elementor-icon-list-text">${addr}</span>
      <i class="fas fa-users"></i>
      <span class="elementor-icon-list-text">${cap}</span>
      <a href="https://www.facebook.com/x">fb</a>
      <a href="${site}">website</a>
    </body></html>`;

  it('parses name, city, capacity and the venue’s own domain', async () => {
    const html = page('515 N McDonough St, Decatur, Georgia 30030', '175', 'https://www.eddiesattic.com');
    jest.resetModules();
    jest.doMock('../src/lib/fetch', () => ({
      fetchPage: async () => html,
      stripChrome: (h: string) => h,
    }));

    const { readVenuePage: read } = require('../src/sources/ivw-directory');
    const v = await read('https://independentvenueweek.com/us/venues-us/eddies-attic-2/', 'georgia');

    // Entities decoded — the raw title carries `Eddie&#039;s Attic`.
    expect(v.name).toBe("Eddie's Attic");
    expect(v.city).toBe('Decatur');
    expect(v.capacity).toBe(175);
    // www. stripped, and the social link is not mistaken for the venue site.
    expect(v.domain).toBe('eddiesattic.com');

    jest.dontMock('../src/lib/fetch');
  });

  it('returns nulls rather than guessing when the address is not the expected shape', async () => {
    jest.resetModules();
    jest.doMock('../src/lib/fetch', () => ({
      fetchPage: async () => `<html><head><title>X - Independent Venue Week US</title></head><body></body></html>`,
      stripChrome: (h: string) => h,
    }));

    const { readVenuePage: read } = require('../src/sources/ivw-directory');
    const v = await read('https://independentvenueweek.com/us/venues-us/x/', 'georgia');

    expect(v.city).toBeNull();
    expect(v.capacity).toBeNull();
    expect(v.domain).toBeNull();

    jest.dontMock('../src/lib/fetch');
  });
});

describe('shared mailboxes that read like a person or a title', () => {
  const { classifyEmail: cls } = require('../src/services/contact');

  it('treats a job-title or department mailbox as role, not a named human', () => {
    // Found by probing the classifier: all of these came back 'published',
    // which puts a shared inbox into the --published-only working list.
    for (const e of [
      'gm@venue.com', 'owner@venue.com', 'promo@venue.com', 'hospitality@venue.com',
      'bar@venue.com', 'operations@venue.com', 'staff@venue.com', 'team@venue.com',
      'sponsorship@venue.com', 'guestlist@venue.com', 'pr@venue.com',
    ]) {
      expect(`${e}=${cls(e)}`).toBe(`${e}=role`);
    }
  });

  it('keeps short given names that happen to look like a function word', () => {
    // Exact-match only, and none of these are on the list: Art, Dev, Will and
    // Pat are people.
    for (const e of ['art@venue.com', 'dev@venue.com', 'will@venue.com', 'pat@venue.com']) {
      expect(`${e}=${cls(e)}`).toBe(`${e}=published`);
    }
  });
});

describe('names published as the text of an email link', () => {
  // The commonest staff-list shape on small venue sites has no title at all:
  // the person's name IS the mailto link. extractPeople needs a title, so all
  // of these were stored as a bare address with no name.
  const { extractMailtoPeople } = require('../src/services/contact');

  it('reads the name off the link when it matches the address', () => {
    const html = `<ul>
      <li><a href="mailto:cameron@emptybottle.com">Cameron Diaz</a></li>
      <li><a class="x" href="mailto:jtaylor@thecedar.org?subject=Hi">Jamie Taylor</a></li>
      <li><a href='mailto:Sarah.Chen@venue.com'><span>Sarah Chen</span></a></li>
    </ul>`;
    expect(extractMailtoPeople(html)).toEqual([
      { fullName: 'Cameron Diaz', email: 'cameron@emptybottle.com' },
      { fullName: 'Jamie Taylor', email: 'jtaylor@thecedar.org' },
      { fullName: 'Sarah Chen', email: 'sarah.chen@venue.com' },
    ]);
  });

  it('accepts initials as the address when the link names the person', () => {
    const html = `<a href="mailto:sc@venue.com">Sarah Chen</a>`;
    expect(extractMailtoPeople(html)).toEqual([{ fullName: 'Sarah Chen', email: 'sc@venue.com' }]);
  });

  it('invents nobody from call-to-action link text', () => {
    // "Contact Us" is name-shaped. Nothing in it matches the address, so it is
    // never bound — the same rule that stops a fabricated contact elsewhere.
    const html = `<a href="mailto:cameron@v.com">Contact Us</a>
                  <a href="mailto:cameron@v.com">Email Cameron</a>
                  <a href="mailto:dana@v.com">Get In Touch</a>
                  <a href="mailto:dana@v.com">dana@v.com</a>`;
    expect(extractMailtoPeople(html)).toEqual([]);
  });

  it('never names a role mailbox, whatever the link says', () => {
    const html = `<a href="mailto:booking@venue.com">Booking Smith</a>
                  <a href="mailto:info@venue.com">Sarah Chen</a>`;
    expect(extractMailtoPeople(html)).toEqual([]);
  });

  it('does not bind a name to an unrelated address', () => {
    // A link whose text is one person and whose address is another is a site
    // error; binding it would attach a real name to the wrong inbox.
    expect(extractMailtoPeople(`<a href="mailto:marcus@venue.com">Sarah Chen</a>`)).toEqual([]);
  });
});

describe('naming a bare personal address from the same page', () => {
  // 398 of 419 scraped contacts were an address with no name. Most sit on a
  // page that also prints the person's name — just not next to a title the
  // ICP personas recognise, so extractPeople never offered them for binding.
  const { nameForEmail } = require('../src/services/contact');

  it('names an address from a staff card whose title is outside the personas', () => {
    const html = `<div class="card"><h3>Dana Lopez</h3><p>Production Manager</p>
                  <a href="mailto:dana@venue.com">Email</a></div>`;
    expect(nameForEmail(html, 'dana@venue.com')).toBe('Dana Lopez');
  });

  it('recognises initial-plus-surname and first.last addresses', () => {
    const html = `<h4>Jamie Taylor</h4><h4>Sarah Chen</h4>`;
    expect(nameForEmail(html, 'jtaylor@thecedar.org')).toBe('Jamie Taylor');
    expect(nameForEmail(html, 'sarah.chen@thecedar.org')).toBe('Sarah Chen');
  });

  it('reads a name that shares its line with a title', () => {
    expect(nameForEmail(`<li>Alex Moreno, Lighting Designer</li>`, 'alex@venue.com')).toBe('Alex Moreno');
  });

  it('leaves the address unnamed when two people could own it', () => {
    const html = `<h3>Dana Lopez</h3><h3>Dana Whitfield</h3>`;
    expect(nameForEmail(html, 'dana@venue.com')).toBeNull();
  });

  it('does not match on a substring of a name', () => {
    // A substring test would hand art@ to Martin.
    expect(nameForEmail(`<h3>Martin Shaw</h3>`, 'art@venue.com')).toBeNull();
  });

  it('does not accept bare initials without a link tying them together', () => {
    expect(nameForEmail(`<h3>Sarah Chen</h3>`, 'sc@venue.com')).toBeNull();
  });

  it('invents nobody from furniture or for a role mailbox', () => {
    expect(nameForEmail(`<p>Contact Dana</p><p>Meet Dana</p>`, 'dana@venue.com')).toBeNull();
    expect(nameForEmail(`<h3>Booking Smith</h3>`, 'booking@venue.com')).toBeNull();
  });
});

describe('assembling one page into contacts', () => {
  const { contactsFromPage } = require('../src/services/contact');
  const URL_ = 'https://venue.com/team';

  it('names an address whose name is the link text, and lists it once', () => {
    const html = `<li><a href="mailto:cameron@venue.com">Cameron Diaz</a></li>`;
    expect(contactsFromPage(html, URL_)).toEqual([
      { fullName: 'Cameron Diaz', title: null, email: 'cameron@venue.com',
        emailSource: 'published', profileUrl: null, sourceUrl: URL_ },
    ]);
  });

  it('names an address from a staff card with a non-persona title', () => {
    const html = `<h3>Dana Lopez</h3><p>Production Manager</p><a href="mailto:dana@venue.com">Email</a>`;
    const found = contactsFromPage(html, URL_);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ fullName: 'Dana Lopez', title: null, email: 'dana@venue.com' });
  });

  it('keeps the titled person from extractPeople rather than a second untitled copy', () => {
    const html = `<h3>Sarah Chen</h3><p>Talent Buyer</p><a href="mailto:sarah@venue.com">Sarah Chen</a>`;
    expect(contactsFromPage(html, URL_)).toEqual([
      { fullName: 'Sarah Chen', title: 'Talent Buyer', email: 'sarah@venue.com',
        emailSource: 'published', profileUrl: null, sourceUrl: URL_ },
    ]);
  });

  it('still records a role mailbox, unnamed', () => {
    const found = contactsFromPage(`<p>Write to booking@venue.com</p>`, URL_);
    expect(found).toEqual([
      { fullName: null, title: null, email: 'booking@venue.com',
        emailSource: 'role', profileUrl: null, sourceUrl: URL_ },
    ]);
  });
});

describe('a name found later replaces the unnamed row for the same address', () => {
  // Databases scraped before names could be bound hold `cameron@` with no
  // name. Re-crawling must not leave that row beside the new named one, or the
  // working list carries the same inbox twice.
  const tmp = path.join(os.tmpdir(), `people-named-${Date.now()}.db`);
  afterAll(() => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } });

  it('ends with one row, named, keeping any outreach history', () => {
    process.env.DATABASE_PATH = tmp;
    jest.resetModules();

    const { db, close } = require('../src/lib/db');
    db().exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
    db().prepare(`INSERT INTO orgs (id, name, slug) VALUES ('o1', 'Venue', 'venue')`).run();

    const { saveContact } = require('../src/services/contact');
    const bare = { fullName: null, title: null, email: 'cameron@venue.com',
      emailSource: 'published' as const, profileUrl: null, sourceUrl: 'u' };

    saveContact('o1', bare, 'site-crawl');
    const oldId = (db().prepare(`SELECT id FROM people`).get() as { id: string }).id;
    db().prepare(`INSERT INTO outreach (id, person_id, status) VALUES ('x1', ?, 'sent')`).run(oldId);

    saveContact('o1', { ...bare, fullName: 'Cameron Diaz' }, 'site-crawl');

    const rows = db().prepare(`SELECT id, full_name FROM people`).all() as { id: string; full_name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].full_name).toBe('Cameron Diaz');

    const outreach = db().prepare(`SELECT person_id, status FROM outreach`).all() as
      { person_id: string; status: string }[];
    expect(outreach).toEqual([{ person_id: rows[0].id, status: 'sent' }]);
    close();
  });
  it('keeps the bare row when the named person holds a different address', () => {
    // The upsert never swaps a published address for another, so the named row
    // keeps cdiaz@. Deleting the bare cameron@ row then would lose the only
    // record of an address the venue published.
    process.env.DATABASE_PATH = tmp.replace('.db', '-b.db');
    jest.resetModules();

    const { db, close } = require('../src/lib/db');
    db().exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
    db().prepare(`INSERT INTO orgs (id, name, slug) VALUES ('o1', 'Venue', 'venue')`).run();

    const { saveContact } = require('../src/services/contact');
    const base = { title: null, emailSource: 'published' as const, profileUrl: null, sourceUrl: 'u' };

    saveContact('o1', { ...base, fullName: 'Cameron Diaz', email: 'cdiaz@venue.com' }, 'site-crawl');
    saveContact('o1', { ...base, fullName: null, email: 'cameron@venue.com' }, 'site-crawl');
    saveContact('o1', { ...base, fullName: 'Cameron Diaz', email: 'cameron@venue.com' }, 'site-crawl');

    const emails = (db().prepare(`SELECT email FROM people ORDER BY email`).all() as { email: string }[])
      .map((r) => r.email);
    expect(emails).toEqual(['cameron@venue.com', 'cdiaz@venue.com']);

    close();
    try { fs.unlinkSync(tmp.replace('.db', '-b.db')); } catch { /* ignore */ }
  });
});
