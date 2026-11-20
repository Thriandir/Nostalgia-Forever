/**
 * Nostalgia Forever — API Worker
 *
 * Routes
 *   GET    /api/auth/google/login      → 302 to Google
 *   GET    /api/auth/google/callback   → exchange code, set session, 302 to app
 *   POST   /api/auth/logout            → clear session
 *   GET    /api/me                     → { user, characters, memberships }
 *   PUT    /api/me/profile             → update profile fields
 *   GET    /api/health                 → liveness
 *
 * Storage (KV: NOSTALGIA_STATE)
 *   user:<userId>        → { user, characters }
 *   googleid:<googleId>  → userId          (login index)
 *   guild:<guildId>      → { guild, members, characterSnapshot }
 *   invite:<code>        → guildId
 *
 * Secrets (wrangler secret put …)
 *   GOOGLE_CLIENT_SECRET
 *   SESSION_SECRET
 */

const SESSION_COOKIE = "nf_session";
const STATE_COOKIE = "nf_oauth_state";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function cors(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const allow = allowed.includes(origin) ? origin : allowed[0] || "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, init = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(init.headers || {}),
    },
  });
}

function redirect(url, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: url, ...extraHeaders },
  });
}

function uid(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge, domain, clear } = {}) {
  const bits = [
    `${name}=${clear ? "" : encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (domain) bits.push(`Domain=${domain}`);
  bits.push(`Max-Age=${clear ? 0 : maxAge}`);
  return bits.join("; ");
}

/* ------------------------------------------------------------------ *
 * JWT (HS256) via Web Crypto
 * ------------------------------------------------------------------ */

const enc = new TextEncoder();

function b64urlFromBytes(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromString(str) {
  return b64urlFromBytes(enc.encode(str));
}
function b64urlToString(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return atob(t);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signJWT(payload, secret, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttl };
  const head = b64urlFromString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${b64urlFromString(JSON.stringify(body))}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64urlFromBytes(sig)}`;
}

async function verifyJWT(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const key = await hmacKey(secret);
  let sigBytes;
  try {
    const raw = b64urlToString(parts[2]);
    sigBytes = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(data));
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlToString(parts[1]));
  } catch {
    return null;
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Decode a JWT body without verifying. Safe here: the id_token came
 *  straight from Google's token endpoint over TLS. */
function decodeJWTBody(token) {
  try {
    return JSON.parse(b64urlToString(token.split(".")[1]));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

async function kvGet(env, key) {
  const raw = await env.NOSTALGIA_STATE.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function kvPut(env, key, value) {
  await env.NOSTALGIA_STATE.put(key, JSON.stringify(value));
}

async function loadUserDoc(env, userId) {
  return kvGet(env, `user:${userId}`);
}
async function saveUserDoc(env, doc) {
  await kvPut(env, `user:${doc.user.id}`, doc);
}

/** Find an existing user by Google id, or create one. */
async function findOrCreateUser(env, profile) {
  const indexKey = `googleid:${profile.sub}`;
  const existingId = await env.NOSTALGIA_STATE.get(indexKey);

  if (existingId) {
    const doc = await loadUserDoc(env, existingId);
    if (doc) {
      doc.user.lastSeenAt = new Date().toISOString();
      // Refresh identity fields Google owns.
      doc.user.email = profile.email || doc.user.email;
      doc.user.avatarUrl = profile.picture || doc.user.avatarUrl;
      await saveUserDoc(env, doc);
      return doc;
    }
  }

  const now = new Date().toISOString();
  const doc = {
    user: {
      id: uid("u"),
      googleId: profile.sub,
      email: profile.email || "",
      displayName: profile.name || profile.email || "Adventurer",
      avatarUrl: profile.picture || null,
      locale: "en",
      themeMode: "dark",
      discordTag: null,
      telegramChatId: null,
      createdAt: now,
      lastSeenAt: now,
    },
    characters: [],
    memberships: [],
  };
  await saveUserDoc(env, doc);
  await env.NOSTALGIA_STATE.put(indexKey, doc.user.id);
  return doc;
}

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

async function getSession(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  return verifyJWT(token, env.SESSION_SECRET);
}

async function requireSession(request, env, headers) {
  const session = await getSession(request, env);
  if (!session) {
    return { error: json({ error: "unauthorized" }, { status: 401 }, headers) };
  }
  return { session };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function handleLogin(request, env, headers) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") || "/";
  const state = uid("st") + "|" + next;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  return redirect(authUrl.toString(), {
    ...headers,
    "Set-Cookie": cookie(STATE_COOKIE, state, {
      maxAge: 600,
      domain: env.COOKIE_DOMAIN,
    }),
  });
}

async function handleCallback(request, env, headers) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = parseCookies(request)[STATE_COOKIE];

  if (!code) return redirect(`${env.APP_URL}/#/?error=no_code`, headers);
  if (!state || state !== expected) {
    return redirect(`${env.APP_URL}/#/?error=bad_state`, headers);
  }

  // Exchange the authorization code for tokens.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    // Surface Google's own message in the Worker log. `wrangler tail` will
    // show it, which is far more useful than a generic failure.
    const detail = await tokenRes.text();
    console.error("[auth] token exchange failed", tokenRes.status, detail);
    console.error("[auth] redirect_uri sent was", env.GOOGLE_REDIRECT_URI);
    return redirect(`${env.APP_URL}/#/?error=token_exchange`, headers);
  }

  const tokens = await tokenRes.json();
  const profile = decodeJWTBody(tokens.id_token || "");
  if (!profile || !profile.sub) {
    console.error("[auth] no usable profile in id_token", JSON.stringify(tokens).slice(0, 300));
    return redirect(`${env.APP_URL}/#/?error=no_profile`, headers);
  }
  console.log("[auth] signed in", profile.email);

  const doc = await findOrCreateUser(env, profile);
  const jwt = await signJWT(
    { sub: doc.user.id, email: doc.user.email },
    env.SESSION_SECRET,
    SESSION_TTL
  );

  const next = state.includes("|") ? state.split("|").slice(1).join("|") : "/";
  const safeNext = next.startsWith("/") ? next : "/" + next;

  // Every sign-in passes through the welcome step. It forwards straight on
  // when Battle.net is already linked, and asks for it when it isn't.
  const target = `${env.APP_URL}/#/welcome?next=${encodeURIComponent(safeNext)}`;

  const setCookies = [
    cookie(SESSION_COOKIE, jwt, { maxAge: SESSION_TTL, domain: env.COOKIE_DOMAIN }),
    cookie(STATE_COOKIE, "", { clear: true, domain: env.COOKIE_DOMAIN }),
  ];

  const res = redirect(target, headers);
  for (const c of setCookies) res.headers.append("Set-Cookie", c);
  return res;
}

async function handleLogout(request, env, headers) {
  return json({ ok: true }, {}, {
    ...headers,
    "Set-Cookie": cookie(SESSION_COOKIE, "", {
      clear: true,
      domain: env.COOKIE_DOMAIN,
    }),
  });
}

async function handleMe(request, env, headers) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  // Lazy maintenance: purge expired deletions and backfill name parts on
  // characters created before Forever's two-part naming was known.
  let dirty = purgeExpired(doc);
  for (const c of doc.characters || []) {
    if (migrateCharacterName(c)) dirty = true;
  }
  if (dirty) await saveUserDoc(env, doc);

  return json(
    {
      user: doc.user,
      characters: doc.characters || [],
      memberships: doc.memberships || [],
      restoreWindowDays: RESTORE_WINDOW_DAYS,
    },
    {},
    headers
  );
}

const PROFILE_FIELDS = [
  "displayName",
  "locale",
  "themeMode",
  "whatsappPhone",
  "whatsappUsername",
  "telegramChatId",
];

/** Characters stay restorable for this long after deletion. */
const RESTORE_WINDOW_DAYS = 30;
const RESTORE_WINDOW_MS = RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * E.164: a leading +, then 8–15 digits, first of which can't be 0.
 * WhatsApp's API addresses numbers only in this form, so validating at entry
 * is far cheaper than chasing bad numbers when reminders start failing.
 */
function normalisePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null;
}

/** Drop anything past the restore window. Runs lazily, on read. */
function purgeExpired(doc) {
  const cutoff = Date.now() - RESTORE_WINDOW_MS;
  const before = (doc.characters || []).length;
  doc.characters = (doc.characters || []).filter((c) => {
    if (!c.deletedAt) return true;
    return new Date(c.deletedAt).getTime() > cutoff;
  });
  return doc.characters.length !== before;
}

async function handleProfileUpdate(request, env, headers) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  for (const field of PROFILE_FIELDS) {
    if (field in body) doc.user[field] = body[field];
  }

  // Clamp anything the client could have tampered with.
  if (!["en", "tr"].includes(doc.user.locale)) doc.user.locale = "en";
  if (!["light", "dark"].includes(doc.user.themeMode)) doc.user.themeMode = "dark";
  doc.user.whatsappPhone = normalisePhone(doc.user.whatsappPhone);
  doc.user.whatsappUsername =
    String(doc.user.whatsappUsername || "").trim().slice(0, 40) || null;
  if (typeof doc.user.displayName !== "string" || !doc.user.displayName.trim()) {
    doc.user.displayName = doc.user.email || "Adventurer";
  }
  doc.user.displayName = doc.user.displayName.slice(0, 40);

  await saveUserDoc(env, doc);
  return json({ user: doc.user }, {}, headers);
}

/* ------------------------------------------------------------------ *
 * Account linking — Discord and Battle.net
 * ------------------------------------------------------------------ *
 *
 * These are NOT sign-in methods. Google remains the only way to authenticate;
 * linking proves "this Discord account is mine" or "these WoW characters are
 * mine". A session must already exist before either flow starts, which is why
 * the login step requires one.
 *
 * Battle.net is the interesting one: the wow.profile scope returns each
 * character's realm, class, race, faction and LEVEL. That lets us replace a
 * self-reported level bucket with the real thing — but self-reporting stays
 * the baseline, because Forever may never appear in Blizzard's API at all.
 * Anything here is an enhancement, never a dependency.
 */

const LINK_STATE_COOKIE = "nf_link_state";

/** Where Blizzard's OAuth lives. Regional, and the region must match. */
/**
 * Blizzard's OAuth host for sign-in and linking.
 *
 * Global rather than regional: oauth.battle.net serves every region except
 * China, so an EU player and a US player both come through one door without
 * choosing a region first. The data APIs stay regional — see apiHost.
 */
function oauthHost(env) {
  const region = (env.BATTLENET_REGION || "eu").toLowerCase();
  return region === "cn" ? "https://oauth.battlenet.com.cn" : "https://oauth.battle.net";
}

function bnetHost(env) {
  const region = (env.BATTLENET_REGION || "eu").toLowerCase();
  return region === "cn" ? "https://oauth.battlenet.com.cn" : `https://${region}.battle.net`;
}

