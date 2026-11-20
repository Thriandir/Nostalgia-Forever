import { el, mount, toast } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { store } from "../core/store.js";
import { fullName, byName } from "../core/names.js";
import { APP } from "../config/app.js";
import {
  REGIONS,
  REALM_TYPES,
  FACTIONS,
  LEVEL_BUCKETS,
  COMMITMENTS,
  racesFor,
  classesFor,
  specsFor,
  roleFor,
  colorFor,
  isProvisional,
} from "../config/game.js";

/** Sentinel for "the user hasn't answered off-spec yet". null means "None". */
const UNANSWERED = undefined;

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function select(id, value, options, onChange, { placeholder, disabled } = {}) {
  return el(
    "select",
    {
      id,
      class: "select",
      disabled: disabled || null,
      onChange: (e) => onChange(e.target.value === "" ? null : e.target.value),
    },
    placeholder !== undefined &&
      el("option", { value: "", selected: value == null || null }, placeholder),
    options.map((opt) => {
      const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
      return el("option", { value: val, selected: val === value || null }, label);
    })
  );
}

/** `label` may be a string or a node, so labels can carry links. */
function field(label, control, hint) {
  return el(
    "div",
    { class: "field" },
    el("span", { class: "label" }, label),
    control,
    hint && el("p", { class: "hint" }, hint)
  );
}

function labelWithLink(text, { name, url }) {
  return el(
    "span",
    { class: "label-row" },
    text,
    el(
      "a",
      { class: "label-link", href: url, target: "_blank", rel: "noopener noreferrer" },
      name,
      el("span", { "aria-hidden": "true" }, " ↗")
    )
  );
}

function levelBar(bucket, level) {
  const exact = Number.isFinite(level);
  const index = LEVEL_BUCKETS.indexOf(bucket);
  const pct = exact
    ? Math.max(4, (level / 60) * 100)
    : index < 0 ? 0 : ((index + 1) / LEVEL_BUCKETS.length) * 100;
  const done = exact ? level >= 60 : bucket === "60";
  return el(
    "div",
    { class: "level", title: exact ? t("char.levelFromBnet", { level }) : `Level ${bucket}` },
    el("span", { class: "level-text" }, exact ? `Lv ${level}` : bucket),
    el(
      "span",
      { class: "level-track" },
      el("span", {
        class: `level-fill ${done ? "is-max" : ""}`,
        style: { width: `${pct}%` },
      })
    )
  );
}

/**
 * Guild picker, offered only for guilds this user owns.
 *
 * Everyone else arrived through an invite and can reuse that link to bring
 * more characters. An owner has no invite to themselves, which is the gap
 * this closes — without it, creating a guild leaves you unable to join it.
 */
function guildPicker(character, onChange) {
  const owned = store.memberships.filter((m) => m.role === "owner");
  if (!owned.length) return null;

  const eligible = owned.filter((m) => m.faction === character.faction);
  if (!eligible.length) return null;

  const current = character.guildId || "";

  return el(
    "select",
    {
      class: "select select-sm",
      title: t("characters.guildPickerHint"),
      onChange: async (e) => {
        try {
          const res = await api.setCharacterGuild(character.id, e.target.value || null);
          store.setCharacters(res.characters);
          toast(
            e.target.value
              ? t("characters.joinedGuild", {
                  name: owned.find((m) => m.guildId === e.target.value)?.guildName,
                })
              : t("characters.leftGuild")
          );
          onChange();
        } catch (err) {
          const known = t(`error.${err.code}`);
          toast(known === `error.${err.code}` ? t("error.generic") : known);
        }
      },
    },
    el("option", { value: "", selected: !current || null }, t("characters.unguilded")),
    eligible.map((m) =>
      el(
        "option",
        { value: m.guildId, selected: m.guildId === current || null },
        m.guildName
      )
    )
  );
}

