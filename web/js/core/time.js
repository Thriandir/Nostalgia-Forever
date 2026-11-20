/**
 * Time handling.
 *
 * Three timezones are in play and confusing them is how guilds miss raids:
 *
 *   UTC           what we store. The only unambiguous representation.
 *   Server time   what admins schedule in, because that's how WoW works.
 *                 EU realms run CET/CEST, which observes DST.
 *   Local time    what each member reads. Turkey is UTC+3 year-round and
 *                 does NOT observe DST, so the gap to server time changes
 *                 by an hour twice a year.
 *
 * Rule: store instants as ISO-8601 UTC. Convert on input and on display,
 * never in storage. Every conversion is date-aware, because the offset
 * depends on which side of a DST boundary the date falls.
 *
 * No libraries — Intl does all of this, just awkwardly in one direction.
 */

import { APP } from "../config/app.js";
import { getLocale } from "./i18n.js";

const USER_ZONE_KEY = "nf_timezone";

/* ------------------------------------------------------------------ *
 * Zone primitives
 * ------------------------------------------------------------------ */

/**
 * Offset of `timeZone` from UTC at a given instant, in milliseconds.
 * Positive east of Greenwich.
 *
 * Works by formatting the instant in the target zone, reading the wall-clock
 * numbers back as if they were UTC, and taking the difference.
 */
export function zoneOffset(timeZone, date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;

  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );

  return asUTC - date.getTime();
}

/**
 * A wall-clock time in a named zone → the UTC instant it refers to.
 *
 *   zonedToUtc("2026-11-08", "20:00", "Europe/Paris")
 *
 * Runs the correction twice because the first guess can land on the far side
 * of a DST boundary, where the offset differs from the one we applied.
 */
export function zonedToUtc(dateStr, timeStr, timeZone) {
  const [h = "0", m = "0"] = String(timeStr).split(":");
  const naive = new Date(
    `${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`
  );
  if (Number.isNaN(naive.getTime())) return null;

  const first = zoneOffset(timeZone, naive);
  let utc = new Date(naive.getTime() - first);

  const second = zoneOffset(timeZone, utc);
  if (second !== first) utc = new Date(naive.getTime() - second);

  return utc;
}

/** Format an instant in a named zone. */
export function formatInZone(instant, timeZone, options = {}) {
  const date = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat(getLocale(), { timeZone, ...options }).format(date);
}

/** Just the clock, e.g. "20:00". */
export function timeInZone(instant, timeZone) {
  return formatInZone(instant, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Short zone label, e.g. "CET", "GMT+3". */
export function zoneLabel(timeZone, instant = new Date()) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value || timeZone;
}

/** Explicit offset label, e.g. "UTC+03:00". Unambiguous where abbreviations aren't. */
export function offsetLabel(timeZone, instant = new Date()) {
  const ms = zoneOffset(timeZone, instant instanceof Date ? instant : new Date(instant));
  const sign = ms < 0 ? "-" : "+";
  const mins = Math.abs(Math.round(ms / 60000));
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/* ------------------------------------------------------------------ *
 * The two zones that matter
 * ------------------------------------------------------------------ */

/** The realm's timezone. Guild-level once guilds exist; config default until then. */
export function serverZone(guild) {
  return guild?.serverTimezone || APP.serverTimezone;
}

/** The member's timezone — their explicit choice, else the browser's. */
export function userZone() {
  const stored = localStorage.getItem(USER_ZONE_KEY);
  if (stored && isValidZone(stored)) return stored;
  return detectZone();
}

export function setUserZone(timeZone) {
  if (timeZone && isValidZone(timeZone)) localStorage.setItem(USER_ZONE_KEY, timeZone);
  else localStorage.removeItem(USER_ZONE_KEY);
  return userZone();
}

export function hasZoneOverride() {
  return Boolean(localStorage.getItem(USER_ZONE_KEY));
}

export function detectZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Display
 * ------------------------------------------------------------------ */

/**
 * Everything a raid time needs to render.
 *
 *   {
 *     local:      "22:00",  localZone: "Europe/Istanbul", localLabel: "GMT+3",
 *     server:     "20:00",  serverZone: "Europe/Paris",   serverLabel: "CET",
 *     sameZone:   false,          // true when no second line is needed
 *     date:       "8 Nov 2026",   // as it falls in the member's zone
 *     dayDiffers: false,          // true when local and server dates differ
 *   }
 */
export function describeInstant(instant, guild) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const local = userZone();
  const server = serverZone(guild);

  const sameZone = zoneOffset(local, date) === zoneOffset(server, date);

  const localDay = formatInZone(date, local, { dateStyle: "medium" });
  const serverDay = formatInZone(date, server, { dateStyle: "medium" });

  return {
    instant: date,
    local: timeInZone(date, local),
    localZone: local,
    localLabel: zoneLabel(local, date),
    localOffset: offsetLabel(local, date),
    server: timeInZone(date, server),
    serverZone: server,
    serverLabel: zoneLabel(server, date),
    serverOffset: offsetLabel(server, date),
    sameZone,
    date: localDay,
    serverDate: serverDay,
    dayDiffers: localDay !== serverDay,
  };
}

/** Compact one-liner: "22:00 · 20:00 server" — or just "20:00" when identical. */
export function formatDual(instant, guild) {
  const d = describeInstant(instant, guild);
  if (d.sameZone) return d.local;
  return `${d.local} · ${d.server} ${d.serverLabel}`;
}

/** Current wall clock in a zone, for live displays. */
export function nowIn(timeZone) {
  return timeInZone(new Date(), timeZone);
}
