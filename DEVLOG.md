# Devlog

Informal notes on how Nostalgia Forever came together, newest first. Tester-facing release notes live in the app's *What's new* page; this is the "why" behind them.

---

## 2026-11-20 — Putting it on GitHub

Until today the project lived only in a long-running chat thread and a Cloudflare dashboard, with no repo. Cleaned up for publishing: client IDs and the KV namespace id in `wrangler.toml` replaced with placeholders, `DEPLOY.md` brought in line with the real setup (it still described a two-level API domain and only two secrets), README and this log written.

## 2026-11-13 — Forever is in Blizzard's API

Blizzard opened Forever to the Battle.net API (`profile-forever-eu`). That unlocked the part I'd been scaffolding around for weeks:

- **Add from Battle.net** on the Characters page.
- **Matching** of existing characters to their Blizzard twin. Identity is the Blizzard character id; the first match uses first name + race + class + faction, and if it's ambiguous we match nothing. A wrong merge is worse than a missed one.
- **Sign-in now has a second step** asking to connect Battle.net (with *Back* and *Skip*). Battle.net moved to the global OAuth host so players from any region use one button.
- Levels refresh whenever the user checks Battle.net, because there is no background access.

Open from this: the surname limit is still a guess, and one Battle.net account can currently be linked to two Google accounts, which has to be fixed before polls can promise one vote per person.

## 2026-11-04 — Forever launches

Forever goes live. The app had been running since September, with the race/class matrix and surnames already built around Forever's rules.

## October — the guild decides

Before building more features, the guild had to decide what it was going to be. A Turkish-language survey (old Nostalji members plus people from the WhatsApp group) settled faction and ruleset, and the answer was to **split into two camps: Alliance PvE and Horde PvP**, sharing one Discord. That shaped the product: it has to serve more than one guild from day one, and members who could go either way need a way to say what they want to level.

Also decided: add an in-app survey and a weekly availability matrix, with a top navigation menu rather than a side menu. A WhatsApp Cloud API raid reminder/RSVP bot was sketched too: users add their number to their profile, get verified, and reply 1:1.

## 2026-09-18 — Calendar, raids, surnames

The biggest single day of features:

- Surnames, since Forever gives every character a family name. Display names shorten themselves: first name if unique, a surname initial on clashes, full name only where still ambiguous.
- Raid calendar (month on desktop, list on phones), signups with a character pick and note, officer accept/decline queue.
- Accepting someone clears their other signups that day, so nobody is double-booked.
- Recurring raids with a review step: pick weekdays and a time, see exactly which dates it produced, untick any, create them all. Capped to the visible month.
- Bulk signup, reserve list on full raids, weekly resets and custom lockouts (a three-day lockout shows up twice a week), per-raid colours.

Decision recorded: time handling is server time in storage, your own time on screen, including the DST hour that shifts for each side differently.

## 2026-09-17 — Guilds and the roster board

Guilds, invite links, join-with-a-character, per-guild code of conduct. The **Guild Roster board** is the heart of it: an ideal composition that officers arrange into parties, plus everyone levelling grouped by role and sorted by what the guild is short of. Off-specs are marked and never counted as real supply. Compositions can be saved by name and are what raids are created from.

Fixes the same day: class colours weren't rendering (and now stay readable on light themes), the six changed race/class pairings were using the vanilla rules, and editing a composition no longer reshuffles the party arrangement.

Characters removed from the app are kept for 30 days so they can be restored. It never touches the in-game character.

## 2026-09-16 — Live

First deploy. Google sign-in, characters with only the legal Forever combinations, English and Turkish, Horde/Alliance themes in light and dark, and the time zone groundwork.

### Infrastructure decisions from week one

- **No framework, no build.** Plain ES modules; deploying is dragging a folder into Cloudflare Pages. Keeps a one-person project easy to change and easy to hand over.
- **Cloudflare Worker + KV** for the API: cheap, no servers, good enough for guild-sized data.
- **Two sibling subdomains** instead of `api.nostalgia.…`, because free Universal SSL covers a single subdomain level. Cookie scoped to the shared parent.
- **Custom domains from the start**, since `workers.dev` and `pages.dev` are blocked in Turkey.
- **Secrets only via `wrangler secret put`.** They never go into chat, config or the repo.
- **Every permission check on the server.** The UI hides things for convenience only.
