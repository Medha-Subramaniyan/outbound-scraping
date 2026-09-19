# Scope and conduct

This repo collects contact data about real people. That is normal for outbound,
and it is also the reason to be explicit about where the lines are — so the
boundary is a decision the team made once, in writing, rather than something
each person re-derives under deadline.

## What this reads

Public event listings: venue calendars, the public JSON feeds those calendars
render themselves from, and official APIs with a key. These are published to be
read. The crawler reads them the way a person with a browser does, only
unattended.

Every request:

- goes out at **one per host per 1.5 seconds**, never parallel against one server
- **obeys robots.txt**, skipping disallowed paths rather than fetching anyway
- carries a **User-Agent with a contact address**, so anyone who notices the
  traffic can find out what it is and ask it to stop

Set `CRAWLER_CONTACT` in `.env` before running anything against a real site. An
anonymous crawler is the kind that gets blocked, and rightly.

## What this does not read

- **LinkedIn**, and contact databases generally. Automated access is against
  their terms, actively litigated, and technically adversarial. Not a grey area.
- **Anything behind a login**, paywall, or bot check. If a site put up a wall,
  that is an answer.
- **Personal social accounts.** A promoter's business listing is in scope; their
  personal profile is not.

If a source requires pretending not to be a bot, it is out of scope. The
politeness rules above are not obstacles to work around — they are what keeps
this defensible.

## Contact data

Contact discovery runs **only after an org passes the ICP gate**. This is a
deliberate ordering, not an optimisation: the fewer people whose details sit in
this database, the smaller the thing being looked after.

Emails are stored with their provenance:

| `email_source` | Meaning |
|---|---|
| `published` | The person's or org's own site listed it. Safe to use. |
| `role` | A role address like `booking@`. Real, but usually an unread firehose. |
| `inferred` | Pattern-guessed. **Never send to without verification** — a wrong guess is spam sent to an uninvolved person. |

## The database is not in git

`data/*.db` and `exports/` are gitignored. Each teammate scrapes their own copy.
Do not commit the database, export CSVs into the repo, or paste contact rows into
a shared doc that outlives the campaign.

## Sending

This repo finds and qualifies people. It does not send anything, and it should
stay that way — sending belongs in a tool that handles unsubscribe state and
suppression lists properly.

When you do send: honour opt-outs permanently, identify who you are, and follow
CAN-SPAM (and GDPR for anyone in the EU). "They published a booking email" is
a reason it is reasonable to write to them once about their actual business. It
is not consent for a sequence.