function characterCard(character, { onEdit, onDelete, onChange }) {
  const color = colorFor(character.class);
  const levelling = character.levellingSpec && character.levellingSpec !== character.spec;

  return el(
    "article",
    { class: "char-card", style: { "--class-color": color } },
    el(
      "div",
      { class: "char-head" },
      el(
        "div",
        { class: "stack grow" },
        el(
          "div",
          { class: "char-name-row" },
          el("strong", { class: "char-name truncate" }, fullName(character)),
          // Every character carries its commitment badge, Main included —
          // the one you actually raid on should be the loudest thing on the card.
          el(
            "span",
            { class: `badge badge-${character.commitment}` },
            t(`commitment.${character.commitment}`)
          ),
          character.raidReady && el("span", { class: "badge badge-ready" }, t("char.raidReady")),
          levelling &&
            el(
              "span",
              {
                class: "badge badge-levelling",
                title: t("char.levellingAs", { spec: character.levellingSpec }),
              },
              character.levellingSpec
            )
        ),
        el(
          "div",
          { class: "char-chips" },
          el("span", { class: "chip" }, character.race),
          el(
            "span",
            { class: "chip chip-class", style: { "--chip-color": color } },
            `${character.spec} ${character.class}`
          ),
          el("span", { class: "chip" }, character.role)
        )
      ),
      levelBar(character.levelBucket, character.level)
    ),

    el(
      "div",
      { class: "char-tags" },
      el("span", { class: "tag" }, `${character.region} ${character.realmType}`),
      el("span", { class: "tag" }, character.faction),
      character.bnetId &&
        el(
          "span",
          {
            class: "tag tag-bnet",
            title: character.levelSyncedAt
              ? t("char.bnetSyncedAt", { date: new Date(character.levelSyncedAt).toLocaleString() })
              : "",
          },
          "Battle.net"
        ),
      character.offSpec && el("span", { class: "tag tag-soft" }, `${t("char.offSpec")}: ${character.offSpec}`),
      guildPicker(character, onChange) ||
        el(
          "span",
          { class: "tag tag-soft" },
          store.memberships.find((m) => m.guildId === character.guildId)?.guildName ||
            t("characters.unguilded")
        )
    ),

    character.notes && el("p", { class: "char-notes" }, character.notes),

    el(
      "div",
      { class: "char-actions" },
      character.plannerUrl &&
        el(
          "a",
          {
            class: "btn btn-sm btn-ghost",
            href: character.plannerUrl,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          t("char.planner")
        ),
      el("span", { class: "grow" }),
      el("button", { class: "btn btn-sm", onClick: () => onEdit(character) }, t("common.edit")),
      el("button", { class: "btn btn-sm btn-danger-outline", onClick: () => onDelete(character) }, t("common.delete"))
    )
  );
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

const RESTORE_WINDOW_DAYS = 30;

function daysLeft(deletedAt) {
  const elapsed = Date.now() - new Date(deletedAt).getTime();
  const remaining = RESTORE_WINDOW_DAYS - Math.floor(elapsed / 86400000);
  return Math.max(0, remaining);
}

function expiryLabel(deletedAt) {
  const days = daysLeft(deletedAt);
  if (days <= 0) return t("characters.expiresToday");
  if (days === 1) return t("characters.expiresTomorrow");
  return t("characters.expiresIn", { days });
}

function restoreSection(deleted, onRestore) {
  return el(
    "section",
    { class: "card restore-card" },
    el("h2", { class: "card-title" }, t("characters.restoreTitle")),
    el(
      "p",
      { class: "banner banner-info", style: { marginTop: "8px" } },
      t("characters.restoreWarning", { days: RESTORE_WINDOW_DAYS })
    ),
    el(
      "div",
      { class: "restore-list" },
      deleted.map((c) =>
        el(
          "div",
          { class: "restore-row", style: { "--class-color": colorFor(c.class) } },
          el(
            "div",
            { class: "stack grow" },
            el("strong", { class: "truncate" }, fullName(c)),
            el(
              "span",
              { class: "muted", style: { fontSize: "12.5px" } },
              `${c.race} · ${c.spec} ${c.class}`
            )
          ),
          el("span", { class: "restore-expiry" }, expiryLabel(c.deletedAt)),
          el(
            "button",
            { class: "btn btn-sm", onClick: () => onRestore(c) },
            t("characters.restore")
          )
        )
      )
    )
  );
}

/* ------------------------------------------------------------------ *
 * Form
 * ------------------------------------------------------------------ */

function blankCharacter() {
  return {
    firstName: "",
    lastName: "",
    faction: null,
    race: null,
    class: null,
    spec: null,
    offSpec: UNANSWERED, // must be answered; null is a valid answer
    levellingSpec: null,
    region: "EU",
    realmType: "PvE",
    commitment: "primary",
    levelBucket: "1-19",
    plannerUrl: "",
    notes: "",
  };
}

function openCharacterForm(existing, onSaved) {
  // An existing character has already answered off-spec, even if the answer
  // was "none" — so null stays null rather than reverting to unanswered.
  const draft = existing ? { ...existing } : blankCharacter();
  const isEdit = Boolean(existing);
  let invalid = new Set();

  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body" });

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);

  async function save() {
    const payload = {
      ...draft,
      offSpec: draft.offSpec || null,
      levellingSpec: draft.levellingSpec || draft.spec || null,
      plannerUrl: draft.plannerUrl || null,
    };
    try {
      const res = isEdit
        ? await api.updateCharacter(existing.id, payload)
        : await api.createCharacter(payload);
      store.setCharacters(res.characters);
      toast(t(isEdit ? "characters.updated" : "characters.created"));
      close();
      onSaved();
    } catch (err) {
      if (err.code === "validation") {
        invalid = new Set(err.payload?.fields || []);
        render();
        toast(t("error.validation"));
      } else {
        const known = t(`error.${err.code}`);
        toast(known === `error.${err.code}` ? t("error.generic") : known);
      }
    }
  }

  function set(patch) {
    Object.assign(draft, patch);
    render();
  }

  function render() {
    const races = draft.faction ? racesFor(draft.faction) : [];
    const classes = draft.race ? classesFor(draft.race, draft.faction) : [];
    const specs = draft.class ? specsFor(draft.class) : [];
    const offSpecs = specs.filter((s) => s !== draft.spec);
    const role = draft.class && draft.spec ? roleFor(draft.class, draft.spec) : null;

    // Blizzard owns race, class, faction and level once a character is tied.
    const locked = Boolean(draft.bnetId);

    const offSpecAnswered = draft.offSpec !== UNANSWERED;
    const canSave = offSpecAnswered;
    const bad = (f) => (invalid.has(f) ? "is-invalid" : "");

    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el("h2", { class: "modal-title" }, t(isEdit ? "characters.edit" : "characters.new")),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close, "aria-label": t("common.cancel") }, "✕")
      ),

      el(
        "div",
        { class: "modal-scroll" },

        /* Identity ---------------------------------------------------- */
        // Forever gives every character a first name and a surname, and
        // uniqueness is on the pair. Surname stays optional until name
        // reservation opens on 27 October.
        el(
          "div",
          { class: "field-row" },
          field(
            t("char.firstName"),
            el("input", {
              class: `input ${bad("firstName")}`,
              value: draft.firstName || "",
              placeholder: t("char.firstNamePlaceholder"),
              maxlength: "12",
              onInput: (e) => (draft.firstName = e.target.value),
            })
          ),
          field(
            `${t("char.lastName")} (${t("common.optional")})`,
            el("input", {
              class: "input",
              value: draft.lastName || "",
              placeholder: t("char.lastNamePlaceholder"),
              // 16 is a guess — Blizzard has only said "a single word". If a
              // real limit appears, change it here AND in validateCharacter
              // in the worker.
              maxlength: "16",
              onInput: (e) => (draft.lastName = e.target.value),
            })
          )
        ),
        el("p", { class: "hint", style: { marginTop: "-8px" } }, t("char.nameHint")),

        /* The dependency chain: faction → race → class → spec ---------- */
        field(
          t("char.faction"),
          select(
            "f-faction",
            draft.faction,
            FACTIONS,
            (v) =>
              set({
                faction: v,
                race: null,
                class: null,
                spec: null,
                offSpec: UNANSWERED,
                levellingSpec: null,
              }),
            { placeholder: "—", disabled: locked }
          ),
          locked ? t("char.lockedByBnet") : null
        ),

        field(
          t("char.race"),
          select(
            "f-race",
            draft.race,
            races,
            (v) =>
              set({
                race: v,
                class: null,
                spec: null,
                offSpec: UNANSWERED,
                levellingSpec: null,
              }),
            {
              placeholder: draft.faction ? "—" : t("char.pickFactionFirst"),
              disabled: !draft.faction || locked,
            }
          )
        ),

        field(
          t("char.class"),
          select(
            "f-class",
            draft.class,
            classes,
            (v) => set({ class: v, spec: null, offSpec: UNANSWERED, levellingSpec: null }),
            {
              placeholder: draft.race ? "—" : t("char.pickRaceFirst"),
              disabled: !draft.race || locked,
            }
          ),
          draft.class && isProvisional(draft.class) ? t("char.provisional") : null
        ),

        /* The three specs --------------------------------------------- */
        field(
          t("char.spec"),
          select(
            "f-spec",
            draft.spec,
            specs,
            (v) =>
              set({
                spec: v,
                // Clear an off-spec that just became the main spec.
                offSpec: draft.offSpec === v ? UNANSWERED : draft.offSpec,
                // Levelling spec follows the main spec until changed.
                levellingSpec: draft.levellingSpec || v,
              }),
            {
              placeholder: draft.class ? "—" : t("char.pickClassFirst"),
              disabled: !draft.class,
            }
          ),
          role ? `${t("char.specHint")} ${t("char.role")}: ${role}` : t("char.specHint")
        ),

        field(
          t("char.offSpec"),
          select(
            "f-offspec",
            offSpecAnswered ? draft.offSpec : null,
            [["__none__", t("char.offSpecNone")], ...offSpecs],
            (v) => set({ offSpec: v === "__none__" ? null : v }),
            {
              placeholder: offSpecAnswered ? undefined : t("char.offSpecChoose"),
              disabled: !draft.spec,
            }
          ),
          t("char.offSpecHint")
        ),

        field(
          t("char.levellingSpec"),
          select(
            "f-levelspec",
            draft.levellingSpec,
            specs,
            (v) => set({ levellingSpec: v }),
            {
              placeholder: draft.class ? "—" : t("char.pickClassFirst"),
              disabled: !draft.class,
            }
          ),
          t("char.levellingSpecHint")
        ),

        /* Where they play --------------------------------------------- */
        el(
          "div",
          { class: "field-row" },
          field(t("char.region"), select("f-region", draft.region, REGIONS, (v) => set({ region: v }))),
          field(t("char.realmType"), select("f-realm", draft.realmType, REALM_TYPES, (v) => set({ realmType: v })))
        ),

        el(
          "div",
          { class: "field-row" },
          field(
            t("char.commitment"),
            select(
              "f-commit",
              draft.commitment,
              COMMITMENTS.map((c) => [c, t(`commitment.${c}`)]),
              (v) => set({ commitment: v })
            )
          ),
          locked && Number.isFinite(draft.level)
            ? field(
                t("char.level"),
                el("input", { class: "input", value: `${draft.level}`, disabled: true }),
                t("char.levelFromBnetHint")
              )
            : field(t("char.level"), select("f-level", draft.levelBucket, LEVEL_BUCKETS, (v) => set({ levelBucket: v })))
        ),

        el("p", { class: "hint", style: { marginTop: "-8px" } }, t(`commitment.${draft.commitment}Hint`)),

        /* Extras ------------------------------------------------------ */
        field(
          labelWithLink(`${t("char.planner")} (${t("common.optional")})`, APP.gearPlanner),
          el("input", {
            class: "input",
            type: "url",
            value: draft.plannerUrl || "",
            placeholder: t("char.plannerPlaceholder"),
            onInput: (e) => (draft.plannerUrl = e.target.value),
          }),
          t("char.plannerHint")
        ),

        field(
          `${t("char.notes")} (${t("common.optional")})`,
          el("textarea", {
            class: "input",
            rows: "2",
            value: draft.notes || "",
            placeholder: t("char.notesPlaceholder"),
            maxlength: "300",
            onInput: (e) => (draft.notes = e.target.value),
          })
        )
      ),

      el(
        "div",
        { class: "modal-foot" },
        !canSave && el("span", { class: "foot-note" }, t("char.answerOffSpec")),
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel")),
        el(
          "button",
          { class: "btn btn-primary", disabled: !canSave || null, onClick: save },
          t("common.save")
        )
      )
    );
  }

  render();
  overlay.append(body);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  body.querySelector("input")?.focus();
}