const LINK_PROVIDERS = {
  discord: {
    authUrl: () => "https://discord.com/api/oauth2/authorize",
    tokenUrl: () => "https://discord.com/api/oauth2/token",
    scope: "identify",
    clientId: (env) => env.DISCORD_CLIENT_ID,
    clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
    redirect: (env) => env.DISCORD_REDIRECT_URI,
  },
  battlenet: {
    authUrl: (env) => `${oauthHost(env)}/authorize`,
    tokenUrl: (env) => `${oauthHost(env)}/token`,
    scope: "openid wow.profile",
    clientId: (env) => env.BATTLENET_CLIENT_ID,
    clientSecret: (env) => env.BATTLENET_CLIENT_SECRET,
    redirect: (env) => env.BATTLENET_REDIRECT_URI,
  },
};

async function handleLinkStart(request, env, headers, providerName) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const provider = LINK_PROVIDERS[providerName];
  if (!provider) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!provider.clientId(env)) {
    return json({ error: "provider_unconfigured" }, { status: 503 }, headers);
  }

  // Where to land afterwards. Only same-app hash paths are accepted, so this
  // can't be turned into an open redirect.
  const url0 = new URL(request.url);
  const requested = url0.searchParams.get("return") || "/me/profile";
  const returnTo = /^\/[\w\-/]*$/.test(requested) ? requested : "/me/profile";
  const state = `${uid("ls")}|${providerName}|${returnTo}`;
  const url = new URL(provider.authUrl(env));
  url.searchParams.set("client_id", provider.clientId(env));
  url.searchParams.set("redirect_uri", provider.redirect(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);

  return redirect(url.toString(), {
    ...headers,
    "Set-Cookie": cookie(LINK_STATE_COOKIE, state, {
      maxAge: 600,
      domain: env.COOKIE_DOMAIN,
    }),
  });
}

async function handleLinkCallback(request, env, headers, providerName) {
  const returnTo = (() => {
    const raw = new URL(request.url).searchParams.get("state") || "";
    const parts = raw.split("|");
    const candidate = parts[2] || "/me/profile";
    return /^\/[\w\-/]*$/.test(candidate) ? candidate : "/me/profile";
  })();
  const back = (status) => `${env.APP_URL}/#${returnTo}?link=${status}`;

  const session = await getSession(request, env);
  if (!session) return redirect(back("session_expired"), headers);

  const provider = LINK_PROVIDERS[providerName];
  if (!provider) return redirect(back("failed"), headers);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = parseCookies(request)[LINK_STATE_COOKIE];

  if (!code) return redirect(back("cancelled"), headers);
  if (!state || state !== expected) return redirect(back("expired"), headers);

  const tokenRes = await fetch(provider.tokenUrl(env), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Blizzard wants HTTP Basic; Discord accepts credentials in the body.
      ...(providerName === "battlenet"
        ? {
            Authorization:
              "Basic " + btoa(`${provider.clientId(env)}:${provider.clientSecret(env)}`),
          }
        : {}),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: provider.redirect(env),
      ...(providerName === "discord"
        ? { client_id: provider.clientId(env), client_secret: provider.clientSecret(env) }
        : {}),
    }),
  });

  if (!tokenRes.ok) {
    console.error(`[link:${providerName}] token exchange failed`, tokenRes.status, await tokenRes.text());
    return redirect(back("failed"), headers);
  }

  const tokens = await tokenRes.json();
  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return redirect(back("failed"), headers);
  let syncedForGuilds = [];

  try {
    if (providerName === "discord") {
      const me = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }).then((r) => (r.ok ? r.json() : null));
      if (!me) return redirect(back("failed"), headers);

      doc.user.discordId = me.id;
      doc.user.discordTag = me.username;
      doc.user.discordAvatar = me.avatar
        ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
        : null;
      doc.user.discordLinkedAt = new Date().toISOString();
    } else {
      const me = await fetch(`${oauthHost(env)}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }).then((r) => (r.ok ? r.json() : null));
      if (!me) return redirect(back("failed"), headers);

      doc.user.battleTag = me.battletag || null;
      doc.user.battlenetId = String(me.id ?? me.sub ?? "");
      doc.user.battlenetLinkedAt = new Date().toISOString();

      // Best-effort character pull. Forever may not be exposed at all, in
      // which case we simply have a linked account and nothing more.
      const profile = await fetchWowCharacters(env, tokens.access_token);
      doc.user.wowCharacters = profile;
      doc.user.wowCharactersAt = profile ? new Date().toISOString() : null;

      // Match site characters to their Forever counterparts and bring levels
      // up to date. Guild snapshots are pushed after the save below.
      syncedForGuilds = syncForeverCharacters(doc);
    }
  } catch (err) {
    console.error(`[link:${providerName}] profile fetch failed`, String(err));
    return redirect(back("failed"), headers);
  }

  await saveUserDoc(env, doc);
  for (const character of syncedForGuilds) {
    await syncCharacterSnapshot(env, doc, character, character.guildId);
  }

  const res = redirect(back("ok"), headers);
  res.headers.append(
    "Set-Cookie",
    cookie(LINK_STATE_COOKIE, "", { clear: true, domain: env.COOKIE_DOMAIN })
  );
  return res;
}

/**
 * Pull the account's WoW characters.
 *
 * Tries each namespace we know about and keeps whatever answers. Classic
 * Armory currently covers Era, Hardcore and Season of Discovery; whether
 * Forever gets its own namespace is unknown until launch, so this is written
 * to degrade to null rather than to assume.
 *
 * ⚠ WHEN FOREVER'S NAMESPACE OPENS, READ THIS FIRST.
 *
 * Per-character lookups elsewhere use the documented retail shape:
 *   /profile/wow/character/{realmSlug}/{characterName}
 *
 * That cannot work for Forever. There are NO REALMS — you pick a ruleset, and
 * names are unique per region — so there is no realmSlug. And names are two
 * parts now, so {characterName} is ambiguous too. Whatever Blizzard publishes
 * as the replacement, the per-character path needs rewriting; this account-
 * level endpoint may survive unchanged, but don't assume it.
 */
async function fetchWowCharacters(env, accessToken) {
  const region = (env.BATTLENET_REGION || "eu").toLowerCase();

  // Probed in order of usefulness, and deliberately speculative at the top.
  //
  // `classicforever` is the prefix community projects have adopted for
  // Forever; Blizzard signalled the namespace would be published during
  // beta but hadn't at time of writing. Probing for it costs one failed
  // request and means level syncing starts working the day it appears,
  // with no code change. If the real name turns out different, add it here.
  const namespaces = [
    `profile-classicforever-${region}`,
    `profile-forever-${region}`,
    `profile-classic-${region}`,
    `profile-classic1x-${region}`,
    `profile-${region}`,
  ];

  const found = [];
  const probed = [];

  for (const namespace of namespaces) {
    try {
      const res = await fetch(
        `https://${region}.api.blizzard.com/profile/user/wow?namespace=${namespace}&locale=en_GB`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      probed.push(`${namespace}:${res.status}`);
      if (!res.ok) continue;
      const data = await res.json();

      for (const account of data.wow_accounts || []) {
        for (const c of account.characters || []) {
          found.push({
            id: String(c.id),
            name: c.name,
            realm: c.realm?.name || c.realm?.slug || "",
            realmSlug: c.realm?.slug || "",
            level: c.level ?? null,
            class: c.playable_class?.name || null,
            race: c.playable_race?.name || null,
            faction: c.faction?.name || null,
            namespace,
          });
        }
      }
    } catch {
      /* a namespace that doesn't answer simply isn't there */
    }
  }

  // Logged so `wrangler tail` tells us the moment Forever's namespace starts
  // answering, without anyone having to guess.
  console.log("[battlenet] namespaces probed:", probed.join(", "), "| characters:", found.length);

  return found.length ? found : null;
}

/* ------------------------------------------------------------------ *
 * Forever armory: matching and level sync
 *
 * Blizzard opened `profile-forever-{region}` after launch. What it gives:
 * id, first name only (no surname), level, race, class, faction — and an
 * empty realm, because Forever has none. So:
 *
 *   - Characters are tied by Blizzard's character id (`bnetId`), never by
 *     name. Names alone aren't unique and the surname never arrives.
 *   - The first tie is made by matching first name + race + class + faction,
 *     and only when exactly one candidate fits on each side.
 *   - Levels refresh whenever Battle.net is checked — on linking, "Check
 *     again", or the refresh button on Characters. Blizzard issues no
 *     refresh token, so there is no background polling; the per-character
 *     endpoint needs a realm slug Forever doesn't have.
 * ------------------------------------------------------------------ */

function isForeverNamespace(namespace) {
  return /^profile-(classic)?forever-/.test(String(namespace || ""));
}

function foreverCharactersOf(user) {
  return (user.wowCharacters || []).filter((c) => isForeverNamespace(c.namespace));
}

function levelBucketFor(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n < 1) return null;
  if (n < 20) return "1-19";
  if (n < 40) return "20-39";
  if (n < 56) return "40-55";
  return String(Math.min(60, Math.floor(n)));
}

function sameName(a, b) {
  return String(a || "").trim().toLocaleLowerCase("tr") ===
    String(b || "").trim().toLocaleLowerCase("tr");
}

function matchesBnet(character, bnet) {
  return (
    sameName(character.firstName ?? splitLegacyName(character.name).firstName, String(bnet.name || "").split(/\s+/)[0]) &&
    character.race === bnet.race &&
    character.class === bnet.class &&
    character.faction === bnet.faction
  );
}

/** Copy Blizzard's facts onto a site character. Returns true if anything changed. */
function applyBnet(character, bnet, now) {
  const bucket = levelBucketFor(bnet.level);
  const before = `${character.bnetId}|${character.level}|${character.levelBucket}`;
  character.bnetId = bnet.id;
  character.level = Number.isFinite(Number(bnet.level)) ? Number(bnet.level) : null;
  if (bucket) character.levelBucket = bucket;
  character.levelSyncedAt = now;
  return before !== `${character.bnetId}|${character.level}|${character.levelBucket}`;
}

/**
 * Tie site characters to Forever characters and refresh levels, in place.
 * Returns the characters whose guild snapshot needs pushing.
 */
function syncForeverCharacters(doc) {
  const forever = foreverCharactersOf(doc.user);
  const live = (doc.characters || []).filter((c) => !c.deletedAt);
  const now = new Date().toISOString();
  const changed = [];
  if (!forever.length) return changed;

  const byId = new Map(forever.map((b) => [b.id, b]));

  // 1. Already tied: refresh.
  for (const c of live) {
    if (!c.bnetId) continue;
    const b = byId.get(c.bnetId);
    if (b && applyBnet(c, b, now)) changed.push(c);
  }

  // 2. Not yet tied: tie only on an unambiguous match in both directions.
  const claimed = new Set(live.map((c) => c.bnetId).filter(Boolean));
  for (const c of live) {
    if (c.bnetId) continue;
    const candidates = forever.filter((b) => !claimed.has(b.id) && matchesBnet(c, b));
    if (candidates.length !== 1) continue;
    const b = candidates[0];
    const rivals = live.filter((o) => !o.bnetId && matchesBnet(o, b));
    if (rivals.length !== 1) continue;
    claimed.add(b.id);
    applyBnet(c, b, now);
    changed.push(c);
  }

  return changed.filter((c) => c.guildId);
}

