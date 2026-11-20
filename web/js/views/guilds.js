import { el, mount, toast } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { store } from "../core/store.js";
import { fullName } from "../core/names.js";
import { FEATURES } from "../config/app.js";
import { applyTheme } from "../core/theme.js";
import * as router from "../core/router.js";
import {
  REGIONS,
  REALM_TYPES,
  FACTIONS,
  colorFor,
} from "../config/game.js";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Accepts a bare code or a full invite URL, since people paste both. */
export function extractInviteCode(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const fromUrl = text.match(/[#/]join\/([A-Z0-9]{4,16})/i);
  if (fromUrl) return fromUrl[1].toUpperCase();
  const bare = text.match(/^[A-Z0-9]{4,16}$/i);
  return bare ? text.toUpperCase() : null;
}

function select(value, options, onChange) {
  return el(
    "select",
    { class: "select", onChange: (e) => onChange(e.target.value || null) },
    options.map((opt) => {
      const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
      return el("option", { value: val, selected: val === value || null }, label);
    })
  );
}

function field(label, control, hint) {
  return el(
    "div",
    { class: "field" },
    el("span", { class: "label" }, label),
    control,
    hint && el("p", { class: "hint" }, hint)
  );
}

/* ------------------------------------------------------------------ *
 * Character picker — shared by invite acceptance and guild management
 * ------------------------------------------------------------------ */

/**
 * Lists the user's characters with checkboxes, disabling any whose faction
 * doesn't match the guild. Faction is the one rule that can't be worked
 * around, so it's better shown as a disabled row with a reason than hidden.
 */
function characterPicker(characters, faction, selected, onToggle) {
  const live = characters.filter((c) => !c.deletedAt);

  if (live.length === 0) {
    return el(
      "div",
      { class: "empty", style: { padding: "22px" } },
      el("p", { style: { margin: 0, fontSize: "13.5px" } }, t("guilds.noCharacters"))
    );
  }

  return el(
    "div",
    { class: "picker" },
    live.map((c) => {
      const mismatch = c.faction !== faction;
      const checked = selected.has(c.id);
      return el(
        "label",
        {
          class: `picker-row ${mismatch ? "is-disabled" : ""}`,
          style: { "--class-color": colorFor(c.class) },
        },
        el("input", {
          type: "checkbox",
          checked: checked || null,
          disabled: mismatch || null,
          onChange: () => onToggle(c.id),
        }),
        el(
          "div",
          { class: "stack grow" },
          el("strong", { class: "truncate" }, fullName(c)),
          el(
            "span",
            { class: "muted", style: { fontSize: "12px" } },
            mismatch
              ? t("guilds.wrongFaction", { faction: c.faction })
              : `${c.race} · ${c.spec} ${c.class}`
          )
        ),
        c.guildId && c.guildId !== "" && !mismatch
          ? el("span", { class: "tag tag-soft" }, t("guilds.alreadyAssigned"))
          : null
      );
    })
  );
}

/* ------------------------------------------------------------------ *
 * Create guild
 * ------------------------------------------------------------------ */

/** Must match RESET_COLOURS in the worker — these are stored as keys. */
const RESET_COLOURS = ["red", "orange", "green", "blue", "purple", "teal"];

/** Mirrors the Worker's DEFAULT_CODE_OF_CONDUCT so the field starts filled. */
const DEFAULT_CONDUCT = `We raid to enjoy ourselves together.

Be on time and come prepared — consumables, repairs, and the right attunements.
If you can't make a raid you signed up for, tell an officer as early as you can.
Listen during encounters, keep criticism constructive, and treat everyone here
with respect.

Loot is decided by the raid leader. Decisions stand for that night and can be
discussed afterwards.`;

function openCreateGuild(onCreated) {
  const draft = {
    name: "",
    region: "EU",
    realmType: "PvE",
    faction: "Horde",
    language: "en",
    serverTimezone: "Europe/Paris",
    codeOfConduct: DEFAULT_CONDUCT,
  };
  let invalid = new Set();

  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body" });

  function close() {
    overlay.remove();
  }

  async function save() {
    try {
      const res = await api.createGuild(draft);
      store.setMemberships(res.memberships);
      store.setActiveGuild(res.guild.id);
      toast(t("guilds.created"));
      close();
      onCreated(res.guild);
    } catch (err) {
      if (err.code === "validation") {
        invalid = new Set(err.payload?.fields || []);
        render();
        toast(t("error.validation"));
      } else {
        toast(t("error.generic"));
      }
    }
  }

  function set(patch) {
    Object.assign(draft, patch);
    render();
  }

  function render() {
    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el("h2", { class: "modal-title" }, t("guilds.create")),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close }, "✕")
      ),
      el(
        "div",
        { class: "modal-scroll" },
        field(
          t("guilds.name"),
          el("input", {
            class: `input ${invalid.has("name") ? "is-invalid" : ""}`,
            value: draft.name,
            placeholder: t("guilds.namePlaceholder"),
            maxlength: "32",
            onInput: (e) => (draft.name = e.target.value),
          })
        ),
        el(
          "div",
          { class: "field-row" },
          field(t("char.region"), select(draft.region, REGIONS, (v) => set({ region: v }))),
          field(t("char.realmType"), select(draft.realmType, REALM_TYPES, (v) => set({ realmType: v })))
        ),
        field(
          t("char.faction"),
          select(draft.faction, FACTIONS, (v) => set({ faction: v })),
          t("guilds.factionHint")
        ),
        field(
          t("guilds.language"),
          select(
            draft.language,
            [
              ["en", "English"],
              ["tr", "Türkçe"],
            ],
            (v) => set({ language: v })
          ),
          t("guilds.languageHint")
        ),

        field(
          t("guilds.conduct"),
          el("textarea", {
            class: "input",
            rows: "10",
            value: draft.codeOfConduct,
            maxlength: "4000",
            onInput: (e) => (draft.codeOfConduct = e.target.value),
          }),
          t("guilds.conductCreateHint")
        )
      ),
      el(
        "div",
        { class: "modal-foot" },
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel")),
        el("button", { class: "btn btn-primary", onClick: save }, t("guilds.create"))
      )
    );
  }

  render();
  overlay.append(body);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  document.body.append(overlay);
}

