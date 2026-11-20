/**
 * App-level configuration.
 * The product name lives here and nowhere else, so renaming stays cheap.
 */

export const APP = {
  name: "Nostalgia Forever",
  tagline: "Guild management for WoW: Forever",

  /**
   * Worker API base. Empty string means same-origin (useful for local dev).
   *
   * Kept as a sibling first-level subdomain rather than api.nostalgia.…
   * because Cloudflare's free Universal SSL only covers the apex plus one
   * level of subdomain. Two levels deep needs paid Advanced Certificate
   * Manager.
   */
  apiBase: "https://nostalgia-api.duzgunoyun.com",

  defaultLocale: "en",
  locales: ["en", "tr"],

  /**
   * Realm timezone. EU WoW realms have always run CET/CEST, which is what
   * Europe/Paris resolves to including DST. Forever's realms aren't announced
   * yet — once guilds exist this moves to a per-guild setting and this becomes
   * only the default for a newly created guild.
   */
  serverTimezone: "Europe/Paris",

  defaultFaction: "horde",
  defaultThemeMode: "dark",

  /**
   * Suggested gear planner, linked from the character form.
   *
   * The field itself accepts any URL — this is only a pointer for people who
   * don't already have a plan. Sixtyupgrades covers Classic Era and Season of
   * Discovery; whether it ever supports Forever is unknown, so when a better
   * planner appears, change it here and nowhere else.
   */
  gearPlanner: {
    name: "sixtyupgrades",
    url: "https://sixtyupgrades.com",
  },
};

/** Feature flags. Anything false renders nothing at all — no placeholder. */
export const FEATURES = {
  progression:    true,
  calendar:       false,
  raids:          false,

  // On during beta so Cem can create Nostalji. Turn off for the commercial
  // product, where guild creation becomes a gated signup step.
  selfServeGuilds: true,

  // Fake-roster controls on the guild card. MUST be false before the guild
  // uses this for real — it's a button that invents forty characters.
  seedData: true,

  // Dark: scaffolded, not released.
  buffCoverage:   false,
  armoryGear:     false,
  guildSeeking:   false,
};