/**
 * Create site characters from Forever ones the player picked.
 *
 * Blizzard supplies name, race, class, faction and level. Spec has no API
 * equivalent in Classic, so the player chooses it per character; surname
 * and ruleset come from the form as well.
 */
async function handleCharacterImport(request, env, headers) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const picks = Array.isArray(body.characters) ? body.characters.slice(0, 40) : [];
  if (!picks.length) return json({ error: "validation", fields: ["characters"] }, { status: 400 }, headers);

  doc.characters = doc.characters || [];
  if (doc.characters.length + picks.length > 40) {
    return json({ error: "too_many_characters" }, { status: 400 }, headers);
  }

  const forever = new Map(foreverCharactersOf(doc.user).map((b) => [b.id, b]));
  const claimed = new Set(doc.characters.filter((c) => !c.deletedAt).map((c) => c.bnetId).filter(Boolean));
  const realmType = VALID.realmTypes.includes(body.realmType) ? body.realmType : "PvE";
  const region = (env.BATTLENET_REGION || "eu").toUpperCase() === "US" ? "US" : "EU";
  const now = new Date().toISOString();

  const created = [];
  const failed = [];

  for (const pick of picks) {
    const b = forever.get(String(pick.bnetId));
    if (!b || claimed.has(b.id)) {
      failed.push({ bnetId: pick.bnetId, fields: ["bnetId"] });
      continue;
    }

    const live = doc.characters.filter((c) => !c.deletedAt);
    const commitment = VALID.commitments.includes(pick.commitment)
      ? pick.commitment
      : hasLivePrimary(live, b.faction) ? "alt" : "primary";

    const { ok, errors, value } = validateCharacter({
      firstName: String(b.name || "").split(/\s+/)[0],
      lastName: pick.lastName || "",
      region,
      realmType,
      faction: b.faction,
      race: b.race,
      class: b.class,
      spec: pick.spec,
      offSpec: pick.offSpec || null,
      levellingSpec: pick.levellingSpec || pick.spec,
      commitment,
      levelBucket: levelBucketFor(b.level) || "1-19",
    });
    if (!ok) {
      failed.push({ bnetId: b.id, fields: errors });
      continue;
    }

    const character = {
      id: uid("c"),
      userId: doc.user.id,
      guildId: null,
      ...value,
      raidReady: false,
      attunements: {},
      itemLevel: null,
      gear: null,
      gearUpdatedAt: null,
      seekingGuild: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: doc.user.id,
    };
    applyBnet(character, b, now);
    doc.characters.push(character);
    enforceSinglePrimary(doc.characters, character);
    claimed.add(b.id);
    created.push(character);
  }

  if (!created.length) {
    return json({ error: "validation", failed }, { status: 400 }, headers);
  }

  await saveUserDoc(env, doc);
  return json({ created: created.length, failed, characters: doc.characters }, { status: 201 }, headers);
}

/** Drop a link. Nothing else depends on it, so this is a field reset. */
async function handleUnlink(request, env, headers, providerName) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  if (providerName === "discord") {
    doc.user.discordId = null;
    doc.user.discordTag = null;
    doc.user.discordAvatar = null;
    doc.user.discordLinkedAt = null;
  } else if (providerName === "battlenet") {
    doc.user.battleTag = null;
    doc.user.battlenetId = null;
    doc.user.battlenetLinkedAt = null;
    doc.user.wowCharacters = null;
    doc.user.wowCharactersAt = null;
  } else {
    return json({ error: "not_found" }, { status: 404 }, headers);
  }

  await saveUserDoc(env, doc);
  return json({ user: doc.user }, {}, headers);
}

/* ------------------------------------------------------------------ *
 * Characters
 * ------------------------------------------------------------------ */

/**
 * Validation tables.
 *
 * Deliberately duplicated from web/js/config/game.js. The client filters the
 * dropdowns; the server refuses anything that doesn't match, because a client
 * is never trusted. If Forever changes a spec list, BOTH files need editing —
 * the comment in game.js says the same thing in reverse.
 */
const VALID = {
  regions: ["EU", "US"],
  realmTypes: ["PvE", "PvP", "RP", "Hardcore"],
  factions: ["Horde", "Alliance"],
  commitments: ["primary", "secondary", "alt"],
  levelBuckets: ["1-19", "20-39", "40-55", "56", "57", "58", "59", "60"],
  specs: {
    Warrior: { Arms: "DPS", Fury: "DPS", Protection: "Tank" },
    Paladin: { Holy: "Healer", Protection: "Tank", Retribution: "DPS" },
    Hunter: { "Beast Mastery": "DPS", Marksmanship: "DPS", Survival: "DPS" },
    Rogue: { Assassination: "DPS", Combat: "DPS", Subtlety: "DPS" },
    Priest: { Discipline: "Healer", Holy: "Healer", Shadow: "DPS" },
    Shaman: { Elemental: "DPS", Enhancement: "DPS", Restoration: "Healer" },
    Mage: { Arcane: "DPS", Fire: "DPS", Frost: "DPS" },
    Warlock: { Affliction: "DPS", Demonology: "DPS", Destruction: "DPS" },
    Druid: {
      Balance: "DPS",
      "Feral Tank": "Tank",
      "Feral DPS": "DPS",
      Restoration: "Healer",
    },
  },
  races: {
    Alliance: ["Human", "Dwarf", "Night Elf", "Gnome", "Skyborne"],
    Horde: ["Orc", "Undead", "Tauren", "Troll", "Skyborne"],
  },
  // Forever's matrix, NOT vanilla's. Six combos differ: Human Hunter,
  // Dwarf Shaman, Gnome Priest, Orc Mage, Troll Warlock, Undead Paladin.
  raceClasses: {
    Human: ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Mage", "Warlock"],
    Dwarf: ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Shaman"],
    "Night Elf": ["Warrior", "Hunter", "Rogue", "Priest", "Druid"],
    Gnome: ["Warrior", "Rogue", "Priest", "Mage", "Warlock"],
    Orc: ["Warrior", "Hunter", "Rogue", "Shaman", "Mage", "Warlock"],
    Undead: ["Warrior", "Paladin", "Rogue", "Priest", "Mage", "Warlock"],
    Tauren: ["Warrior", "Hunter", "Shaman", "Druid"],
    Troll: ["Warrior", "Hunter", "Rogue", "Priest", "Shaman", "Mage", "Warlock"],
    Skyborne: {
      Alliance: ["Warrior", "Hunter", "Rogue", "Druid", "Mage"],
      Horde: ["Warrior", "Hunter", "Rogue", "Druid", "Shaman"],
    },
  },
};

function classesForRace(race, faction) {
  const entry = VALID.raceClasses[race];
  if (!entry) return [];
  return Array.isArray(entry) ? entry : entry[faction] || [];
}

/**
 * Split a legacy single name into its parts.
 *
 * Characters created before Forever's two-part naming was known have one
 * `name`. Everything downstream still reads `.name`, so it stays as the
 * canonical full string and the two halves sit alongside it.
 */
function splitLegacyName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join("") || "" };
}

/** Backfills the name parts on an older character record, in place. */
function migrateCharacterName(character) {
  if (character.firstName !== undefined) return false;
  const { firstName, lastName } = splitLegacyName(character.name);
  character.firstName = firstName;
  character.lastName = lastName;
  return true;
}

/** Returns { ok, errors, value } — never throws on bad input. */
function validateCharacter(input) {
  const errors = [];
  const v = {};

  // Forever gives every character a first name and a surname, and uniqueness
  // is on the pair — two people can both be "Lavanta". The surname stays
  // OPTIONAL here until name reservation opens on 27 October, because forcing
  // one today just makes people invent something they'll change.
  const fallback = splitLegacyName(input.name);
  v.firstName = String(input.firstName ?? fallback.firstName)
    .trim()
    .replace(/[^\p{L}]/gu, "")
    .slice(0, 12);
  if (v.firstName.length < 2) errors.push("firstName");

  // 12 for the first name is documented; 16 for the surname is a guess —
  // Blizzard has only said "a single word, no space or hyphen". If a real
  // limit is published, change it here AND the maxlength in the character
  // form (web/js/views/characters.js).
  v.lastName = String(input.lastName ?? fallback.lastName)
    .trim()
    .replace(/[^\p{L}]/gu, "")
    .slice(0, 16);

  // The canonical full name, kept so everything reading `.name` still works
  // and there's one string to sort and search on.
  v.name = v.lastName ? `${v.firstName} ${v.lastName}` : v.firstName;

  v.region = VALID.regions.includes(input.region) ? input.region : null;
  if (!v.region) errors.push("region");

  v.realmType = VALID.realmTypes.includes(input.realmType) ? input.realmType : null;
  if (!v.realmType) errors.push("realmType");

  v.faction = VALID.factions.includes(input.faction) ? input.faction : null;
  if (!v.faction) errors.push("faction");

  v.race = (VALID.races[v.faction] || []).includes(input.race) ? input.race : null;
  if (!v.race) errors.push("race");

  const legalClasses = classesForRace(v.race, v.faction);
  v.class = legalClasses.includes(input.class) ? input.class : null;
  if (!v.class) errors.push("class");

  const specTable = VALID.specs[v.class] || {};
  v.spec = specTable[input.spec] ? input.spec : null;
  if (!v.spec) errors.push("spec");

  // Role is derived, never accepted from the client.
  v.role = v.spec ? specTable[v.spec] : null;

  // Off-spec: null is legitimate and means "none". The client makes the user
  // answer rather than defaulting, but a null arriving here is valid data,
  // not a missing field.
  v.offSpec = input.offSpec && specTable[input.offSpec] ? input.offSpec : null;
  if (v.offSpec === v.spec) v.offSpec = null;

  // Levelling spec: what they're actually playing on the way to 60, which is
  // often not the raid spec. Never counted toward composition. Falls back to
  // the main spec, which is the common case.
  v.levellingSpec = input.levellingSpec && specTable[input.levellingSpec]
    ? input.levellingSpec
    : v.spec;

  v.commitment = VALID.commitments.includes(input.commitment)
    ? input.commitment
    : "primary";

  v.levelBucket = VALID.levelBuckets.includes(input.levelBucket)
    ? input.levelBucket
    : "1-19";

  const planner = String(input.plannerUrl || "").trim();
  v.plannerUrl = /^https?:\/\//i.test(planner) ? planner.slice(0, 300) : null;

  v.notes = String(input.notes || "").trim().slice(0, 300);

  return { ok: errors.length === 0, errors, value: v };
}

/**
 * One primary per faction. Promoting a character demotes the previous one.
 * Deleted characters are skipped — they don't hold the slot while in the bin.
 */
function enforceSinglePrimary(characters, subject) {
  if (subject.commitment !== "primary") return;
  for (const other of characters) {
    if (other.id === subject.id) continue;
    if (other.deletedAt) continue;
    if (other.faction !== subject.faction) continue;
    if (other.commitment === "primary") other.commitment = "secondary";
  }
}

/** True when a live primary already exists for this faction. */
function hasLivePrimary(characters, faction, exceptId) {
  return characters.some(
    (c) =>
      c.id !== exceptId &&
      !c.deletedAt &&
      c.faction === faction &&
      c.commitment === "primary"
  );
}