/* ------------------------------------------------------------------ *
 * Guild settings
 * ------------------------------------------------------------------ */

function openGuildSettings(guildId, onSaved) {
  let guild = null;
  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body" });

  function close() {
    overlay.remove();
  }

  async function load() {
    try {
      const res = await api.guild(guildId);
      guild = { ...res.guild };
      if (!guild.codeOfConduct) guild.codeOfConduct = DEFAULT_CONDUCT;
    } catch {
      toast(t("error.generic"));
      close();
      return;
    }
    render();
  }

  async function save() {
    try {
      await api.updateGuild(guildId, {
        name: guild.name,
        language: guild.language,
        codeOfConduct: guild.codeOfConduct,
        resets: guild.resets,
      });
      toast(t("guilds.settingsSaved"));
      close();
      onSaved();
    } catch (err) {
      toast(err.code === "forbidden" ? t("error.forbidden") : t("error.generic"));
    }
  }

  /**
   * Editable list of weekly resets.
   *
   * Left as a list the guild fills in rather than guessing Forever's raid
   * schedules. One Wednesday server reset is the only safe assumption, and
   * that's the default; everything else gets added as it becomes known.
   */
  function resetEditor() {
    const resets = guild.resets || [];

    return el(
      "div",
      { class: "reset-editor" },
      resets.map((reset, i) =>
        el(
          "div",
          { class: `reset-row is-${reset.colour || "red"}` },
          el(
            "div",
            { class: "reset-main" },
            el("input", {
              class: "input input-sm grow",
              value: reset.name,
              placeholder: t("guilds.resetNamePlaceholder"),
              maxlength: "24",
              onInput: (e) => (reset.name = e.target.value),
            }),
            el("input", {
              class: "input input-sm",
              type: "time",
              value: reset.time || "07:00",
              style: { maxWidth: "104px" },
              onChange: (e) => (reset.time = e.target.value),
            }),
            el(
              "button",
              {
                class: "btn btn-sm btn-danger-outline",
                title: t("common.delete"),
                onClick: () => {
                  guild.resets.splice(i, 1);
                  render();
                },
              },
              "✕"
            )
          ),
          el(
            "div",
            { class: "reset-controls" },
            el(
              "div",
              { class: "day-toggles" },
              [1, 2, 3, 4, 5, 6, 0].map((dow) =>
                el(
                  "button",
                  {
                    type: "button",
                    class: `day-toggle day-toggle-sm ${
                      (reset.weekdays || []).includes(dow) ? "is-on" : ""
                    }`,
                    onClick: () => {
                      const days = new Set(reset.weekdays || []);
                      days.has(dow) ? days.delete(dow) : days.add(dow);
                      reset.weekdays = [...days].sort();
                      render();
                    },
                  },
                  new Intl.DateTimeFormat(undefined, { weekday: "short" })
                    .format(new Date(Date.UTC(2024, 0, 7 + dow)))
                    .slice(0, 2)
                )
              )
            ),
            el(
              "div",
              { class: "colour-picks" },
              RESET_COLOURS.map((colour) =>
                el("button", {
                  type: "button",
                  class: `colour-pick is-${colour} ${
                    (reset.colour || "red") === colour ? "is-on" : ""
                  }`,
                  title: colour,
                  onClick: () => {
                    reset.colour = colour;
                    render();
                  },
                })
              )
            )
          )
        )
      ),
      resets.length < 8 &&
        el(
          "button",
          {
            class: "btn btn-sm",
            onClick: () => {
              guild.resets = [
                ...resets,
                {
                  name: "",
                  weekdays: [3],
                  time: "07:00",
                  colour: RESET_COLOURS[resets.length % RESET_COLOURS.length],
                },
              ];
              render();
            },
          },
          t("guilds.addReset")
        )
    );
  }

  function render() {
    if (!guild) {
      mount(body, el("div", { class: "empty" }, t("common.loading")));
      return;
    }
    if (!Array.isArray(guild.resets)) guild.resets = [];
    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el("h2", { class: "modal-title" }, t("guilds.settings")),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close }, "✕")
      ),
      el(
        "div",
        { class: "modal-scroll" },
        field(
          t("guilds.name"),
          el("input", {
            class: "input",
            value: guild.name,
            maxlength: "32",
            onInput: (e) => (guild.name = e.target.value),
          })
        ),
        field(
          t("guilds.language"),
          select(
            guild.language,
            [
              ["en", "English"],
              ["tr", "Türkçe"],
            ],
            (v) => (guild.language = v)
          )
        ),
        field(t("guilds.resets"), resetEditor(), t("guilds.resetsHint")),

        field(
          t("guilds.conduct"),
          el("textarea", {
            class: "input",
            rows: "12",
            value: guild.codeOfConduct,
            maxlength: "4000",
            onInput: (e) => (guild.codeOfConduct = e.target.value),
          }),
          t("guilds.conductEditHint")
        ),
        el(
          "p",
          { class: "hint" },
          `${guild.faction} · ${guild.region} ${guild.realmType} — ${t("guilds.immutable")}`
        )
      ),
      el(
        "div",
        { class: "modal-foot" },
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel")),
        el("button", { class: "btn btn-primary", onClick: save }, t("common.save"))
      )
    );
  }

  load();
  overlay.append(body);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  document.body.append(overlay);
}

