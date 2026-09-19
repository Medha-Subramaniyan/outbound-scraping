import { matchPersona, isExcludedOrg, isExcludedCategory, isPriorityMetro } from '../src/icp';
import { slugify, cleanPresenter, splitPresenters } from '../src/services/resolve';
import { parseEventDate } from '../src/lib/fetch';
import { scoreOrg, MIN_OBSERVATION_DAYS } from '../src/services/score';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('persona matching', () => {
  it('routes the primary buyer titles', () => {
    expect(matchPersona('Talent Buyer')?.key).toBe('promoter-buyer');
    expect(matchPersona('Talent Buyer & Booking Manager')?.key).toBe('promoter-buyer');
    expect(matchPersona('Artist Manager')?.key).toBe('promoter-buyer');
  });

  it('routes owners and principals', () => {
    expect(matchPersona('Owner')?.key).toBe('owner-principal');
    expect(matchPersona('Founder / Principal')?.key).toBe('owner-principal');
  });

  it('prefers the longest match, so specific titles beat generic ones', () => {
    // 'booking manager' must win over the bare 'booker'/'manager' substrings,
    // and 'director of event strategy' over 'gm'.
    expect(matchPersona('Booking Manager')?.key).toBe('promoter-buyer');
    expect(matchPersona('Director of Event Strategy')?.key).toBe('venue-ops');
    expect(matchPersona('Venue Manager')?.key).toBe('venue-ops');
  });

  it('tiers secondary and tertiary personas', () => {
    expect(matchPersona('Event Operations Manager')?.tier).toBe('secondary');
    expect(matchPersona('Partnership Activation')?.tier).toBe('tertiary');
  });

  it('returns null on an unrelated title', () => {
    expect(matchPersona('Software Engineer')).toBeNull();
  });
});

describe('exclusions', () => {
  it('excludes enterprise promoters and major agencies', () => {
    expect(isExcludedOrg('Live Nation Entertainment')).toBe(true);
    expect(isExcludedOrg('AEG Presents')).toBe(true);
    expect(isExcludedOrg('Creative Artists Agency')).toBe(true);
  });

  it('does not exclude indie venues that merely contain an excluded word', () => {
    // The whole-word rule exists for exactly these: substring matching killed
    // 'Live Oak' for containing 'live' and any name containing 'caa'.
    expect(isExcludedOrg('Live Oak Music Hall')).toBe(false);
    expect(isExcludedOrg('Terminal West')).toBe(false);
  });

  it('excludes the wedding/corporate/conference market', () => {
    expect(isExcludedCategory('Annual Sales Conference 2026')).toBe(true);
    expect(isExcludedCategory('Bridal Expo')).toBe(true);
    expect(isExcludedCategory('Turnstile / Touche Amore')).toBe(false);
  });

  it('flags warm-intro metros without excluding elsewhere', () => {
    expect(isPriorityMetro('Atlanta GA')).toBe(true);
    expect(isPriorityMetro('Denver CO')).toBe(false);
  });
});

describe('entity resolution', () => {
  it('collapses the ways one venue gets written', () => {
    const a = slugify('The EARL', 'Atlanta');
    expect(slugify('the earl atl', 'Atlanta')).toBe(a);
    expect(slugify('The Earl', 'Atlanta')).toBe(a);
  });

  it('ignores word order', () => {
    expect(slugify('Terminal West', 'Atlanta')).toBe(slugify('West Terminal', 'Atlanta'));
  });

  it('keeps same-named venues in different cities apart', () => {
    // Over-merging is the silent failure: it invents prospects.
    expect(slugify('The Loft', 'Atlanta')).not.toBe(slugify('The Loft', 'Dallas'));
  });

  it('does not reduce a purely generic name to nothing', () => {
    expect(slugify('The Venue', 'Atlanta')).toBeTruthy();
    expect(slugify('Music Hall', 'Nashville')).toBeTruthy();
  });

  it('strips presenter boilerplate down to the org', () => {
    expect(cleanPresenter('Presented by Rival Entertainment')).toBe('Rival Entertainment');
    expect(cleanPresenter('RIVAL ENTERTAINMENT presents')).toBe('RIVAL ENTERTAINMENT');
  });
});