async function handleCharacterCreate(request, env, headers) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  if ((doc.characters || []).length >= 40) {
    return json({ error: "too_many_characters" }, { status: 400 }, headers);
  }

  const { ok, errors, value } = validateCharacter(body);
  if (!ok) return json({ error: "validation", fields: errors }, { status: 400 }, headers);

  const now = new Date().toISOString();
  const character = {
    id: uid("c"),
    userId: doc.user.id,
    guildId: null,
    ...value,
    raidReady: false,
    attunements: {},
    itemLevel: null,
    gear: null,
    gearUpdatedAt: null,
    seekingGuild: false,
    createdAt: now,
    updatedAt: now,
    updatedBy: doc.user.id,
  };

  doc.characters = doc.characters || [];
  doc.characters.push(character);
  enforceSinglePrimary(doc.characters, character);
  await saveUserDoc(env, doc);

  return json({ character, characters: doc.characters }, { status: 201 }, headers);
}

async function handleCharacterUpdate(request, env, headers, characterId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  const existing = (doc.characters || []).find((c) => c.id === characterId);
  if (!existing) return json({ error: "not_found" }, { status: 404 }, headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const { ok, errors, value } = validateCharacter({ ...existing, ...body });
  if (!ok) return json({ error: "validation", fields: errors }, { status: 400 }, headers);

  // A Battle.net-tied character's level comes from Blizzard, not the form.
  if (existing.bnetId && existing.level != null) {
    value.levelBucket = levelBucketFor(existing.level) || value.levelBucket;
    // Race, class and faction are fixed in game; keep Blizzard's.
    for (const k of ["race", "class", "faction"]) value[k] = existing[k];
  }

  Object.assign(existing, value, {
    updatedAt: new Date().toISOString(),
    updatedBy: doc.user.id,
  });
  enforceSinglePrimary(doc.characters, existing);
  await saveUserDoc(env, doc);
  await syncCharacterSnapshot(env, doc, existing, existing.guildId);

  return json({ character: existing, characters: doc.characters }, {}, headers);
}

/**
 * Soft delete. The character is hidden and becomes restorable for 30 days,
 * then purges on the next read. Nothing here touches the in-game character —
 * the UI says so explicitly, because people assume otherwise.
 */
async function handleCharacterDelete(request, env, headers, characterId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  const character = (doc.characters || []).find(
    (c) => c.id === characterId && !c.deletedAt
  );
  if (!character) return json({ error: "not_found" }, { status: 404 }, headers);

  character.deletedAt = new Date().toISOString();
  character.updatedAt = character.deletedAt;
  await saveUserDoc(env, doc);
  // Drops out of the guild snapshot immediately, even though it's restorable.
  await syncCharacterSnapshot(env, doc, character, character.guildId);

  return json({ characters: doc.characters }, {}, headers);
}

async function handleCharacterRestore(request, env, headers, characterId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadUserDoc(env, session.sub);
  if (!doc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  purgeExpired(doc);

  const character = (doc.characters || []).find(
    (c) => c.id === characterId && c.deletedAt
  );
  if (!character) return json({ error: "not_found" }, { status: 404 }, headers);

  // If something else claimed the primary slot while this was in the bin,
  // it comes back as a second main rather than silently creating two primaries.
  if (
    character.commitment === "primary" &&
    hasLivePrimary(doc.characters, character.faction, character.id)
  ) {
    character.commitment = "secondary";
  }

  character.deletedAt = null;
  character.updatedAt = new Date().toISOString();
  await saveUserDoc(env, doc);
  await syncCharacterSnapshot(env, doc, character, character.guildId);

  return json({ character, characters: doc.characters }, {}, headers);
}

/* ------------------------------------------------------------------ *
 * Guilds
 * ------------------------------------------------------------------ *
 *
 * Storage shape:
 *   guild:<guildId>   { guild, members[], characters[] }
 *   invite:<code>     { guildId, createdBy, createdAt, expiresAt, revoked }
 *   user:<userId>     .memberships[] mirrors the member list
 *
 * `guild.characters` is a DENORMALISED SNAPSHOT of every character assigned
 * to the guild. The canonical record lives on the user. The snapshot exists
 * because the progression board needs every character in the guild at once,
 * and scanning a hundred user documents to build that would be unworkable.
 *
 * The cost is two writes per character edit. Keep them together — anything
 * that mutates a character must call syncCharacterSnapshot().
 */

const GUILD_ROLES = ["owner", "admin", "member"];
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

function inviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

/** The subset of a character the guild snapshot carries. */
function snapshotOf(character, user) {
  return {
    id: character.id,
    userId: character.userId,
    ownerName: user.displayName,
    name: character.name,
    firstName: character.firstName,
    lastName: character.lastName,
    race: character.race,
    class: character.class,
    spec: character.spec,
    offSpec: character.offSpec,
    levellingSpec: character.levellingSpec,
    role: character.role,
    faction: character.faction,
    commitment: character.commitment,
    levelBucket: character.levelBucket,
    level: character.level ?? null,
    bnetLinked: Boolean(character.bnetId),
    raidReady: character.raidReady,
    updatedAt: character.updatedAt,
  };
}

async function loadGuild(env, guildId) {
  return kvGet(env, `guild:${guildId}`);
}
async function saveGuild(env, doc) {
  await kvPut(env, `guild:${doc.guild.id}`, doc);
}

function membershipOf(guildDoc, userId) {
  return (guildDoc?.members || []).find((m) => m.userId === userId) || null;
}
function isAdmin(guildDoc, userId) {
  const m = membershipOf(guildDoc, userId);
  return m ? m.role === "owner" || m.role === "admin" : false;
}

/**
 * Push a character's current state into its guild's snapshot, or remove it
 * if the character left, was deleted, or never belonged to one.
 */
async function syncCharacterSnapshot(env, userDoc, character, previousGuildId) {
  const targets = new Set();
  if (previousGuildId) targets.add(previousGuildId);
  if (character?.guildId) targets.add(character.guildId);

  for (const guildId of targets) {
    const guildDoc = await loadGuild(env, guildId);
    if (!guildDoc) continue;

    guildDoc.characters = (guildDoc.characters || []).filter((c) => c.id !== character.id);

    const belongs =
      character.guildId === guildId && !character.deletedAt;
    if (belongs) guildDoc.characters.push(snapshotOf(character, userDoc.user));

    await saveGuild(env, guildDoc);
  }
}

/** Mirror of the member list kept on the user, so /api/me is one read. */
function upsertMembership(userDoc, guildDoc, role) {
  userDoc.memberships = userDoc.memberships || [];
  const existing = userDoc.memberships.find((m) => m.guildId === guildDoc.guild.id);
  const entry = {
    guildId: guildDoc.guild.id,
    guildName: guildDoc.guild.name,
    faction: guildDoc.guild.faction,
    role,
    joinedAt: existing?.joinedAt || new Date().toISOString(),
  };
  if (existing) Object.assign(existing, entry);
  else userDoc.memberships.push(entry);
  return entry;
}

/**
 * Starting code of conduct. Deliberately bland and uncontroversial — it's a
 * sensible default that a guild edits into their own words, not a statement
 * of what any particular guild believes.
 */
const DEFAULT_CODE_OF_CONDUCT = `We raid to enjoy ourselves together.

Be on time and come prepared — consumables, repairs, and the right attunements.
If you can't make a raid you signed up for, tell an officer as early as you can.
Listen during encounters, keep criticism constructive, and treat everyone here
with respect.

Loot is decided by the raid leader. Decisions stand for that night and can be
discussed afterwards.`;

function validateGuild(input) {
  const errors = [];
  const v = {};

  v.name = String(input.name || "").trim().slice(0, 32);
  if (v.name.length < 2) errors.push("name");

  v.region = VALID.regions.includes(input.region) ? input.region : null;
  if (!v.region) errors.push("region");

  v.realmType = VALID.realmTypes.includes(input.realmType) ? input.realmType : null;
  if (!v.realmType) errors.push("realmType");

  v.faction = VALID.factions.includes(input.faction) ? input.faction : null;
  if (!v.faction) errors.push("faction");

  v.language = ["en", "tr"].includes(input.language) ? input.language : "en";
  v.serverTimezone = String(input.serverTimezone || "Europe/Paris").slice(0, 64);
  v.requiredLinks = Array.isArray(input.requiredLinks)
    ? input.requiredLinks.filter((x) => ["discord", "whatsapp", "app"].includes(x))
    : [];

  v.codeOfConduct =
    typeof input.codeOfConduct === "string" && input.codeOfConduct.trim()
      ? input.codeOfConduct.trim().slice(0, 4000)
      : DEFAULT_CODE_OF_CONDUCT;

  v.resets = validateResets(input.resets, input.dailyResetTime);

  return { ok: errors.length === 0, errors, value: v };
}

/* ------------------------------------------------------------------ *
 * Resets
 * ------------------------------------------------------------------ *
 *
 * Weekly, not daily. EU server reset has always been Wednesday, and raid
 * lockouts hang off their own schedules — Zul'Gurub's three-day lockout means
 * two resets a week, on different days from the 40-man.
 *
 * So this is a list the guild edits rather than one hardcoded time. Forever's
 * actual raid schedules are unknown, and inventing them would be worse than
 * leaving the admin to add each one as it becomes known.
 *
 * Colours are stored as keys rather than hex, so they resolve through CSS
 * variables and stay legible on all four themes.
 */

/** Shared colour vocabulary — resets and raids both draw from this. */
const PALETTE = ["red", "orange", "green", "blue", "purple", "teal"];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** One Wednesday server reset — the only thing we can reasonably assume. */
function defaultResets() {
  return [
    {
      id: uid("rs"),
      name: "Server reset",
      weekdays: [3],
      time: "07:00",
      colour: "red",
    },
  ];
}

function validateResets(input, legacyDailyTime) {
  if (!Array.isArray(input)) {
    // First run, or an older guild that only had a daily time. Carry the hour
    // across if there was one rather than silently changing it.
    const base = defaultResets();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(legacyDailyTime || "")) {
      base[0].time = legacyDailyTime;
    }
    return base;
  }

  return input
    .slice(0, 8)
    .map((r) => {
      const name = String(r?.name || "").trim().slice(0, 24);
      if (!name) return null;

      const weekdays = Array.isArray(r.weekdays)
        ? [...new Set(r.weekdays.map(Number).filter((d) => WEEKDAYS.includes(d)))].sort()
        : [];
      if (!weekdays.length) return null;

      return {
        id: String(r.id || uid("rs")).slice(0, 32),
        name,
        weekdays,
        time: /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || "") ? r.time : "07:00",
        colour: PALETTE.includes(r.colour) ? r.colour : "red",
      };
    })
    .filter(Boolean);
}