/* ------------------------------------------------------------------ *
 * Guilds list
 * ------------------------------------------------------------------ */

export function renderGuilds(root) {
  let joinValue = "";
  let busy = false;

  async function join() {
    const code = extractInviteCode(joinValue);
    if (!code) {
      toast(t("guilds.badCode"));
      return;
    }
    router.navigate(`/join/${code}`);
  }

  async function makeInvite(guildId) {
    try {
      const { invite } = await api.createInvite(guildId);
      const url = `${location.origin}${location.pathname}#/join/${invite.code}`;
      try {
        await navigator.clipboard.writeText(url);
        toast(t("guilds.inviteCopied"));
      } catch {
        prompt(t("guilds.inviteLink"), url);
      }
    } catch (err) {
      toast(err.code === "forbidden" ? t("error.forbidden") : t("error.generic"));
    }
  }

  async function seed(guildId, count, mode) {
    try {
      const res = await api.seedGuild(guildId, count, mode);
      toast(t("guilds.seeded", { count: res.added }));
    } catch {
      toast(t("error.generic"));
    }
  }

  async function unseed(guildId) {
    try {
      const res = await api.unseedGuild(guildId);
      toast(t("guilds.unseeded", { count: res.removed }));
    } catch {
      toast(t("error.generic"));
    }
  }

  function guildCard(membership) {
    const mine = store.characters.filter(
      (c) => c.guildId === membership.guildId && !c.deletedAt
    );
    const canInvite = membership.role === "owner" || membership.role === "admin";

    return el(
      "article",
      { class: "guild-card" },
      el(
        "div",
        { class: "row-between" },
        el(
          "div",
          { class: "stack grow" },
          el(
            "div",
            { class: "char-name-row" },
            el("strong", { class: "guild-name" }, membership.guildName),
            el("span", { class: `badge badge-role-${membership.role}` }, t(`role.${membership.role}`))
          ),
          el(
            "span",
            { class: "muted", style: { fontSize: "12.5px" } },
            membership.faction
          )
        ),
        canInvite &&
          el(
            "div",
            { class: "row" },
            el(
              "button",
              {
                class: "btn btn-sm btn-ghost",
                onClick: () =>
                  openGuildSettings(membership.guildId, () => location.reload()),
              },
              t("guilds.settings")
            ),
            el(
              "button",
              { class: "btn btn-sm", onClick: () => makeInvite(membership.guildId) },
              t("guilds.invite")
            )
          )
      ),
      el(
        "div",
        { class: "char-tags", style: { marginTop: "10px" } },
        mine.length
          ? mine.map((c) =>
              el(
                "span",
                { class: "chip chip-class", style: { "--chip-color": colorFor(c.class) } },
                fullName(c)
              )
            )
          : el("span", { class: "tag tag-soft" }, t("guilds.noCharactersHere"))
      ),

      /* Test-roster controls. Behind a flag — turn it off before real use. */
      FEATURES.seedData &&
        canInvite &&
        el(
          "div",
          { class: "seed-bar" },
          el("span", { class: "seed-label" }, t("guilds.seedLabel")),
          el("span", { class: "grow" }),
          el(
            "button",
            {
              class: "btn btn-sm btn-ghost",
              title: t("guilds.seedLevellingHint"),
              onClick: () => seed(membership.guildId, 45, "levelling"),
            },
            t("guilds.seedAdd")
          ),
          el(
            "button",
            {
              class: "btn btn-sm btn-ghost",
              title: t("guilds.seedReadyHint"),
              onClick: () => seed(membership.guildId, 45, "raidReady"),
            },
            t("guilds.seedAddReady")
          ),
          el(
            "button",
            { class: "btn btn-sm btn-ghost", onClick: () => unseed(membership.guildId) },
            t("guilds.seedClear")
          )
        )
    );
  }

  function render() {
    const memberships = store.memberships || [];

    mount(
      root,
      el(
        "div",
        { class: "page-head row-between" },
        el(
          "div",
          {},
          el("h1", { class: "page-title" }, t("guilds.title")),
          el("p", { class: "page-sub" }, t("guilds.sub"))
        ),
        FEATURES.selfServeGuilds &&
          el(
            "button",
            { class: "btn btn-primary", onClick: () => openCreateGuild(() => render()) },
            t("guilds.create")
          )
      ),

      memberships.length === 0
        ? el(
            "div",
            { class: "empty" },
            el("p", { style: { margin: "0 0 6px" } }, t("guilds.none")),
            el("p", { class: "muted", style: { margin: 0, fontSize: "13px" } }, t("guilds.noneHint"))
          )
        : el("div", { class: "guild-list" }, memberships.map(guildCard)),

      /* Join by code ------------------------------------------------- */
      el(
        "section",
        { class: "card", style: { marginTop: "22px" } },
        el("h2", { class: "card-title" }, t("guilds.joinTitle")),
        el("p", { class: "card-sub" }, t("guilds.joinSub")),
        el(
          "div",
          { class: "row" },
          el("input", {
            class: "input grow",
            value: joinValue,
            placeholder: t("guilds.joinPlaceholder"),
            onInput: (e) => (joinValue = e.target.value),
            onKeydown: (e) => e.key === "Enter" && join(),
          }),
          el("button", { class: "btn", disabled: busy || null, onClick: join }, t("guilds.join"))
        )
      )
    );
  }

  render();
}