describe('scoring', () => {
  const spread = (count: number, overDays: number) =>
    Array.from({ length: count }, (_, i) => daysAgo(Math.round((i * overDays) / count)));

  it('qualifies an in-band org observed long enough', () => {
    const r = scoreOrg({
      name: 'Terminal West',
      city: 'Atlanta',
      region: 'GA',
      capacity: 600,
      eventDates: spread(25, 360),
      distinctVenues: 1,
    });
    expect(r.band).toBe('qualified');
    expect(r.annualisedShows).toBeGreaterThanOrEqual(10);
    expect(r.annualisedShows).toBeLessThanOrEqual(50);
  });

  it('does not annualise a short window into a false qualification', () => {
    // 6 shows in 30 days annualises to ~73/yr. The arithmetic puts it out of
    // band; the point is that it must not be reported as a qualified 6-show org.
    const r = scoreOrg({
      name: 'Busy Room',
      city: 'Atlanta',
      region: 'GA',
      capacity: 400,
      eventDates: spread(6, 30),
      distinctVenues: 1,
    });
    expect(r.band).not.toBe('qualified');
    expect(r.annualisedShows).toBeGreaterThan(50);
  });

  it('holds an in-band org with too short a window on watch, not qualified', () => {
    const r = scoreOrg({
      name: 'New Promoter Co',
      city: 'Atlanta',
      region: 'GA',
      capacity: null,
      eventDates: spread(2, 40), // ~18/yr — in band, but only 40 days seen
      distinctVenues: 2,
    });
    expect(r.observationDays).toBeLessThan(MIN_OBSERVATION_DAYS);
    expect(r.band).toBe('watch');
  });

  it('excludes enterprise scale outright', () => {
    const r = scoreOrg({
      name: 'Big Amphitheater',
      city: 'Atlanta',
      region: 'GA',
      capacity: 18000,
      eventDates: spread(200, 360),
      distinctVenues: 1,
    });
    expect(r.band).toBe('excluded');
  });

  it('excludes a known enterprise promoter before counting anything', () => {
    const r = scoreOrg({
      name: 'Live Nation',
      city: 'Atlanta',
      region: 'GA',
      capacity: 600,
      eventDates: spread(20, 360),
      distinctVenues: 1,
    });
    expect(r.band).toBe('excluded');
  });

  it('counts announced future shows as evidence', () => {
    const r = scoreOrg({
      name: 'Forward Booker',
      city: 'Atlanta',
      region: 'GA',
      capacity: 500,
      eventDates: [...spread(12, 180), daysAhead(30), daysAhead(60), daysAhead(90)],
      distinctVenues: 3,
    });
    expect(r.showsTrailing12m).toBe(15);
    expect(r.observationDays).toBeGreaterThan(180);
  });

  it('scores a multi-venue promoter in a warm metro above a single-room one', () => {
    const base = { city: 'Atlanta', region: 'GA', capacity: 500, eventDates: spread(25, 360) };
    const promoter = scoreOrg({ ...base, name: 'Rival Entertainment', distinctVenues: 4 });
    const venue = scoreOrg({ ...base, name: 'Some Room', distinctVenues: 1 });
    expect(promoter.score).toBeGreaterThan(venue.score);
  });

  it('handles an org with no dated events', () => {
    const r = scoreOrg({
      name: 'Unknown Co',
      city: null,
      region: null,
      capacity: null,
      eventDates: [],
      distinctVenues: 0,
    });
    expect(r.band).toBe('out-of-band');
    expect(r.score).toBe(0);
  });
});

describe('date validation', () => {
  // Both of these came off a live AXS feed and both corrupted a real score.
  it('rejects placeholder dates', () => {
    expect(parseEventDate('TBD')).toBeNull();
    expect(parseEventDate('')).toBeNull();
    expect(parseEventDate(null)).toBeNull();
  });

  it('rejects a typo year that would stretch the observation window', () => {
    // One 2083 row turned a 12-month window into 57 years, which divides the
    // annualised rate down and makes a busy venue look in-band.
    expect(parseEventDate('2083-08-15')).toBeNull();
    expect(parseEventDate('1998-04-02')).toBeNull();
  });

  it('accepts real dates including announcements ~18 months out', () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(parseEventDate(`${nextYear}-04-16`)).toBe(`${nextYear}-04-16`);
    expect(parseEventDate('2026-09-24T20:00:00-04:00')).toBe('2026-09-24');
  });
});

describe('co-presented shows', () => {
  it('credits every promoter on a co-presented bill', () => {
    // Real credits from a live feed. Treating these as one org invents phantom
    // promoters and starves the real ones of show count.
    expect(splitPresenters('Speakeasy & Zero Mile present').sort()).toEqual(
      ['Speakeasy', 'Zero Mile'].sort()
    );
    expect(splitPresenters('Rival Entertainment & Zero Mile Present').sort()).toEqual(
      ['Rival Entertainment', 'Zero Mile'].sort()
    );
  });

  it('handles a three-way credit', () => {
    const r = splitPresenters("Speakeasy,  Triple D's,  Zero Mile present");
    expect(r).toContain('Speakeasy');
    expect(r).toContain('Zero Mile');
    expect(r.length).toBe(3);
  });

  it('leaves a single presenter alone', () => {
    expect(splitPresenters('Zero Mile Presents')).toEqual(['Zero Mile']);
  });
});

describe('forward-looking calendars', () => {
  // Measured against live AXS feeds: 139 of 140 events were in the future. A
  // calendar is a booking window, not a history, and the naive annualisation
  // excluded a real ICP promoter (Zero Mile: 65 shows over 4.5 months) as
  // "enterprise". These lock in the asymmetric handling.
  const ahead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const forward = (count: number, overDays: number) =>
    Array.from({ length: count }, (_, i) => ahead(1 + Math.round((i * overDays) / count)));

  it('does not exclude a busy indie promoter on forward-window extrapolation', () => {
    const r = scoreOrg({
      name: 'Zero Mile',
      city: 'Atlanta',
      region: 'GA',
      capacity: null,
      eventDates: forward(65, 134),
      distinctVenues: 2,
    });
    expect(r.band).not.toBe('excluded');
    expect(r.annualisedShows).toBeLessThan(150);
  });

  it('qualifies on counted shows without waiting out an elapsed window', () => {
    // 14 shows already announced is 14 shows, whatever the window length.
    const r = scoreOrg({
      name: 'Indie Promoter',
      city: 'Atlanta',
      region: 'GA',
      capacity: null,
      eventDates: forward(14, 60),
      distinctVenues: 3,
    });
    expect(r.band).toBe('qualified');
  });

  it('still excludes genuine enterprise scale on counted shows', () => {
    const r = scoreOrg({
      name: 'Huge Promoter',
      city: 'Atlanta',
      region: 'GA',
      capacity: null,
      eventDates: forward(200, 300),
      distinctVenues: 9,
    });
    expect(r.band).toBe('excluded');
  });

  it('holds a thin forward calendar on watch rather than qualifying it', () => {
    const r = scoreOrg({
      name: 'Tiny Co',
      city: 'Atlanta',
      region: 'GA',
      capacity: null,
      eventDates: forward(3, 45),
      distinctVenues: 1,
    });
    expect(r.band).toBe('watch');
  });
});