/** Editable guild settings. Owner or officer only. */
async function handleGuildUpdate(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  // Faction, region and realm type are deliberately immutable — characters
  // are already assigned on the strength of them.
  const { ok, errors, value } = validateGuild({ ...guildDoc.guild, ...body });
  if (!ok) return json({ error: "validation", fields: errors }, { status: 400 }, headers);

  guildDoc.guild.name = value.name;
  guildDoc.guild.language = value.language;
  guildDoc.guild.serverTimezone = value.serverTimezone;
  guildDoc.guild.requiredLinks = value.requiredLinks;
  guildDoc.guild.codeOfConduct = value.codeOfConduct;
  guildDoc.guild.resets = value.resets;
  guildDoc.guild.updatedAt = new Date().toISOString();

  // Name is mirrored onto every member's membership record.
  for (const member of guildDoc.members || []) {
    const userDoc = await loadUserDoc(env, member.userId);
    if (!userDoc) continue;
    const m = (userDoc.memberships || []).find((x) => x.guildId === guildId);
    if (m && m.guildName !== value.name) {
      m.guildName = value.name;
      await saveUserDoc(env, userDoc);
    }
  }

  await saveGuild(env, guildDoc);
  return json({ guild: guildDoc.guild }, {}, headers);
}

/* ------------------------------------------------------------------ *
 * Ideal composition
 * ------------------------------------------------------------------ *
 *
 * The target raid the guild is building toward. Admin-defined, no player
 * names in it — it says "we want three Protection Warriors", not who they are.
 *
 * Stored as a flat slot list plus a size. Parties are derived by slicing it
 * into fives, so a 40-man's first two parties ARE the 10-man comp. That's why
 * order matters and why moving a slot between parties is a reorder, not a
 * property change.
 */

const RAID_SIZES = [10, 20, 40];
const PARTY_SIZE = 5;

function validateComp(input) {
  const size = RAID_SIZES.includes(Number(input.size)) ? Number(input.size) : 40;

  const slots = (Array.isArray(input.slots) ? input.slots : [])
    .slice(0, size)
    .map((slot) => {
      if (!slot || typeof slot !== "object") return null;
      const specTable = VALID.specs[slot.class];
      if (!specTable || !specTable[slot.spec]) return null;
      return { class: slot.class, spec: slot.spec, role: specTable[slot.spec] };
    });

  // Pad to size with empties so the grid always has `size` cells.
  while (slots.length < size) slots.push(null);

  return { size, slots };
}

/**
 * Named composition library.
 *
 * Distinct from `idealComp`, which is the single target the progression board
 * measures against. These are saved templates — a raid leader picks one when
 * creating a raid, so the shape here is deliberately the same as a raid's
 * slot list. Each carries its own id so a composition can later be copied
 * between guilds without rewriting anything.
 */
async function handleCompositionSave(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const name = String(body.name || "").trim().slice(0, 40);
  if (name.length < 1) {
    return json({ error: "validation", fields: ["name"] }, { status: 400 }, headers);
  }

  const comp = validateComp(body);
  guildDoc.guild.compositions = guildDoc.guild.compositions || [];

  if (guildDoc.guild.compositions.length >= 20) {
    return json({ error: "too_many_compositions" }, { status: 400 }, headers);
  }

  // Saving under an existing name overwrites it — people expect that.
  const existing = guildDoc.guild.compositions.find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );

  const record = {
    id: existing?.id || uid("comp"),
    name,
    size: comp.size,
    slots: comp.slots,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: session.sub,
  };

  if (existing) Object.assign(existing, record);
  else guildDoc.guild.compositions.push(record);

  await saveGuild(env, guildDoc);
  return json({ compositions: guildDoc.guild.compositions }, {}, headers);
}

async function handleCompositionDelete(request, env, headers, guildId, compId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  guildDoc.guild.compositions = (guildDoc.guild.compositions || []).filter(
    (c) => c.id !== compId
  );
  await saveGuild(env, guildDoc);

  return json({ compositions: guildDoc.guild.compositions }, {}, headers);
}

async function handleCompUpdate(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  guildDoc.guild.idealComp = validateComp(body);
  guildDoc.guild.updatedAt = new Date().toISOString();
  await saveGuild(env, guildDoc);

  return json({ idealComp: guildDoc.guild.idealComp }, {}, headers);
}

async function handleGuildCreate(request, env, headers) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const userDoc = await loadUserDoc(env, session.sub);
  if (!userDoc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const { ok, errors, value } = validateGuild(body);
  if (!ok) return json({ error: "validation", fields: errors }, { status: 400 }, headers);

  const now = new Date().toISOString();
  const guildDoc = {
    guild: {
      id: uid("g"),
      ...value,
      themePalette: value.faction.toLowerCase(),
      createdAt: now,
      ownerId: userDoc.user.id,
    },
    members: [
      {
        userId: userDoc.user.id,
        displayName: userDoc.user.displayName,
        role: "owner",
        joinedAt: now,
      },
    ],
    characters: [],
  };

  await saveGuild(env, guildDoc);
  upsertMembership(userDoc, guildDoc, "owner");
  await saveUserDoc(env, userDoc);

  return json({ guild: guildDoc.guild, memberships: userDoc.memberships }, { status: 201 }, headers);
}

async function handleGuildGet(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!membershipOf(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  // Guilds made before resets existed get the default on first read.
  if (!Array.isArray(guildDoc.guild.resets)) {
    guildDoc.guild.resets = validateResets(null, guildDoc.guild.dailyResetTime);
    await saveGuild(env, guildDoc);
  }

  return json(
    {
      guild: guildDoc.guild,
      members: guildDoc.members,
      characters: guildDoc.characters || [],
      role: membershipOf(guildDoc, session.sub).role,
    },
    {},
    headers
  );
}

async function handleInviteCreate(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  const code = inviteCode();
  const invite = {
    code,
    guildId,
    createdBy: session.sub,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    revoked: false,
    usedCount: 0,
  };

  await kvPut(env, `invite:${code}`, invite);
  guildDoc.invites = [...(guildDoc.invites || []), code];
  await saveGuild(env, guildDoc);

  return json({ invite }, { status: 201 }, headers);
}

/** Preview before joining, so people see what they're walking into. */
async function handleInvitePreview(request, env, headers, code) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const invite = await kvGet(env, `invite:${code}`);
  if (!invite || invite.revoked) {
    return json({ error: "invite_invalid" }, { status: 404 }, headers);
  }
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return json({ error: "invite_expired" }, { status: 410 }, headers);
  }

  const guildDoc = await loadGuild(env, invite.guildId);
  if (!guildDoc) return json({ error: "invite_invalid" }, { status: 404 }, headers);

  return json(
    {
      guild: {
        id: guildDoc.guild.id,
        name: guildDoc.guild.name,
        faction: guildDoc.guild.faction,
        region: guildDoc.guild.region,
        realmType: guildDoc.guild.realmType,
        codeOfConduct: guildDoc.guild.codeOfConduct || DEFAULT_CODE_OF_CONDUCT,
      },
      memberCount: (guildDoc.members || []).length,
      alreadyMember: Boolean(membershipOf(guildDoc, session.sub)),
    },
    {},
    headers
  );
}

async function handleInviteAccept(request, env, headers, code) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const invite = await kvGet(env, `invite:${code}`);
  if (!invite || invite.revoked) {
    return json({ error: "invite_invalid" }, { status: 404 }, headers);
  }
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return json({ error: "invite_expired" }, { status: 410 }, headers);
  }

  const guildDoc = await loadGuild(env, invite.guildId);
  if (!guildDoc) return json({ error: "invite_invalid" }, { status: 404 }, headers);

  const userDoc = await loadUserDoc(env, session.sub);
  if (!userDoc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* joining without bringing characters is fine */
  }
  const chosen = Array.isArray(body.characterIds) ? body.characterIds : [];

  // Join, unless already a member — then this is just adding characters.
  if (!membershipOf(guildDoc, session.sub)) {
    // Acknowledging the code of conduct is required to join, and recorded
    // with a timestamp so there's an answer to "they never agreed to that".
    if (!body.acceptedConduct) {
      return json({ error: "conduct_required" }, { status: 400 }, headers);
    }
    guildDoc.members.push({
      userId: userDoc.user.id,
      displayName: userDoc.user.displayName,
      role: "member",
      joinedAt: new Date().toISOString(),
      acceptedConductAt: new Date().toISOString(),
    });
    invite.usedCount = (invite.usedCount || 0) + 1;
    await kvPut(env, `invite:${code}`, invite);
  }

  // Assign the selected characters, refusing any whose faction doesn't match.
  const rejected = [];
  for (const id of chosen) {
    const character = (userDoc.characters || []).find((c) => c.id === id && !c.deletedAt);
    if (!character) continue;
    if (character.faction !== guildDoc.guild.faction) {
      rejected.push({ id, name: character.name, reason: "faction" });
      continue;
    }
    character.guildId = guildDoc.guild.id;
    character.updatedAt = new Date().toISOString();
    guildDoc.characters = (guildDoc.characters || []).filter((c) => c.id !== character.id);
    guildDoc.characters.push(snapshotOf(character, userDoc.user));
  }

  const membership = upsertMembership(
    userDoc,
    guildDoc,
    membershipOf(guildDoc, session.sub).role
  );

  await saveGuild(env, guildDoc);
  await saveUserDoc(env, userDoc);

  return json(
    {
      guild: guildDoc.guild,
      membership,
      memberships: userDoc.memberships,
      characters: userDoc.characters,
      rejected,
    },
    {},
    headers
  );
}

/** Move a character into or out of a guild the user already belongs to. */
async function handleCharacterGuild(request, env, headers, characterId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const userDoc = await loadUserDoc(env, session.sub);
  if (!userDoc) return json({ error: "user_not_found" }, { status: 404 }, headers);

  const character = (userDoc.characters || []).find(
    (c) => c.id === characterId && !c.deletedAt
  );
  if (!character) return json({ error: "not_found" }, { status: 404 }, headers);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const previousGuildId = character.guildId || null;
  const targetGuildId = body.guildId || null;

  if (targetGuildId) {
    const guildDoc = await loadGuild(env, targetGuildId);
    if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
    if (!membershipOf(guildDoc, session.sub)) {
      return json({ error: "forbidden" }, { status: 403 }, headers);
    }
    if (character.faction !== guildDoc.guild.faction) {
      return json({ error: "faction_mismatch" }, { status: 400 }, headers);
    }
  }

  character.guildId = targetGuildId;
  character.updatedAt = new Date().toISOString();
  await saveUserDoc(env, userDoc);
  await syncCharacterSnapshot(env, userDoc, character, previousGuildId);

  return json({ character, characters: userDoc.characters }, {}, headers);
}

/* ------------------------------------------------------------------ *
 * Raids
 * ------------------------------------------------------------------ *
 *
 * Storage:
 *   raid:<raidId>              { raid, signups[] }
 *   guild:<guildId>:raidIndex  [ { id, startsAt, title, status, size, filled } ]
 *
 * One document per raid rather than a list on the guild, because forty people
 * signing up in the ten minutes after an announcement would otherwise be forty
 * writes to the same document, and last-write-wins would quietly lose most of
 * them. The index exists so the calendar can draw a month without loading
 * every raid in it.
 *
 * Times are stored as UTC instants, always. Admins enter server time, members
 * read local time, and both are derived at the edges. Storing wall-clock
 * strings would drift by an hour twice a year, when EU daylight saving moves
 * and Turkey's doesn't.
 */