/* ------------------------------------------------------------------ *
 * Battle.net import
 * ------------------------------------------------------------------ */

const isForever = (c) => /^profile-(classic)?forever-/.test(c.namespace || "");

function connectBnet() {
  window.location.href = api.linkUrl("battlenet", "/me/characters");
}

function openImport(onDone) {
  const user = store.user || {};
  const live = (store.characters || []).filter((c) => !c.deletedAt);
  const claimed = new Set(live.map((c) => c.bnetId).filter(Boolean));
  const available = (user.wowCharacters || [])
    .filter((c) => isForever(c) && !claimed.has(c.id))
    .sort((a, b) => (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name));

  // Default ruleset: whatever most of their characters already use.
  const counts = {};
  for (const c of live) counts[c.realmType] = (counts[c.realmType] || 0) + 1;
  let realmType = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "PvE";

  const picks = new Map(); // bnetId -> { spec, lastName }
  let busy = false;

  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body modal-wide" });
  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);

  async function submit() {
    busy = true;
    render();
    try {
      const res = await api.importCharacters({
        realmType,
        characters: [...picks].map(([bnetId, p]) => ({ bnetId, ...p })),
      });
      store.setCharacters(res.characters);
      toast(t("characters.imported", { count: res.created }));
      close();
      onDone();
    } catch (err) {
      busy = false;
      const known = t(`error.${err.code}`);
      toast(known === `error.${err.code}` ? t("error.generic") : known);
      render();
    }
  }

  function row(b) {
    const pick = picks.get(b.id);
    const color = colorFor(b.class);
    return el(
      "div",
      { class: `import-row ${pick ? "is-picked" : ""}`, style: { "--class-color": color } },
      el(
        "label",
        { class: "import-main" },
        el("input", {
          type: "checkbox",
          checked: pick ? true : null,
          onChange: (e) => {
            if (e.target.checked) picks.set(b.id, { spec: null, lastName: "" });
            else picks.delete(b.id);
            render();
          },
        }),
        el(
          "span",
          { class: "stack grow" },
          el("strong", {}, b.name),
          el("span", { class: "muted", style: { fontSize: "12px" } }, `${b.race} ${b.class} · ${b.faction}`)
        ),
        el("span", { class: "level-text" }, `Lv ${b.level ?? "?"}`)
      ),
      pick &&
        el(
          "div",
          { class: "import-fields" },
          select(`imp-spec-${b.id}`, pick.spec, specsFor(b.class), (v) => {
            pick.spec = v;
            render();
          }, { placeholder: t("characters.importPickSpec") }),
          el("input", {
            class: "input",
            value: pick.lastName,
            maxlength: "16",
            placeholder: `${t("char.lastName")} (${t("common.optional")})`,
            onInput: (e) => (pick.lastName = e.target.value),
          })
        )
    );
  }

  function render() {
    const missingSpec = [...picks.values()].some((p) => !p.spec);
    const canImport = picks.size > 0 && !missingSpec && !busy;

    let content;
    if (!user.battlenetId) {
      content = el(
        "div",
        { class: "empty" },
        el("p", { style: { margin: "0 0 12px" } }, t("characters.importConnect")),
        el("button", { class: "btn btn-bnet", onClick: connectBnet }, t("welcome.connect"))
      );
    } else if (!available.length) {
      const anyForever = (user.wowCharacters || []).some(isForever);
      content = el(
        "div",
        { class: "empty" },
        el("p", { style: { margin: "0 0 6px" } }, t(anyForever ? "characters.importAllDone" : "characters.importNone")),
        el("p", { class: "muted", style: { margin: 0, fontSize: "13px" } }, t("characters.importRefreshHint"))
      );
    } else {
      content = [
        el("p", { class: "hint", style: { margin: "0 0 14px" } }, t("characters.importIntro")),
        field(
          t("char.realmType"),
          select("imp-realm", realmType, REALM_TYPES, (v) => {
            realmType = v;
            render();
          }),
          t("characters.importRealmHint")
        ),
        el("div", { class: "import-list" }, available.map(row)),
      ];
    }

    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el("h2", { class: "modal-title" }, t("characters.importTitle")),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close, "aria-label": t("common.cancel") }, "✕")
      ),
      el("div", { class: "modal-scroll" }, content),
      el(
        "div",
        { class: "modal-foot" },
        user.battlenetId &&
          el("button", { class: "btn-link", onClick: connectBnet }, t("characters.importRefresh")),
        picks.size > 0 && missingSpec && el("span", { class: "foot-note" }, t("characters.importNeedSpec")),
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel")),
        available.length > 0 &&
          user.battlenetId &&
          el(
            "button",
            { class: "btn btn-primary", disabled: !canImport || null, onClick: submit },
            t("characters.importAction", { count: picks.size })
          )
      )
    );
  }

  render();
  overlay.append(body);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
}

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

