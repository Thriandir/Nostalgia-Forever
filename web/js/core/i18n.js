/**
 * Translation.
 *
 * Rules that keep this from rotting:
 *   - Never concatenate translated fragments. Use params.
 *   - Dates and numbers go through Intl, never hand-formatted.
 *   - Class, spec and race names are game data and are never translated.
 */

import en from "../i18n/en.js";
import tr from "../i18n/tr.js";
import { APP } from "../config/app.js";

const BUNDLES = { en, tr };

let current = APP.defaultLocale;

export function setLocale(locale) {
  current = BUNDLES[locale] ? locale : APP.defaultLocale;
  document.documentElement.lang = current;
  return current;
}

export function getLocale() {
  return current;
}

/** Best guess from the browser, falling back to the default. */
export function detectLocale() {
  for (const tag of navigator.languages || [navigator.language || ""]) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (BUNDLES[base]) return base;
  }
  return APP.defaultLocale;
}

/**
 * t("profile.save")
 * t("raid.slots", { filled: 7, total: 10 })  →  "7 of 10 slots filled"
 */
export function t(key, params) {
  const bundle = BUNDLES[current] || BUNDLES[APP.defaultLocale];
  let str = bundle[key];
  if (str === undefined) str = BUNDLES[APP.defaultLocale][key];
  if (str === undefined) return key;
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) =>
    params[name] === undefined ? m : String(params[name])
  );
}

export function formatDate(value, options) {
  const d = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(current, options || { dateStyle: "medium" }).format(d);
}

export function formatNumber(value, options) {
  return new Intl.NumberFormat(current, options).format(value);
}

export const LOCALE_LABELS = { en: "English", tr: "Türkçe" };
