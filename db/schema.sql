-- ─────────────────────────────────────────────────────────────────────────────
-- outbound-scraping schema
--
-- Four tables, in the order the pipeline fills them:
--
--   events  → the raw evidence. One row per show seen on a listing.
--   orgs    → events grouped by who is putting them on. Carries the score.
--   people  → humans at a qualified org. Only populated after scoring.
--   outreach→ contact state per person.
--
-- The events → orgs direction is the whole design: an org's show count is
-- derived from evidence rather than asserted by a data vendor. `events` is
-- therefore the table that must never be lossily deduped — it is the audit
-- trail behind every qualification decision.
--
-- Written in SQL that Postgres also accepts, so this can move off SQLite
-- without a rewrite.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── orgs ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  -- Normalised name used for entity resolution. "The EARL", "the earl atl" and
  -- "The Earl East Atlanta" collapse to one key here.
  slug             TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (kind IN ('venue', 'promoter', 'agency', 'unknown')),
  domain           TEXT,
  city             TEXT,
  region           TEXT,
  country          TEXT DEFAULT 'US',
  capacity         INTEGER,

  -- Industry classification, if one ever arrives from an enrichment source.
  -- Never populated by scraping: event listings carry no SIC/NAICS codes.
  sic_code         TEXT,
  naics_code       TEXT,

  -- ── Derived by the scorer. Null until `npm run score` has run. ──
  shows_trailing_12m INTEGER,
  -- Days between the earliest and latest event seen. A 40-show count drawn
  -- from a 30-day window is an extrapolation artefact, not a measurement, and
  -- the scorer refuses to qualify on it. See `observation_days` in scoring.
  observation_days   INTEGER,
  icp_score          REAL,
  icp_band           TEXT CHECK (icp_band IN ('qualified', 'watch', 'out-of-band', 'excluded')),
  score_reasons      TEXT,   -- JSON array of human-readable reasons
  scored_at          TEXT,

  -- When contact discovery last *attempted* this org, whether or not it found
  -- anyone. Recording the attempt rather than the result is the point: most
  -- venues yield nothing, and keying "already done" off the presence of a
  -- people row made every barren org get re-crawled on every run — 93 of 139
  -- orgs, each costing nine polite requests and several browser renders.
  enriched_at      TEXT,

  first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orgs_band  ON orgs(icp_band);
CREATE INDEX IF NOT EXISTS idx_orgs_city  ON orgs(city);
CREATE INDEX IF NOT EXISTS idx_orgs_kind  ON orgs(kind);

-- ── events ───────────────────────────────────────────────────────────────────
-- The evidence layer. Every qualification traces back to rows here.
CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  -- The org putting the show on. For a venue-presented show this is the venue;
  -- where a listing names a separate presenter, the promoter gets the credit
  -- and the venue is recorded alongside.
  org_id         TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  venue_org_id   TEXT REFERENCES orgs(id) ON DELETE SET NULL,

  title          TEXT NOT NULL,
  event_date     TEXT,           -- ISO date; null when a listing omits it
  venue_name     TEXT,
  city           TEXT,
  region         TEXT,
  presented_by   TEXT,           -- raw "Presented by ___" text, pre-resolution

  source         TEXT NOT NULL,  -- which adapter saw it
  source_url     TEXT,
  -- Natural key from the source platform, so re-running discovery updates a
  -- listing rather than duplicating it and inflating the show count.
  source_uid     TEXT,

  raw            TEXT,           -- JSON of what the adapter extracted
  seen_at        TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(source, source_uid)
);

CREATE INDEX IF NOT EXISTS idx_events_org   ON events(org_id);
CREATE INDEX IF NOT EXISTS idx_events_date  ON events(event_date);

-- ── people ───────────────────────────────────────────────────────────────────
-- Populated only for orgs that already passed the ICP gate. Contact discovery
-- is the expensive, sensitive step; spending it on unqualified orgs is how a
-- prospecting pipeline becomes both costly and creepy.
CREATE TABLE IF NOT EXISTS people (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  full_name      TEXT,
  title          TEXT,
  persona_key    TEXT,           -- from src/icp.ts PERSONAS
  persona_tier   TEXT CHECK (persona_tier IN ('primary', 'secondary', 'tertiary')),

  email          TEXT,
  -- 'published'  — the person's or org's own site listed it
  -- 'role'       — a role address like booking@, weaker
  -- 'inferred'   — pattern-guessed, never sent to without verification
  email_source   TEXT CHECK (email_source IN ('published', 'role', 'inferred')),
  phone          TEXT,
  profile_url    TEXT,

  source         TEXT NOT NULL,
  source_url     TEXT,
  found_at       TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(org_id, full_name, title)
);

CREATE INDEX IF NOT EXISTS idx_people_org    ON people(org_id);
CREATE INDEX IF NOT EXISTS idx_people_tier   ON people(persona_tier);

-- ── outreach ─────────────────────────────────────────────────────────────────
-- Same state machine as seobot's backlink_outreach, keyed to a person.
CREATE TABLE IF NOT EXISTS outreach (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'sent', 'replied', 'won', 'lost', 'bounced')),
  sent_at      TEXT,
  replied_at   TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(person_id)
);

CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach(status);

-- ── runs ─────────────────────────────────────────────────────────────────────
-- What each discovery run touched. Show count is a trailing-window measurement,
-- so knowing when a source was last crawled is part of reading the number.
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  events_seen   INTEGER DEFAULT 0,
  orgs_touched  INTEGER DEFAULT 0,
  error         TEXT
);