export function renderCharacters(root) {
  function refresh() {
    render();
  }

  // Back from a Battle.net check: refresh state, say what happened, and
  // open the import list if there's something new to add.
  const linkResult = new URLSearchParams(location.hash.split("?")[1] || "").get("link");
  if (linkResult) {
    history.replaceState(null, "", `${location.pathname}#/me/characters`);
    if (linkResult === "ok") {
      api.me().then((me) => {
        store.hydrate(me);
        render();
        const synced = (me.characters || []).filter((c) => c.bnetId && !c.deletedAt).length;
        toast(t("characters.bnetChecked", { count: synced }));
        const live = new Set((me.characters || []).filter((c) => !c.deletedAt).map((c) => c.bnetId));
        const fresh = (me.user?.wowCharacters || []).some((c) => isForever(c) && !live.has(c.id));
        if (fresh) openImport(refresh);
      });
    } else {
      const key = `profile.link_${linkResult}`;
      toast(t(key) === key ? t("error.generic") : t(key));
    }
  }

  async function remove(character) {
    const message = t("characters.deleteConfirm", {
      name: fullName(character),
      days: RESTORE_WINDOW_DAYS,
    });
    if (!confirm(message)) return;
    try {
      const res = await api.deleteCharacter(character.id);
      store.setCharacters(res.characters);
      toast(t("characters.deleted"));
      render();
    } catch {
      toast(t("error.generic"));
    }
  }

  async function restore(character) {
    try {
      const res = await api.restoreCharacter(character.id);
      store.setCharacters(res.characters);
      toast(t("characters.restored"));
      render();
    } catch {
      toast(t("error.generic"));
    }
  }

  function render() {
    const all = store.characters || [];
    const characters = all.filter((c) => !c.deletedAt);
    const deleted = all
      .filter((c) => c.deletedAt)
      .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));

    const order = { primary: 0, secondary: 1, alt: 2 };
    const sorted = [...characters].sort(
      (a, b) => (order[a.commitment] ?? 9) - (order[b.commitment] ?? 9) || byName(a, b)
    );

    mount(
      root,
      el(
        "div",
        { class: "page-head row-between" },
        el(
          "div",
          {},
          el("h1", { class: "page-title" }, t("characters.title")),
          el(
            "p",
            { class: "page-sub" },
            characters.length === 0
              ? t("characters.sub")
              : characters.length === 1
              ? t("characters.countOne")
              : t("characters.count", { count: characters.length })
          )
        ),
        el(
          "div",
          { class: "row", style: { gap: "8px" } },
          el(
            "button",
            { class: "btn", onClick: () => openImport(refresh) },
            t("characters.importButton")
          ),
          el(
            "button",
            { class: "btn btn-primary", onClick: () => openCharacterForm(null, refresh) },
            t("characters.add")
          )
        )
      ),

      characters.length === 0
        ? el(
            "div",
            { class: "empty" },
            el("p", { style: { margin: "0 0 6px" } }, t("characters.empty")),
            el("p", { class: "muted", style: { margin: 0, fontSize: "13px" } }, t("characters.emptyHint"))
          )
        : el(
            "div",
            { class: "char-grid" },
            sorted.map((c) =>
              characterCard(c, {
                onEdit: (ch) => openCharacterForm(ch, refresh),
                onDelete: remove,
                onChange: refresh,
              })
            )
          ),

      deleted.length > 0 && restoreSection(deleted, restore)
    );
  }

  render();
}
