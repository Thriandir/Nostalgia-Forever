# Nostalgia Forever

Guild management for **WoW: Forever** — a multi-guild portal for rosters, raid scheduling and signups, built for the community that grew out of the Turkish guild *Nostalji*.

> Live: <https://nostalgia.duzgunoyun.com> · API: `https://nostalgia-api.duzgunoyun.com`

Forever launched on 4 November 2026 with its own race/class matrix, surnames and level cap of 60. Existing guild tools assume vanilla rules, so this one is built around Forever's.

## What it does

- **Sign in with Google**, then link **Battle.net** and **Discord** from your profile. Google is the only identity; the other two prove "these characters / this handle are mine".
- **Characters** with first name + surname, faction, race, class and three spec fields (main, off-spec, levelling). Only combinations Forever actually allows are selectable, including the six changed pairings (Undead Paladin, Human Hunter, Dwarf Shaman, Gnome Priest, Orc Mage, Troll Warlock).
- **Battle.net import**: tick your Forever characters, pick a spec for each, done. Existing characters are matched to their Battle.net twin by first name, race, class and faction. If two look identical, neither is matched, so nothing gets mixed up.
- **Guilds**: create one, invite by link, choose which characters to bring, per-guild code of conduct that members agree to on joining.
- **Guild Roster board**: an ideal composition that officers arrange into parties, plus everyone who is levelling, grouped by role and sorted by what the guild is short of. Saved compositions, alts and off-spec toggles.
- **Raid calendar and signups**: month view on desktop, list on phones; times shown in your own time zone with server time alongside. Recurring raids, bulk signups, reserve list when a raid is full, officer accept/decline queue, weekly resets and lockouts, per-raid colours.
- **English and Turkish** throughout. Class, spec and race names stay in English on purpose.
- Horde / Alliance colour schemes, each in light and dark.

See [`DEVLOG.md`](DEVLOG.md) for how it got here, and the in-app *What's new* page (`web/js/config/changelog.js`) for tester-facing release notes.

## Architecture

```
┌────────────────────┐   fetch + cookie   ┌──────────────────────┐
│ web/  (static)     │ ─────────────────▶ │ worker/  (Cloudflare │
│ Cloudflare Pages   │                    │ Worker, REST API)    │
│ plain ES modules   │ ◀───────────────── │          │           │
└────────────────────┘        JSON        └──────────┼───────────┘
                                                     ▼
                                            Workers KV (NOSTALGIA_STATE)
```

- **Frontend** (`web/`): vanilla ES modules, hash router, no framework and no build step. Deploy = upload the folder.
- **API** (`worker/worker.js`): a single Cloudflare Worker. OAuth for Google, Discord and Battle.net, HMAC-signed session cookie, all state in KV. Every permission check happens on the server.
- **Storage**: KV only. Keys like `user:<id>`, `googleid:<id>`, `guild:<id>`, `invite:<code>`.
- **Two sibling subdomains on purpose**: Cloudflare's free Universal SSL only covers one subdomain level, so the site and API are `nostalgia.` and `nostalgia-api.` under the same parent. The session cookie is scoped to that parent. (`*.workers.dev` and `*.pages.dev` are blocked in Turkey, hence custom domains.)

### Layout

```
web/
  index.html
  css/styles.css
  js/
    app.js              boot: theme → locale → session → router
    config/             app, game rules (races/classes/specs), changelog
    core/               api, router, store, i18n, time, theme, names
    i18n/               en.js, tr.js (must keep identical keys)
    views/              profile, characters, guilds, progression, calendar, raid, …
worker/
  worker.js             the whole API
  wrangler.toml         public config; placeholders to fill in
DEPLOY.md               step-by-step deploy
```

## Running it

Full steps are in [`DEPLOY.md`](DEPLOY.md). In short:

1. `cd worker`, create the KV namespace, and fill the `REPLACE_WITH_…` values in `wrangler.toml`.
2. Add secrets with `wrangler secret put` (`GOOGLE_CLIENT_SECRET`, `DISCORD_CLIENT_SECRET`, `BATTLENET_CLIENT_SECRET`, `SESSION_SECRET`).
3. `wrangler deploy`, then bind your API domain.
4. Upload the **contents** of `web/` to a Cloudflare Pages project and bind your site domain.
5. Point `apiBase` in `web/js/config/app.js` at your API.

For local work, serve `web/` on port 8788 (it's in the Worker's default `ALLOWED_ORIGINS`) and set `apiBase` accordingly.

## Conventions worth knowing

- **Secrets never live in the repo.** Only public OAuth client IDs go in `wrangler.toml`.
- `en.js` and `tr.js` must have exactly the same keys.
- "Officer" means guild role `owner` or `admin`.
- Forever has no realms. `realmType` (PvE / PvP / RP / Hardcore) is used on purpose to select a guild's rule set.
- Battle.net doesn't return an e-mail, so identity is always Google and Battle.net is linked on top.
- Feature flags are in `web/js/config/app.js`. **`FEATURES.seedData` creates fake rosters and must be `false` before a guild uses the app for real.**

## Known limits

- Levels sync only when the user checks Battle.net; Blizzard gives no background access.
- The surname length limit (16) is a guess; surnames don't come from the API.
- No automated tests yet.

## Roadmap

- In-app polls (officer-created, one vote per Battle.net identity)
- Weekly availability matrix, with a team view for officers
- Assign players directly to raid slots
- Optional mandatory linked accounts per guild
- WhatsApp raid reminders / RSVP bot; Discord integration

## License

No license has been chosen yet, so all rights are reserved by default.
