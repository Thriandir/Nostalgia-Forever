/**
 * Game data for World of Warcraft: Forever.
 *
 * EVERYTHING the game defines lives here. No class list, spec list, or
 * role mapping belongs anywhere else in the codebase. When Forever's beta
 * changes something, this file is the only thing that should need editing.
 *
 * Confirmed at time of writing (Sept 2026):
 *   - Level cap frozen at 60.
 *   - Vanilla class roster. No Death Knight/Monk/Demon Hunter/Evoker.
 *   - New race: Skyborne. Starts neutral, commits to a faction, and its
 *     class options depend on which side it picks.
 *   - Paladin is being reworked — treat its spec data as provisional.
 *   - Raids at 10, 20 and 40. Onyxia is 40, Hyjal Summit 20, Barrow Deeps 10.
 *
 * Feral is split into "Feral Tank" and "Feral DPS" as separate declarable
 * specs, because during levelling the intent is what matters and one `role`
 * field can't express both. An officer can still slot a Feral DPS player
 * into a tank spot later — slot matching is a suggestion, not a constraint.
 */

export const REGIONS = ["EU", "US"];

export const REALM_TYPES = ["PvE", "PvP", "RP", "Hardcore"];

export const FACTIONS = ["Horde", "Alliance"];

export const ROLES = ["Tank", "Healer", "DPS"];

/** Level buckets: coarse through the grind, granular where it decides raiding. */
export const LEVEL_BUCKETS = [
  "1-19",
  "20-39",
  "40-55",
  "56",
  "57",
  "58",
  "59",
  "60",
];

export const COMMITMENTS = ["primary", "secondary", "alt"];

export const CLASSES = {
  Warrior: {
    color: "#C79C6E",
    specs: { Arms: "DPS", Fury: "DPS", Protection: "Tank" },
  },
  Paladin: {
    color: "#F58CBA",
    specs: { Holy: "Healer", Protection: "Tank", Retribution: "DPS" },
    provisional: true, // reworked in Forever — verify against live data
  },
  Hunter: {
    color: "#ABD473",
    specs: { "Beast Mastery": "DPS", Marksmanship: "DPS", Survival: "DPS" },
  },
  Rogue: {
    color: "#FFF569",
    specs: { Assassination: "DPS", Combat: "DPS", Subtlety: "DPS" },
  },
  Priest: {
    color: "#FFFFFF",
    specs: { Discipline: "Healer", Holy: "Healer", Shadow: "DPS" },
  },
  Shaman: {
    color: "#0070DE",
    specs: { Elemental: "DPS", Enhancement: "DPS", Restoration: "Healer" },
  },
  Mage: {
    color: "#69CCF0",
    specs: { Arcane: "DPS", Fire: "DPS", Frost: "DPS" },
  },
  Warlock: {
    color: "#9482C9",
    specs: { Affliction: "DPS", Demonology: "DPS", Destruction: "DPS" },
  },
  Druid: {
    color: "#FF7D0A",
    specs: {
      Balance: "DPS",
      "Feral Tank": "Tank",
      "Feral DPS": "DPS",
      Restoration: "Healer",
    },
  },
};

export const RACES = {
  Alliance: ["Human", "Dwarf", "Night Elf", "Gnome", "Skyborne"],
  Horde: ["Orc", "Undead", "Tauren", "Troll", "Skyborne"],
};

/**
 * Which classes each race may roll.
 *
 * Forever makes SIX deliberate changes to the vanilla matrix, marked NEW below:
 * Human Hunter, Dwarf Shaman, Gnome Priest, Orc Mage, Troll Warlock, and
 * Undead Paladin. The consequence is that the old faction lock is gone —
 * Alliance can roll Shaman and Horde can roll Paladin. Do not "correct" this
 * back to vanilla rules.
 *
 * Skyborne is keyed by faction because its options depend on the side it
 * commits to: Shaman for Horde, Mage for Alliance, Paladin for neither.
 */
export const RACE_CLASSES = {
  // Alliance
  Human: ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Mage", "Warlock"], // Hunter NEW
  Dwarf: ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Shaman"], // Shaman NEW
  "Night Elf": ["Warrior", "Hunter", "Rogue", "Priest", "Druid"],
  Gnome: ["Warrior", "Rogue", "Priest", "Mage", "Warlock"], // Priest NEW

  // Horde
  Orc: ["Warrior", "Hunter", "Rogue", "Shaman", "Mage", "Warlock"], // Mage NEW
  Undead: ["Warrior", "Paladin", "Rogue", "Priest", "Mage", "Warlock"], // Paladin NEW
  Tauren: ["Warrior", "Hunter", "Shaman", "Druid"],
  Troll: ["Warrior", "Hunter", "Rogue", "Priest", "Shaman", "Mage", "Warlock"], // Warlock NEW

  // Neutral until it commits to a faction
  Skyborne: {
    Alliance: ["Warrior", "Hunter", "Rogue", "Druid", "Mage"],
    Horde: ["Warrior", "Hunter", "Rogue", "Druid", "Shaman"],
  },
};

/** Two-letter badges. Race names are game data, so these stay English. */
export const RACE_SHORT = {
  Human: "Hu",
  Dwarf: "Dw",
  "Night Elf": "NE",
  Gnome: "Gn",
  Orc: "Or",
  Undead: "UD",
  Tauren: "Ta",
  Troll: "Tr",
  Skyborne: "Sk",
};

export function shortRace(race) {
  return RACE_SHORT[race] || String(race || "").slice(0, 2);
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export function classNames() {
  return Object.keys(CLASSES);
}

export function specsFor(className) {
  return Object.keys(CLASSES[className]?.specs || {});
}

export function roleFor(className, spec) {
  return CLASSES[className]?.specs?.[spec] || null;
}

/**
 * Returns a CSS variable rather than the raw hex, so themes can correct for
 * legibility. Priest is pure white and Rogue a pale yellow — both vanish on
 * a light background, and the light themes override those tokens.
 *
 * The hex on each class above stays as the canonical reference.
 */
export function colorFor(className) {
  if (!CLASSES[className]) return "var(--text-dim)";
  return `var(--class-${className.toLowerCase()})`;
}

export function racesFor(faction) {
  return RACES[faction] || [];
}

/** Classes available to a race, taking faction into account for Skyborne. */
export function classesFor(race, faction) {
  const entry = RACE_CLASSES[race];
  if (!entry) return [];
  if (Array.isArray(entry)) return entry;
  return entry[faction] || [];
}

/** Every class+spec pair, grouped by role. Drives the progression board. */
export function allSpecsByRole() {
  const out = { Tank: [], Healer: [], DPS: [] };
  for (const [className, data] of Object.entries(CLASSES)) {
    for (const [spec, role] of Object.entries(data.specs)) {
      out[role].push({ className, spec, role, color: colorFor(className) });
    }
  }
  return out;
}

/** True when this class's data is known to be in flux (Paladin rework). */
export function isProvisional(className) {
  return Boolean(CLASSES[className]?.provisional);
}

/**
 * A class is a hybrid if it can heal — Paladin, Priest, Shaman, Druid.
 *
 * This is how players actually divide the roster: a Shadow Priest is "a
 * healer playing DPS" in a way a Fire Mage never is. Warriors tank but
 * nobody calls them hybrids, and deriving from the healer spec rather than
 * listing classes by hand gets that right automatically.
 */
export function isHybrid(className) {
  const specs = CLASSES[className]?.specs || {};
  return Object.values(specs).includes("Healer");
}
