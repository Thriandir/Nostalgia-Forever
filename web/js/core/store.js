/**
 * In-memory session state. Deliberately small.
 *
 * Nothing here is authoritative — the Worker owns the truth and re-derives
 * permissions on every request. This is a render cache, not a security model.
 */

const listeners = new Set();

export const store = {
  user: null,
  characters: [],
  memberships: [],
  activeGuildId: null,

  get signedIn() {
    return Boolean(this.user);
  },

  hydrate({ user, characters, memberships }) {
    this.user = user || null;
    this.characters = characters || [];
    this.memberships = memberships || [];
    if (!this.activeGuildId && this.memberships.length) {
      this.activeGuildId =
        localStorage.getItem("nf_guild") || this.memberships[0].guildId;
    }
    emit();
  },

  setUser(user) {
    this.user = user;
    emit();
  },

  setCharacters(characters) {
    this.characters = characters || [];
    emit();
  },

  setMemberships(memberships) {
    this.memberships = memberships || [];
    if (this.activeGuildId && !this.membership(this.activeGuildId)) {
      this.activeGuildId = this.memberships[0]?.guildId || null;
    }
    emit();
  },

  /** Characters in a guild, or unguilded ones when guildId is null. */
  charactersIn(guildId = null) {
    return this.characters.filter((c) => (c.guildId || null) === guildId);
  },

  primaryCharacter(faction) {
    return (
      this.characters.find(
        (c) => c.commitment === "primary" && (!faction || c.faction === faction)
      ) || null
    );
  },

  setActiveGuild(guildId) {
    this.activeGuildId = guildId;
    if (guildId) localStorage.setItem("nf_guild", guildId);
    else localStorage.removeItem("nf_guild");
    emit();
  },

  membership(guildId) {
    return this.memberships.find((m) => m.guildId === guildId) || null;
  },

  roleIn(guildId) {
    return this.membership(guildId)?.role || null;
  },

  clear() {
    this.user = null;
    this.characters = [];
    this.memberships = [];
    this.activeGuildId = null;
    emit();
  },
};

function emit() {
  for (const fn of listeners) fn(store);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
