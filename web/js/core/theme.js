/**
 * Theming: two faction palettes × light and dark.
 *
 * In the guild zone the palette follows the guild's faction.
 * In the personal zone the user picks both.
 */

import { APP } from "../config/app.js";

const FACTIONS = ["horde", "alliance"];
const MODES = ["light", "dark"];

let faction = APP.defaultFaction;
let mode = APP.defaultThemeMode;

export function applyTheme({ faction: f, mode: m } = {}) {
  if (f && FACTIONS.includes(f)) faction = f;
  if (m && MODES.includes(m)) mode = m;
  document.documentElement.dataset.theme = `${faction}-${mode}`;
  document.documentElement.style.colorScheme = mode;
  return { faction, mode };
}

export function getTheme() {
  return { faction, mode };
}

export function toggleMode() {
  return applyTheme({ mode: mode === "dark" ? "light" : "dark" });
}

/** Honour the OS preference before the user has expressed one. */
export function detectMode() {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export { FACTIONS, MODES };
