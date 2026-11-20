/**
 * Thin client over the Worker API.
 * Every call sends credentials so the session cookie travels with it.
 */

import { APP } from "../config/app.js";

export class ApiError extends Error {
  constructor(code, status, payload) {
    super(code);
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${APP.apiBase}${path}`, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("network", 0, null);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty body is fine */
  }

  if (!res.ok) {
    // Logged so a screenshot of the console tells us which call failed and
    // why. The visible message stays human; this is for diagnosis.
    console.error(
      `[api] ${method} ${path} → ${res.status}`,
      payload?.error || "(no error code)",
      payload || ""
    );
    throw new ApiError(payload?.error || "generic", res.status, payload);
  }
  return payload;
}

export const api = {
  health: () => request("/api/health"),

  me: () => request("/api/me"),
  updateProfile: (patch) => request("/api/me/profile", { method: "PUT", body: patch }),

  createCharacter: (character) =>
    request("/api/me/characters", { method: "POST", body: character }),
  updateCharacter: (id, character) =>
    request(`/api/me/characters/${id}`, { method: "PUT", body: character }),
  deleteCharacter: (id) =>
    request(`/api/me/characters/${id}`, { method: "DELETE" }),
  restoreCharacter: (id) =>
    request(`/api/me/characters/${id}/restore`, { method: "POST" }),
  importCharacters: (payload) =>
    request("/api/me/characters/import", { method: "POST", body: payload }),
  setCharacterGuild: (id, guildId) =>
    request(`/api/me/characters/${id}/guild`, { method: "PUT", body: { guildId } }),

  createGuild: (guild) => request("/api/guilds", { method: "POST", body: guild }),
  guild: (id) => request(`/api/guilds/${id}`),
  createInvite: (guildId) =>
    request(`/api/guilds/${guildId}/invites`, { method: "POST" }),
  previewInvite: (code) => request(`/api/invites/${code}`),
  acceptInvite: (code, characterIds, acceptedConduct) =>
    request(`/api/invites/${code}/accept`, {
      method: "POST",
      body: { characterIds, acceptedConduct },
    }),
  updateGuild: (guildId, patch) =>
    request(`/api/guilds/${guildId}`, { method: "PUT", body: patch }),

  setGuildComp: (guildId, comp) =>
    request(`/api/guilds/${guildId}/comp`, { method: "PUT", body: comp }),
  saveComposition: (guildId, composition) =>
    request(`/api/guilds/${guildId}/compositions`, { method: "POST", body: composition }),
  deleteComposition: (guildId, compId) =>
    request(`/api/guilds/${guildId}/compositions/${compId}`, { method: "DELETE" }),

  raids: (guildId, from, to) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    return request(`/api/guilds/${guildId}/raids?${q}`);
  },
  createRaid: (guildId, raid) =>
    request(`/api/guilds/${guildId}/raids`, { method: "POST", body: raid }),
  createRaids: (guildId, raid) =>
    request(`/api/guilds/${guildId}/raids/bulk`, { method: "POST", body: raid }),
  bulkSignUp: (guildId, raidIds, characterId, note) =>
    request(`/api/guilds/${guildId}/signups/bulk`, {
      method: "POST",
      body: { raidIds, characterId, note },
    }),
  raid: (raidId) => request(`/api/raids/${raidId}`),
  updateRaid: (raidId, patch) =>
    request(`/api/raids/${raidId}`, { method: "PUT", body: patch }),
  cancelRaid: (raidId) => request(`/api/raids/${raidId}`, { method: "DELETE" }),

  signUp: (raidId, characterId, note) =>
    request(`/api/raids/${raidId}/signup`, { method: "POST", body: { characterId, note } }),
  withdraw: (raidId, reason) =>
    request(`/api/raids/${raidId}/signup`, { method: "DELETE", body: { reason } }),
  acceptSignup: (raidId, signupId, slotIndex) =>
    request(`/api/raids/${raidId}/signups/${signupId}/accept`, {
      method: "POST",
      body: { slotIndex },
    }),
  declineSignup: (raidId, signupId, reason) =>
    request(`/api/raids/${raidId}/signups/${signupId}/decline`, {
      method: "POST",
      body: { reason },
    }),

  // Testing only — fills a guild with fake characters so the progression
  // board can be judged against a realistic roster.
  seedGuild: (guildId, count, mode) =>
    request(`/api/guilds/${guildId}/seed`, { method: "POST", body: { count, mode } }),
  unseedGuild: (guildId) =>
    request(`/api/guilds/${guildId}/seed`, { method: "DELETE" }),

  logout: () => request("/api/auth/logout", { method: "POST" }),

  /** Full-page redirect — the OAuth dance can't happen over fetch. */
  loginUrl: (next = "/") =>
    `${APP.apiBase}/api/auth/google/login?next=${encodeURIComponent(next)}`,

  /** Account linking. Also a redirect, for the same reason. */
  linkUrl: (provider, returnTo) =>
    `${APP.apiBase}/api/auth/${provider}/link` +
    (returnTo ? `?return=${encodeURIComponent(returnTo)}` : ""),
  unlink: (provider) => request(`/api/auth/${provider}/link`, { method: "DELETE" }),
};