/* ------------------------------------------------------------------ *
 * Invite landing — /join/:code
 * ------------------------------------------------------------------ */

export function renderJoin(root, code) {
  const selected = new Set();
  let preview = null;
  let failure = null;
  let acceptedConduct = false;

  async function load() {
    try {
      preview = await api.previewInvite(code);
      // Pre-tick every character that could legitimately join.
      for (const c of store.characters) {
        if (!c.deletedAt && c.faction === preview.guild.faction && !c.guildId) {
          selected.add(c.id);
        }
      }
    } catch (err) {
      failure = err.code;
    }
    render();
  }

  async function accept() {
    try {
      const res = await api.acceptInvite(code, [...selected], acceptedConduct);
      store.setMemberships(res.memberships);
      store.setCharacters(res.characters);
      store.setActiveGuild(res.guild.id);
      applyTheme({ faction: res.guild.faction.toLowerCase() });
      toast(t("guilds.joined", { name: res.guild.name }));
      router.navigate("/me/guilds");
    } catch (err) {
      toast(t(`error.${err.code}`) === `error.${err.code}` ? t("error.generic") : t(`error.${err.code}`));
    }
  }

  function render() {
    if (failure) {
      mount(
        root,
        el(
          "div",
          { class: "empty" },
          el("p", { style: { margin: "0 0 6px" } }, t(`error.${failure}`)),
          el(
            "button",
            { class: "btn", style: { marginTop: "12px" }, onClick: () => router.navigate("/me/guilds") },
            t("guilds.title")
          )
        )
      );
      return;
    }

    if (!preview) {
      mount(root, el("div", { class: "empty" }, t("common.loading")));
      return;
    }

    const g = preview.guild;

    mount(
      root,
      el(
        "div",
        { class: "page-head" },
        el("h1", { class: "page-title" }, t("guilds.inviteTitle", { name: g.name })),
        el(
          "p",
          { class: "page-sub" },
          `${g.faction} · ${g.region} ${g.realmType} · ${t("guilds.memberCount", { count: preview.memberCount })}`
        )
      ),

      preview.alreadyMember &&
        el("div", { class: "banner banner-info" }, t("guilds.alreadyMember")),

      el(
        "section",
        { class: "card" },
        el("h2", { class: "card-title" }, t("guilds.bringCharacters")),
        el("p", { class: "card-sub" }, t("guilds.bringCharactersSub", { faction: g.faction })),
        characterPicker(store.characters, g.faction, selected, (id) => {
          selected.has(id) ? selected.delete(id) : selected.add(id);
          render();
        })
      ),

      /* Code of conduct — required to join, skipped when already a member. */
      !preview.alreadyMember &&
        el(
          "section",
          { class: "card" },
          el("h2", { class: "card-title" }, t("guilds.conduct")),
          el("p", { class: "card-sub" }, t("guilds.conductSub", { name: g.name })),
          el("div", { class: "conduct" }, g.codeOfConduct || ""),
          el(
            "label",
            { class: "conduct-accept" },
            el("input", {
              type: "checkbox",
              checked: acceptedConduct || null,
              onChange: () => {
                acceptedConduct = !acceptedConduct;
                render();
              },
            }),
            t("guilds.conductAccept")
          )
        ),

      el(
        "div",
        { class: "row", style: { marginTop: "6px" } },
        el(
          "button",
          { class: "btn btn-ghost", onClick: () => router.navigate("/me/guilds") },
          t("common.cancel")
        ),
        el("span", { class: "grow" }),
        !preview.alreadyMember &&
          !acceptedConduct &&
          el("span", { class: "foot-note" }, t("guilds.conductRequired")),
        el(
          "button",
          {
            class: "btn btn-primary",
            disabled: (!preview.alreadyMember && !acceptedConduct) || null,
            onClick: accept,
          },
          preview.alreadyMember ? t("guilds.addCharacters") : t("guilds.joinGuild")
        )
      )
    );
  }

  load();
}