const RAID_STATUSES = ["draft", "open", "locked", "completed", "cancelled"];

async function loadRaid(env, raidId) {
  return kvGet(env, `raid:${raidId}`);
}
async function saveRaid(env, doc) {
  await kvPut(env, `raid:${doc.raid.id}`, doc);
}

async function loadRaidIndex(env, guildId) {
  return (await kvGet(env, `guild:${guildId}:raidIndex`)) || [];
}
async function saveRaidIndex(env, guildId, index) {
  // Chronological, so the calendar never sorts a month it has just loaded.
  index.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  await kvPut(env, `guild:${guildId}:raidIndex`, index);
}

/** The index row is what the calendar draws; keep it in step with the raid. */
function indexEntry(raid, signups) {
  return {
    id: raid.id,
    guildId: raid.guildId,
    title: raid.title,
    startsAt: raid.startsAt,
    status: raid.status,
    colour: raid.colour || "blue",
    size: raid.slots.length,
    filled: raid.slots.filter((s) => s.characterId).length,
    pending: (signups || []).filter((s) => s.status === "pending").length,
  };
}

async function syncRaidIndex(env, raid, signups, { remove = false } = {}) {
  const index = await loadRaidIndex(env, raid.guildId);
  const next = index.filter((entry) => entry.id !== raid.id);
  if (!remove) next.push(indexEntry(raid, signups));
  await saveRaidIndex(env, raid.guildId, next);
}

/**
 * Build a raid's slots from a saved composition, or an empty grid if none.
 * The composition is snapshotted — editing the saved one later must never
 * reshuffle a raid people have already been accepted into.
 */
function slotsFromComposition(composition, size) {
  const target = composition?.slots?.length ? composition.slots : Array(size).fill(null);
  return target.map((slot, index) => ({
    index,
    partyIndex: Math.floor(index / PARTY_SIZE),
    class: slot?.class || null,
    spec: slot?.spec || null,
    role: slot?.role || null,
    characterId: null,
    note: "",
  }));
}

function validateRaidInput(input, guildDoc) {
  const errors = [];
  const v = {};

  v.title = String(input.title || "").trim().slice(0, 60);
  if (v.title.length < 2) errors.push("title");

  if (input.startsAt) {
    const d = new Date(input.startsAt);
    v.startsAt = Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (!v.startsAt) errors.push("startsAt");

  v.status = RAID_STATUSES.includes(input.status) ? input.status : "open";
  v.notes = String(input.notes || "").trim().slice(0, 500);

  // Lets a month of raids be told apart at a glance. Same palette as resets,
  // so the app has one colour vocabulary rather than two.
  v.colour = PALETTE.includes(input.colour) ? input.colour : "blue";

  const size = RAID_SIZES.includes(Number(input.size)) ? Number(input.size) : 40;
  const composition = (guildDoc.guild.compositions || []).find(
    (c) => c.id === input.compositionId
  );

  v.compositionId = composition?.id || null;
  v.compositionName = composition?.name || null;
  v.size = composition?.size || size;
  v.slots = slotsFromComposition(composition, v.size);

  return { ok: errors.length === 0, errors, value: v };
}

async function handleRaidList(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  const membership = membershipOf(guildDoc, session.sub);
  if (!membership) return json({ error: "forbidden" }, { status: 403 }, headers);

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let raids = await loadRaidIndex(env, guildId);
  if (from) raids = raids.filter((r) => r.startsAt >= from);
  if (to) raids = raids.filter((r) => r.startsAt <= to);

  // Members never see drafts — a half-built raid isn't news yet.
  if (!isAdmin(guildDoc, session.sub)) {
    raids = raids.filter((r) => r.status !== "draft");
  }

  return json({ raids, role: membership.role }, {}, headers);
}

async function handleRaidCreate(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const { ok, errors, value } = validateRaidInput(body, guildDoc);
  if (!ok) return json({ error: "validation", fields: errors }, { status: 400 }, headers);

  const now = new Date().toISOString();
  const raid = {
    id: uid("r"),
    guildId,
    ...value,
    leaderId: session.sub,
    leaderName: membershipOf(guildDoc, session.sub).displayName,
    createdAt: now,
    updatedAt: now,
  };

  await saveRaid(env, { raid, signups: [] });
  await syncRaidIndex(env, raid, []);

  return json({ raid }, { status: 201 }, headers);
}

/**
 * Create several raids at once from a weekday pattern.
 *
 * The client works out which dates it wants and sends them explicitly, rather
 * than sending a rule for the server to expand. That keeps the "which Mondays
 * are left this month" arithmetic — and the timezone reasoning under it — in
 * one place, and means the preview the admin ticked is exactly what gets made.
 */
async function handleRaidBulkCreate(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const instants = Array.isArray(body.startsAt) ? body.startsAt.slice(0, 31) : [];
  if (!instants.length) {
    return json({ error: "validation", fields: ["startsAt"] }, { status: 400 }, headers);
  }

  const index = await loadRaidIndex(env, guildId);
  const created = [];
  const now = new Date().toISOString();
  const membership = membershipOf(guildDoc, session.sub);

  for (const startsAt of instants) {
    const { ok, value } = validateRaidInput({ ...body, startsAt }, guildDoc);
    if (!ok) continue;

    const raid = {
      id: uid("r"),
      guildId,
      ...value,
      leaderId: session.sub,
      leaderName: membership.displayName,
      createdAt: now,
      updatedAt: now,
    };

    await saveRaid(env, { raid, signups: [] });
    index.push(indexEntry(raid, []));
    created.push(raid);
  }

  // One index write for the whole batch rather than one per raid.
  await saveRaidIndex(env, guildId, index);

  return json({ created: created.length, raids: created }, { status: 201 }, headers);
}

/**
 * Sign up for several raids in one go.
 *
 * Partial success is normal and fine — a raid that closed while the member was
 * choosing shouldn't sink the rest. Each result is reported back so the UI can
 * say what actually happened.
 */
async function handleSignupBulk(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc || !membershipOf(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const character = (guildDoc.characters || []).find(
    (c) => c.id === body.characterId && c.userId === session.sub
  );
  if (!character) return json({ error: "character_not_found" }, { status: 400 }, headers);

  const raidIds = Array.isArray(body.raidIds) ? body.raidIds.slice(0, 31) : [];
  const note = String(body.note || "").trim().slice(0, 140);
  const now = new Date().toISOString();

  let added = 0;
  const skipped = [];

  for (const raidId of raidIds) {
    const doc = await loadRaid(env, raidId);
    if (!doc || doc.raid.guildId !== guildId) continue;
    if (doc.raid.status !== "open") {
      skipped.push({ raidId, reason: "closed" });
      continue;
    }

    doc.signups = doc.signups || [];
    const existing = doc.signups.find(
      (s) => s.userId === session.sub && !["declined", "cancelled"].includes(s.status)
    );

    // Never disturb a signup they've already been accepted into.
    if (existing?.status === "accepted") {
      skipped.push({ raidId, reason: "already_accepted" });
      continue;
    }

    if (existing) {
      existing.characterId = character.id;
      existing.status = "pending";
      existing.source = "recurring";
      existing.requestedAt = now;
      if (note) existing.note = note;
    } else {
      doc.signups.push({
        id: uid("s"),
        raidId,
        userId: session.sub,
        characterId: character.id,
        status: "pending",
        note,
        source: "recurring",
        cancelReason: null,
        requestedAt: now,
        resolvedAt: null,
        resolvedBy: null,
      });
    }

    await saveRaid(env, doc);
    await syncRaidIndex(env, doc.raid, doc.signups);
    added++;
  }

  return json({ added, skipped }, {}, headers);
}

async function handleRaidGet(request, env, headers, raidId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadRaid(env, raidId);
  if (!doc) return json({ error: "not_found" }, { status: 404 }, headers);

  const guildDoc = await loadGuild(env, doc.raid.guildId);
  const membership = guildDoc && membershipOf(guildDoc, session.sub);
  if (!membership) return json({ error: "forbidden" }, { status: 403 }, headers);

  return json(
    {
      raid: doc.raid,
      signups: doc.signups || [],
      role: membership.role,
      // The roster snapshot resolves slotted character ids to names and specs.
      characters: guildDoc.characters || [],
      guild: {
        name: guildDoc.guild.name,
        serverTimezone: guildDoc.guild.serverTimezone,
        resets: guildDoc.guild.resets,
      },
    },
    {},
    headers
  );
}

async function handleRaidUpdate(request, env, headers, raidId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadRaid(env, raidId);
  if (!doc) return json({ error: "not_found" }, { status: 404 }, headers);

  const guildDoc = await loadGuild(env, doc.raid.guildId);
  if (!guildDoc || !isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  if (body.title !== undefined) doc.raid.title = String(body.title).trim().slice(0, 60);
  if (body.notes !== undefined) doc.raid.notes = String(body.notes).trim().slice(0, 500);
  if (body.status !== undefined && RAID_STATUSES.includes(body.status)) {
    doc.raid.status = body.status;
  }
  if (body.colour !== undefined && PALETTE.includes(body.colour)) {
    doc.raid.colour = body.colour;
  }
  if (body.startsAt !== undefined) {
    const d = new Date(body.startsAt);
    if (!Number.isNaN(d.getTime())) doc.raid.startsAt = d.toISOString();
  }

  // Direct slot assignment, for officers filling seats without waiting for
  // a signup. Clearing a slot is setting characterId to null.
  if (Array.isArray(body.slots)) {
    for (const incoming of body.slots) {
      const slot = doc.raid.slots[incoming.index];
      if (!slot) continue;
      slot.characterId = incoming.characterId || null;
      if (incoming.note !== undefined) slot.note = String(incoming.note).slice(0, 120);
    }
  }

  doc.raid.updatedAt = new Date().toISOString();
  await saveRaid(env, doc);
  await syncRaidIndex(env, doc.raid, doc.signups);

  return json({ raid: doc.raid, signups: doc.signups }, {}, headers);
}

async function handleRaidCancel(request, env, headers, raidId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadRaid(env, raidId);
  if (!doc) return json({ error: "not_found" }, { status: 404 }, headers);

  const guildDoc = await loadGuild(env, doc.raid.guildId);
  if (!guildDoc || !isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  // Cancelling keeps the record. People need to see it was called off, and
  // the signups are the evidence of who had committed.
  doc.raid.status = "cancelled";
  doc.raid.updatedAt = new Date().toISOString();
  await saveRaid(env, doc);
  await syncRaidIndex(env, doc.raid, doc.signups);

  return json({ raid: doc.raid }, {}, headers);
}

/* ------------------------------------------------------------------ *
 * Signups
 * ------------------------------------------------------------------ *
 *
 * The rule that shapes everything here: one person, one raid per day. You
 * can offer yourself to as many raids as you like, but the moment an officer
 * accepts you into one, your pending offers for that same date are cancelled.
 * Nobody is in two places at once, and nobody has to remember to withdraw.
 */

/** The calendar day a raid falls on, in the guild's server timezone. */
function raidDayKey(startsAt, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(startsAt));
  } catch {
    return String(startsAt).slice(0, 10);
  }
}

async function handleSignupCreate(request, env, headers, raidId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadRaid(env, raidId);
  if (!doc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!["open", "draft"].includes(doc.raid.status)) {
    return json({ error: "raid_closed" }, { status: 400 }, headers);
  }

  const guildDoc = await loadGuild(env, doc.raid.guildId);
  if (!guildDoc || !membershipOf(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 }, headers);
  }

  const character = (guildDoc.characters || []).find(
    (c) => c.id === body.characterId && c.userId === session.sub
  );
  if (!character) return json({ error: "character_not_found" }, { status: 400 }, headers);

  doc.signups = doc.signups || [];

  // Replace any previous offer from this person rather than stacking them.
  const existing = doc.signups.find(
    (s) => s.userId === session.sub && !["declined", "cancelled"].includes(s.status)
  );
  const now = new Date().toISOString();

  if (existing) {
    existing.characterId = character.id;
    existing.note = String(body.note || "").trim().slice(0, 140);
    existing.status = "pending";
    existing.requestedAt = now;
  } else {
    doc.signups.push({
      id: uid("s"),
      raidId,
      userId: session.sub,
      characterId: character.id,
      status: "pending",
      note: String(body.note || "").trim().slice(0, 140),
      source: body.source === "recurring" ? "recurring" : "single",
      cancelReason: null,
      requestedAt: now,
      resolvedAt: null,
      resolvedBy: null,
    });
  }

  await saveRaid(env, doc);
  await syncRaidIndex(env, doc.raid, doc.signups);

  return json({ signups: doc.signups }, { status: 201 }, headers);
}

async function handleSignupWithdraw(request, env, headers, raidId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadRaid(env, raidId);
  if (!doc) return json({ error: "not_found" }, { status: 404 }, headers);

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* withdrawing before acceptance needs no reason */
  }

  const signup = (doc.signups || []).find(
    (s) => s.userId === session.sub && !["declined", "cancelled", "withdrawn"].includes(s.status)
  );
  if (!signup) return json({ error: "not_found" }, { status: 404 }, headers);

  // Backing out after being accepted leaves a hole in the roster, so it
  // requires a reason. Withdrawing a pending offer costs nobody anything.
  const reason = String(body.reason || "").trim().slice(0, 200);
  if (signup.status === "accepted" && !reason) {
    return json({ error: "reason_required" }, { status: 400 }, headers);
  }

  signup.status = "withdrawn";
  signup.cancelReason = reason || null;
  signup.resolvedAt = new Date().toISOString();

  // Free whatever seat they held.
  for (const slot of doc.raid.slots) {
    if (slot.characterId === signup.characterId) slot.characterId = null;
  }

  await saveRaid(env, doc);
  await syncRaidIndex(env, doc.raid, doc.signups);

  return json({ raid: doc.raid, signups: doc.signups }, {}, headers);
}

