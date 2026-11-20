# Nostalgia Forever — deploy steps

Two pieces, deployed separately: the **Worker** (API) and **Pages** (frontend).
Do the Worker first — the frontend needs its URL to exist.

---

## Part 1 — The API Worker

Everything here happens in a terminal, from inside the `worker/` folder.

### 1.1  Create the KV namespace

```
cd worker
wrangler kv namespace create NOSTALGIA_STATE
```

It prints an `id`. Open `wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID`
with that value.

### 1.2  Add the two secrets

```
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put DISCORD_CLIENT_SECRET
wrangler secret put BATTLENET_CLIENT_SECRET
wrangler secret put SESSION_SECRET
```

Each prompts for a value and hides it as you paste. The matching *client IDs*
are public and live in `wrangler.toml` (fill in the `REPLACE_WITH_…` values).

- `GOOGLE_CLIENT_SECRET` — from Google Cloud Console.
- `DISCORD_CLIENT_SECRET` / `BATTLENET_CLIENT_SECRET` — from the Discord and Blizzard developer portals (account linking only, not sign-in).
- `SESSION_SECRET` — any long random string. Generate one with:
  ```
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
  Nothing reads it but the Worker. If you ever change it, everyone is signed out.

### 1.3  Deploy

```
wrangler deploy
```

### 1.4  Bind the custom domain

`*.workers.dev` (and `*.pages.dev`) are blocked in Turkey, so the Worker needs to sit on your own domain.

Cloudflare dashboard → **Compute** → **Workers & Pages** → `nostalgia-api` →
**Settings** → **Domains & Routes** → **Add** → **Custom domain**:

```
nostalgia-api.duzgunoyun.com
```

Wait about a minute for the certificate, then check:

```
https://nostalgia-api.duzgunoyun.com/api/health
```

Expected: `{"ok":true,"app":"Nostalgia Forever"}`

If you get an SSL or DNS error, turn Cloudflare WARP off and flush DNS
(`ipconfig /flushdns`) before concluding anything is broken.

---

## Part 2 — The frontend

### 2.1  Create the Pages project

Cloudflare dashboard → **Compute** → **Workers & Pages** → **Create** →
**Pages** tab → **Upload assets**.

Project name:

```
nostalgia-forever
```

Confirm the screen says it will deploy to `nostalgia-forever.pages.dev` — that
means you're in the Pages flow rather than the Worker flow.

### 2.2  Upload

Drag the **contents** of the `web/` folder into the uploader. Before you click
Deploy, check the file list shows:

```
index.html
css/styles.css
js/app.js
js/config/app.js
js/core/…
js/i18n/…
js/views/…
```

`index.html` must sit at the top level, not inside a folder. If the list shows
`web/index.html`, cancel and drag the folder's contents rather than the folder.

Then **Deploy site**.

### 2.3  Bind the custom domain

Project → **Custom domains** → **Set up a custom domain**:

```
nostalgia.duzgunoyun.com
```

Cloudflare creates the DNS record and certificate automatically.

---

## Part 3 — Check it works

Open `https://nostalgia.duzgunoyun.com`.

You should see the sign-in card. Click **Continue with Google**, pick the
account you added as a test user, and you should land back on the app signed in.

Then confirm:

- **Profile** loads with your Google name, email and avatar.
- Changing **Language** to Türkçe switches the interface immediately.
- Changing **Appearance** switches light and dark.
- Changing **Faction colours** switches the red and blue palettes.
- **Save changes** shows a confirmation, and a page reload keeps the settings.

---

## Troubleshooting

**"redirect_uri_mismatch" from Google**
The URI in Google Cloud Console must be exactly:
`https://nostalgia-api.duzgunoyun.com/api/auth/google/callback`
No trailing slash. Changes can take a few minutes to apply.

**"access blocked" / "app not verified"**
The Google app is still in Testing and the account you used isn't a test user.
Google Auth Platform → **Audience** → **Test users** → add the address.

**Signed in, then immediately signed out**
The session cookie isn't reaching the API. Check `COOKIE_DOMAIN` in
`wrangler.toml` is the shared parent domain (`duzgunoyun.com`) and that both subdomains are live
over HTTPS.

**Sign-in works but /api/me returns 401**
Usually a CORS credentials problem. `ALLOWED_ORIGINS` must contain the exact
frontend origin, no trailing slash.

---

## Updating later

**Frontend:** Pages project → **Deployments** → **Create new deployment** →
drag the `web/` contents again. Every deployment is kept, so rollback is one click.

**API:** `wrangler deploy` from the `worker/` folder. KV data is untouched by
redeploys.