/**
 * Accept someone into the raid.
 *
 * Drops them into the first empty slot matching their role, then cancels
 * their pending offers on every other raid that same day.
 */
async function handleSignupAccept(request, env, headers, raidId, signupId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadRaid(env, raidId);
  if (!doc) return json({ error: "not_found" }, { status: 404 }, headers);

  const guildDoc = await loadGuild(env, doc.raid.guildId);
  if (!guildDoc || !isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  const signup = (doc.signups || []).find((s) => s.id === signupId);
  if (!signup) return json({ error: "not_found" }, { status: 404 }, headers);

  const character = (guildDoc.characters || []).find((c) => c.id === signup.characterId);
  if (!character) return json({ error: "character_not_found" }, { status: 400 }, headers);

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* slot choice is optional */
  }

  // Prefer the slot the officer picked; otherwise the first empty seat whose
  // role matches, falling back to any empty seat at all.
  let slot = null;
  if (Number.isInteger(body.slotIndex)) {
    const candidate = doc.raid.slots[body.slotIndex];
    if (candidate && !candidate.characterId) slot = candidate;
  }
  if (!slot) {
    slot =
      doc.raid.slots.find((s) => !s.characterId && s.role === character.role) ||
      doc.raid.slots.find((s) => !s.characterId) ||
      null;
  }
  if (!slot) return json({ error: "raid_full" }, { status: 400 }, headers);

  slot.characterId = character.id;
  signup.status = "accepted";
  signup.resolvedAt = new Date().toISOString();
  signup.resolvedBy = session.sub;

  await saveRaid(env, doc);
  await syncRaidIndex(env, doc.raid, doc.signups);

  // One person, one raid per day.
  const cancelled = await cancelSameDayOffers(env, guildDoc, doc.raid, signup.userId);

  return json(
    { raid: doc.raid, signups: doc.signups, slotIndex: slot.index, cancelledElsewhere: cancelled },
    {},
    headers
  );
}

/**
 * Cancel this person's pending offers on other raids sharing a date.
 * Returns the raid titles affected, so the officer can see what happened.
 */
async function cancelSameDayOffers(env, guildDoc, acceptedRaid, userId) {
  const zone = guildDoc.guild.serverTimezone;
  const day = raidDayKey(acceptedRaid.startsAt, zone);
  const index = await loadRaidIndex(env, acceptedRaid.guildId);
  const cancelled = [];

  for (const entry of index) {
    if (entry.id === acceptedRaid.id) continue;
    if (raidDayKey(entry.startsAt, zone) !== day) continue;
    if (["cancelled", "completed"].includes(entry.status)) continue;

    const other = await loadRaid(env, entry.id);
    if (!other) continue;

    let touched = false;
    for (const s of other.signups || []) {
      if (s.userId !== userId || s.status !== "pending") continue;
      s.status = "cancelled";
      s.cancelReason = "accepted_elsewhere";
      s.resolvedAt = new Date().toISOString();
      touched = true;
    }

    if (touched) {
      await saveRaid(env, other);
      await syncRaidIndex(env, other.raid, other.signups);
      cancelled.push(other.raid.title);
    }
  }

  return cancelled;
}

async function handleSignupDecline(request, env, headers, raidId, signupId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const doc = await loadRaid(env, raidId);
  if (!doc) return json({ error: "not_found" }, { status: 404 }, headers);

  const guildDoc = await loadGuild(env, doc.raid.guildId);
  if (!guildDoc || !isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  const signup = (doc.signups || []).find((s) => s.id === signupId);
  if (!signup) return json({ error: "not_found" }, { status: 404 }, headers);

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* a reason is welcome but not demanded */
  }

  // Free the seat if they were previously accepted and are now being dropped.
  for (const slot of doc.raid.slots) {
    if (slot.characterId === signup.characterId) slot.characterId = null;
  }

  signup.status = "declined";
  signup.cancelReason = String(body.reason || "").trim().slice(0, 200) || null;
  signup.resolvedAt = new Date().toISOString();
  signup.resolvedBy = session.sub;

  await saveRaid(env, doc);
  await syncRaidIndex(env, doc.raid, doc.signups);

  return json({ raid: doc.raid, signups: doc.signups }, {}, headers);
}

/* ------------------------------------------------------------------ *
 * Seed data (testing only)
 * ------------------------------------------------------------------ *
 *
 * Generates fake characters directly into a guild's snapshot. They are NOT
 * attached to real user documents — nobody owns them, they never appear in
 * anyone's /me/characters, and purging is a one-line filter.
 *
 * The distribution is deliberately lopsided: too many DPS, not enough tanks.
 * That's the real situation every guild faces, and it's exactly what the
 * progression board exists to make visible. Seeding an even spread would
 * make the board look like it works when it doesn't.
 */

const SEED_NAMES = [
  "Kaanmar", "Belgarion", "Thrandir", "Yağmur", "Mordecai", "Selenya",
  "Boratan", "Khazgore", "Ilkay", "Vaelthorn", "Deniz", "Grimtusk",
  "Aslanbey", "Morwenna", "Tarkan", "Ysolde", "Bozkurt", "Nihal",
  "Draveth", "Efeon", "Sylvara", "Korkut", "Malakai", "Pınar",
  "Varkan", "Ceyda", "Rhogar", "Toprak", "Elenwe", "Barbaros",
  "Zephyrine", "Alperen", "Nightsong", "Gizem", "Dreadmaul", "Yalın",
  "Faelivrin", "Orkhan", "Silmaria", "Kerem", "Thorvald", "Buse",
  "Ravenhold", "Emirhan", "Lirael", "Doruk", "Ashenvale", "Nergis",
  "Grimward", "Sarp",
];

/**
 * Surnames for the seeded roster.
 *
 * Deliberately short and with some repeats, because families sharing a name
 * is one of the things Forever is selling — and because a roster where every
 * surname is unique never exercises the name-collision display rules.
 */
const SEED_SURNAMES = [
  "Stormcaller", "Ironbark", "Yıldırım", "Ashvale", "Demirci", "Nightwhisper",
  "Karaca", "Emberfall", "Brightblade", "Öztürk", "Frostmane", "Duskwind",
  "Kayalı", "Ravenwood", "Stonefist", "Akgül", "Thornheart", "Wildmane",
  "Sancak", "Grimhollow",
];

/** [class, spec, weight] — weight biases the draw toward realistic scarcity. */
const SEED_POOL = [
  // Tanks — always short. Nobody wants to tank.
  ["Warrior", "Protection", 3],
  ["Paladin", "Protection", 2],
  ["Druid", "Feral Tank", 2],

  // Healers — moderate.
  ["Priest", "Holy", 4],
  ["Priest", "Discipline", 2],
  ["Druid", "Restoration", 3],
  ["Shaman", "Restoration", 3],
  ["Paladin", "Holy", 3],

  // DPS — everyone rolls DPS.
  ["Mage", "Frost", 5],
  ["Mage", "Fire", 4],
  ["Warlock", "Affliction", 4],
  ["Warlock", "Destruction", 3],
  ["Hunter", "Beast Mastery", 5],
  ["Hunter", "Marksmanship", 3],
  ["Rogue", "Combat", 5],
  ["Rogue", "Assassination", 3],
  ["Warrior", "Arms", 4],
  ["Warrior", "Fury", 4],
  ["Shaman", "Enhancement", 3],
  ["Shaman", "Elemental", 3],
  ["Druid", "Balance", 3],
  ["Priest", "Shadow", 3],
  ["Mage", "Arcane", 2],
];

/**
 * Two distributions, because the boards need opposite things.
 *
 * `levelling` is weighted low — right for judging the roster board, where the
 * question is who's on their way. `raidReady` is everyone at 60, which is what
 * the calendar needs: a roster board full of level-23s can't test signups.
 */
const SEED_LEVELS = {
  levelling: [
    ["1-19", 5], ["20-39", 7], ["40-55", 6],
    ["56", 2], ["57", 2], ["58", 2], ["59", 2], ["60", 3],
  ],
  raidReady: [["59", 1], ["60", 12]],
};

function weightedPick(table, rand) {
  const total = table.reduce((sum, row) => sum + row[row.length - 1], 0);
  let n = rand() * total;
  for (const row of table) {
    n -= row[row.length - 1];
    if (n <= 0) return row;
  }
  return table[table.length - 1];
}

/** Deterministic PRNG so repeated seeds of the same size look the same. */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function generateSeedCharacters(count, faction, rand, mode = "levelling") {
  const racesByClass = {};
  for (const [race, entry] of Object.entries(VALID.raceClasses)) {
    const classes = Array.isArray(entry) ? entry : entry[faction] || [];
    const factionRaces = VALID.races[faction] || [];
    if (!factionRaces.includes(race)) continue;
    for (const cls of classes) {
      (racesByClass[cls] = racesByClass[cls] || []).push(race);
    }
  }

  const out = [];
  const names = [...SEED_NAMES];
  let owners = 0;

  for (let i = 0; i < count; i++) {
    const [cls, spec] = weightedPick(SEED_POOL, rand);
    const races = racesByClass[cls];
    if (!races || !races.length) continue;

    const nameIndex = Math.floor(rand() * names.length);
    const firstName = names.splice(nameIndex, 1)[0] || `Filler${i}`;

    // Roughly one in five is an alt of someone already in the list.
    const isAlt = out.length > 4 && rand() < 0.2;
    const sibling = isAlt ? out[Math.floor(rand() * out.length)] : null;
    const ownerName = sibling ? sibling.ownerName : `Player${++owners}`;

    // Alts inherit the family name, which is how people will actually use it.
    const lastName = sibling
      ? sibling.lastName
      : SEED_SURNAMES[Math.floor(rand() * SEED_SURNAMES.length)];

    const specTable = VALID.specs[cls];
    const otherSpecs = Object.keys(specTable).filter((s) => s !== spec);
    const [levelBucket] = weightedPick(SEED_LEVELS[mode] || SEED_LEVELS.levelling, rand);

    out.push({
      id: `c_seed_${i.toString(36)}${Math.floor(rand() * 1e6).toString(36)}`,
      userId: `u_seed_${ownerName}`,
      ownerName,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      race: races[Math.floor(rand() * races.length)],
      class: cls,
      spec,
      offSpec: rand() < 0.45 ? otherSpecs[Math.floor(rand() * otherSpecs.length)] : null,
      levellingSpec: rand() < 0.3 ? otherSpecs[Math.floor(rand() * otherSpecs.length)] : spec,
      role: specTable[spec],
      faction,
      commitment: isAlt ? "alt" : rand() < 0.1 ? "secondary" : "primary",
      levelBucket,
      // In raid-ready mode almost everyone is cleared; a couple aren't, so
      // the "not yet raid ready" path still has something to show.
      raidReady:
        mode === "raidReady"
          ? levelBucket === "60" && rand() < 0.92
          : levelBucket === "60" && rand() < 0.7,
      updatedAt: new Date().toISOString(),
      seeded: true,
    });
  }

  return out;
}

async function handleGuildSeed(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* defaults are fine */
  }
  const count = Math.min(Math.max(Number(body.count) || 45, 1), 80);
  const mode = body.mode === "raidReady" ? "raidReady" : "levelling";

  // Replace any previous seed rather than stacking them.
  const real = (guildDoc.characters || []).filter((c) => !c.seeded);
  const fake = generateSeedCharacters(
    count,
    guildDoc.guild.faction,
    seededRandom(count * 7919 + (mode === "raidReady" ? 31 : 0)),
    mode
  );

  guildDoc.characters = [...real, ...fake];
  await saveGuild(env, guildDoc);

  return json({ added: fake.length, characters: guildDoc.characters }, {}, headers);
}

async function handleGuildUnseed(request, env, headers, guildId) {
  const { session, error } = await requireSession(request, env, headers);
  if (error) return error;

  const guildDoc = await loadGuild(env, guildId);
  if (!guildDoc) return json({ error: "not_found" }, { status: 404 }, headers);
  if (!isAdmin(guildDoc, session.sub)) {
    return json({ error: "forbidden" }, { status: 403 }, headers);
  }

  const before = (guildDoc.characters || []).length;
  guildDoc.characters = (guildDoc.characters || []).filter((c) => !c.seeded);
  await saveGuild(env, guildDoc);

  return json(
    { removed: before - guildDoc.characters.length, characters: guildDoc.characters },
    {},
    headers
  );
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const headers = cors(env, request);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      if (path === "/api/health") {
        return json({ ok: true, app: "Nostalgia Forever" }, {}, headers);
      }
      if (path === "/api/auth/google/login" && method === "GET") {
        return handleLogin(request, env, headers);
      }
      if (path === "/api/auth/google/callback" && method === "GET") {
        return handleCallback(request, env, headers);
      }
      if (path === "/api/auth/logout" && method === "POST") {
        return handleLogout(request, env, headers);
      }

      /* Account linking ---------------------------------------------- */

      const linkStart = path.match(/^\/api\/auth\/(discord|battlenet)\/link$/);
      if (linkStart && method === "GET") {
        return handleLinkStart(request, env, headers, linkStart[1]);
      }

      const linkBack = path.match(/^\/api\/auth\/(discord|battlenet)\/callback$/);
      if (linkBack && method === "GET") {
        return handleLinkCallback(request, env, headers, linkBack[1]);
      }

      const unlink = path.match(/^\/api\/auth\/(discord|battlenet)\/link$/);
      if (unlink && method === "DELETE") {
        return handleUnlink(request, env, headers, unlink[1]);
      }
      if (path === "/api/me" && method === "GET") {
        return handleMe(request, env, headers);
      }
      if (path === "/api/me/profile" && method === "PUT") {
        return handleProfileUpdate(request, env, headers);
      }
      if (path === "/api/me/characters/import" && method === "POST") {
        return handleCharacterImport(request, env, headers);
      }
      if (path === "/api/me/characters" && method === "POST") {
        return handleCharacterCreate(request, env, headers);
      }

      const charMatch = path.match(/^\/api\/me\/characters\/([\w-]+)$/);
      if (charMatch && method === "PUT") {
        return handleCharacterUpdate(request, env, headers, charMatch[1]);
      }
      if (charMatch && method === "DELETE") {
        return handleCharacterDelete(request, env, headers, charMatch[1]);
      }

      const restoreMatch = path.match(/^\/api\/me\/characters\/([\w-]+)\/restore$/);
      if (restoreMatch && method === "POST") {
        return handleCharacterRestore(request, env, headers, restoreMatch[1]);
      }

      const charGuildMatch = path.match(/^\/api\/me\/characters\/([\w-]+)\/guild$/);
      if (charGuildMatch && method === "PUT") {
        return handleCharacterGuild(request, env, headers, charGuildMatch[1]);
      }

      /* Guilds ------------------------------------------------------- */

      if (path === "/api/guilds" && method === "POST") {
        return handleGuildCreate(request, env, headers);
      }

      const guildMatch = path.match(/^\/api\/guilds\/([\w-]+)$/);
      if (guildMatch && method === "GET") {
        return handleGuildGet(request, env, headers, guildMatch[1]);
      }
      if (guildMatch && method === "PUT") {
        return handleGuildUpdate(request, env, headers, guildMatch[1]);
      }

      const guildInviteMatch = path.match(/^\/api\/guilds\/([\w-]+)\/invites$/);
      if (guildInviteMatch && method === "POST") {
        return handleInviteCreate(request, env, headers, guildInviteMatch[1]);
      }

      const inviteMatch = path.match(/^\/api\/invites\/([\w-]+)$/);
      if (inviteMatch && method === "GET") {
        return handleInvitePreview(request, env, headers, inviteMatch[1]);
      }

      const acceptMatch = path.match(/^\/api\/invites\/([\w-]+)\/accept$/);
      if (acceptMatch && method === "POST") {
        return handleInviteAccept(request, env, headers, acceptMatch[1]);
      }

      const compMatch = path.match(/^\/api\/guilds\/([\w-]+)\/comp$/);
      if (compMatch && method === "PUT") {
        return handleCompUpdate(request, env, headers, compMatch[1]);
      }

      const compsMatch = path.match(/^\/api\/guilds\/([\w-]+)\/compositions$/);
      if (compsMatch && method === "POST") {
        return handleCompositionSave(request, env, headers, compsMatch[1]);
      }

      const compDelMatch = path.match(/^\/api\/guilds\/([\w-]+)\/compositions\/([\w-]+)$/);
      if (compDelMatch && method === "DELETE") {
        return handleCompositionDelete(request, env, headers, compDelMatch[1], compDelMatch[2]);
      }

      /* Raids -------------------------------------------------------- */

      const raidsMatch = path.match(/^\/api\/guilds\/([\w-]+)\/raids$/);
      if (raidsMatch && method === "GET") {
        return handleRaidList(request, env, headers, raidsMatch[1]);
      }
      if (raidsMatch && method === "POST") {
        return handleRaidCreate(request, env, headers, raidsMatch[1]);
      }

      const raidBulk = path.match(/^\/api\/guilds\/([\w-]+)\/raids\/bulk$/);
      if (raidBulk && method === "POST") {
        return handleRaidBulkCreate(request, env, headers, raidBulk[1]);
      }

      const signupBulk = path.match(/^\/api\/guilds\/([\w-]+)\/signups\/bulk$/);
      if (signupBulk && method === "POST") {
        return handleSignupBulk(request, env, headers, signupBulk[1]);
      }

      const raidMatch = path.match(/^\/api\/raids\/([\w-]+)$/);
      if (raidMatch && method === "GET") {
        return handleRaidGet(request, env, headers, raidMatch[1]);
      }
      if (raidMatch && method === "PUT") {
        return handleRaidUpdate(request, env, headers, raidMatch[1]);
      }
      if (raidMatch && method === "DELETE") {
        return handleRaidCancel(request, env, headers, raidMatch[1]);
      }

      const signupMatch = path.match(/^\/api\/raids\/([\w-]+)\/signup$/);
      if (signupMatch && method === "POST") {
        return handleSignupCreate(request, env, headers, signupMatch[1]);
      }
      if (signupMatch && method === "DELETE") {
        return handleSignupWithdraw(request, env, headers, signupMatch[1]);
      }

      const acceptSignup = path.match(/^\/api\/raids\/([\w-]+)\/signups\/([\w-]+)\/accept$/);
      if (acceptSignup && method === "POST") {
        return handleSignupAccept(request, env, headers, acceptSignup[1], acceptSignup[2]);
      }

      const declineSignup = path.match(/^\/api\/raids\/([\w-]+)\/signups\/([\w-]+)\/decline$/);
      if (declineSignup && method === "POST") {
        return handleSignupDecline(request, env, headers, declineSignup[1], declineSignup[2]);
      }

      const seedMatch = path.match(/^\/api\/guilds\/([\w-]+)\/seed$/);
      if (seedMatch && method === "POST") {
        return handleGuildSeed(request, env, headers, seedMatch[1]);
      }
      if (seedMatch && method === "DELETE") {
        return handleGuildUnseed(request, env, headers, seedMatch[1]);
      }

      return json({ error: "not_found", path }, { status: 404 }, headers);
    } catch (err) {
      return json(
        { error: "internal", message: String(err && err.message) },
        { status: 500 },
        headers
      );
    }
  },
};
