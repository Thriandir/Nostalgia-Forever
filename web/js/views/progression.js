import { el, mount, toast } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { store } from "../core/store.js";
import { shortName, fullName, firstNameOf } from "../core/names.js";
import {
  allSpecsByRole,
  colorFor,
  isHybrid,
  shortRace,
  LEVEL_BUCKETS,
} from "../config/game.js";

/**
 * The progression board.
 *
 * Two halves that are really one instrument:
 *
 *   Top     the ideal composition — what the guild is building toward.
 *           Admin-defined, no player names. Slots are a flat ordered list
 *           sliced into parties of five, so a 40-man's first two parties
 *           ARE the 10-man comp.
 *
 *   Bottom  who is actually levelling what, grouped into Tank/Healer/DPS
 *           bands and sorted by biggest shortfall first, so the specs the
 *           guild is short of sit leftmost and the social pressure points
 *           the right way.
 *
 * The number that matters is the delta between the two. Everything else is
 * supporting detail.
 *
 * Counts are derived from the guild's character snapshot on every render —
 * never stored. Change your primary spec and you move columns immediately.
 */

const PARTY_SIZE = 5;
const RAID_SIZES = [10, 20, 40];

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

function specKey(className, spec) {
  return `${className}|${spec}`;
}

/** How many of each class+spec the ideal comp asks for. */
function demandOf(comp) {
  const demand = new Map();
  for (const slot of comp?.slots || []) {
    if (!slot) continue;
    const key = specKey(slot.class, slot.spec);
    demand.set(key, (demand.get(key) || 0) + 1);
  }
  return demand;
}

/**
 * Who has declared each class+spec.
 *
 * Only primaries count unless `includeAlts` — one person levelling four alts
 * would otherwise make the guild look far healthier than it is.
 *
 * With `includeOffSpec`, a character also appears under whatever they named
 * as their off-spec, flagged so it never gets confused with real supply. A
 * Frost Mage with Fire off-spec is not a Fire Mage; they're someone who
 * could become one if asked, which is a different and weaker fact.
 */
function supplyOf(characters, { includeAlts, includeOffSpec }) {
  const supply = new Map();

  const add = (key, character, viaOffSpec) => {
    if (!supply.has(key)) supply.set(key, []);
    supply.get(key).push({ ...character, viaOffSpec });
  };

  for (const c of characters) {
    if (!includeAlts && c.commitment !== "primary") continue;
    add(specKey(c.class, c.spec), c, false);
    if (includeOffSpec && c.offSpec) add(specKey(c.class, c.offSpec), c, true);
  }

  for (const list of supply.values()) {
    list.sort(
      (a, b) =>
        // Real supply above potential supply, then furthest along first —
        // the people closest to raiding matter most.
        Number(a.viaOffSpec) - Number(b.viaOffSpec) ||
        LEVEL_BUCKETS.indexOf(b.levelBucket) - LEVEL_BUCKETS.indexOf(a.levelBucket) ||
        firstNameOf(a).localeCompare(firstNameOf(b))
    );
  }
  return supply;
}

/** Primary-spec entries only — the number that actually means something. */
function realCount(list) {
  return list.filter((c) => !c.viaOffSpec).length;
}
function offSpecCount(list) {
  return list.filter((c) => c.viaOffSpec).length;
}

/* ------------------------------------------------------------------ *
 * Ideal composition — top half
 * ------------------------------------------------------------------ */

function slotBox(slot, index, { canEdit, onDragStart, onDrop, onClear }) {
  if (!slot) {
    return el("div", {
      class: "slot slot-empty",
      dataset: { index: String(index) },
      ondragover: canEdit ? (e) => e.preventDefault() : null,
      ondrop: canEdit ? (e) => onDrop(e, index) : null,
      title: t("prog.emptySlot"),
    });
  }

  const color = colorFor(slot.class);
  return el(
    "div",
    {
      class: "slot",
      style: { "--class-color": color },
      dataset: { index: String(index) },
      draggable: canEdit ? "true" : null,
      title: `${slot.spec} ${slot.class}`,
      ondragstart: canEdit ? (e) => onDragStart(e, index) : null,
      ondragover: canEdit ? (e) => e.preventDefault() : null,
      ondrop: canEdit ? (e) => onDrop(e, index) : null,
      onDblclick: canEdit ? () => onClear(index) : null,
    },
    el("span", { class: "slot-spec" }, slot.spec),
    el("span", { class: "slot-class" }, slot.class)
  );
}

function compGrid(comp, handlers) {
  const parties = [];
  for (let i = 0; i < comp.size; i += PARTY_SIZE) {
    parties.push({
      index: i / PARTY_SIZE,
      slots: comp.slots.slice(i, i + PARTY_SIZE),
      offset: i,
    });
  }

  return el(
    "div",
    { class: "comp-grid" },
    parties.map((party) =>
      el(
        "div",
        { class: "party" },
        el("span", { class: "party-label" }, t("prog.party", { n: party.index + 1 })),
        el(
          "div",
          { class: "party-slots" },
          party.slots.map((slot, i) => slotBox(slot, party.offset + i, handlers))
        )
      )
    )
  );
}

/* ------------------------------------------------------------------ *
 * Spec columns — bottom half
 * ------------------------------------------------------------------ */

function levelPip(bucket) {
  const index = LEVEL_BUCKETS.indexOf(bucket);
  const pct = index < 0 ? 0 : ((index + 1) / LEVEL_BUCKETS.length) * 100;
  return el(
    "span",
    { class: "pip", title: `Level ${bucket}` },
    el("span", { class: `pip-fill ${bucket === "60" ? "is-max" : ""}`, style: { width: `${pct}%` } })
  );
}

function playerRow(c, roster) {
  const levelling = c.levellingSpec && c.levellingSpec !== c.spec;
  const classes = ["prog-player"];
  if (c.commitment !== "primary") classes.push("is-alt");
  if (c.viaOffSpec) classes.push("is-offspec");

  return el(
    "div",
    { class: classes.join(" ") },
    el(
      "div",
      { class: "prog-player-top" },
      // Off-spec entries are marked before the name, so the eye catches the
      // qualifier before it reads the person as available.
      c.viaOffSpec &&
        el(
          "span",
          { class: "offspec-mark", title: t("prog.offSpecOf", { spec: c.spec }) },
          t("prog.offSpecShort")
        ),
      el(
        "span",
        { class: "prog-name truncate", title: `${fullName(c)}${c.ownerName ? ` · ${c.ownerName}` : ""}` },
        shortName(c, roster)
      ),
      // Race as a badge rather than a cryptic three-letter prefix. The full
      // name is on hover, which is enough for something this peripheral.
      el("span", { class: "race-badge", title: c.race }, shortRace(c.race)),
      c.raidReady && el("span", { class: "dot dot-ready", title: t("char.raidReady") }),
      levelling &&
        el(
          "span",
          { class: "dot dot-levelling", title: t("char.levellingAs", { spec: c.levellingSpec }) }
        ),
      c.offSpec && el("span", { class: "dot dot-offspec", title: `${t("char.offSpec")}: ${c.offSpec}` })
    ),
    el(
      "div",
      { class: "prog-player-bottom" },
      levelPip(c.levelBucket),
      el("span", { class: "prog-level" }, c.levelBucket)
    )
  );
}

/** Shared by the column and the chip — the delta is judged on real supply. */
function columnState(have, need) {
  const real = realCount(have);
  const delta = real - need;
  if (need === 0) return "unwanted";
  if (delta < 0) return "short";
  if (delta > 0) return "over";
  return "met";
}

/**
 * The compact rendering: spec, class, count. No player list.
 *
 * Used in two places — a collapsed band, and any band when the board is in
 * compact density. One component rather than two keeps them consistent, and
 * a collapsed band showing nothing at all was wasted space.
 */
function specChip({ className, spec, color }, have, need) {
  const real = realCount(have);
  const extra = offSpecCount(have);

  return el(
    "div",
    {
      class: `spec-chip is-${columnState(have, need)}`,
      style: { "--class-color": color },
      title: `${spec} ${className}`,
    },
    el(
      "div",
      { class: "stack grow" },
      el("span", { class: "chip-spec truncate" }, spec),
      el("span", { class: "chip-class truncate" }, className)
    ),
    el("span", { class: "chip-count" }, need > 0 ? `${real}/${need}` : String(real)),
    extra > 0 && el("span", { class: "chip-extra" }, `+${extra}`)
  );
}

function specColumn({ className, spec, color }, have, need) {
  // The state is judged on real supply only. Three people who *could* respec
  // don't make a shortfall green — they make it a shortfall with options.
  const real = realCount(have);
  const extra = offSpecCount(have);
  const delta = real - need;

  let state = "met";
  if (need > 0 && delta < 0) state = "short";
  else if (delta > 0 && need > 0) state = "over";
  else if (need === 0) state = "unwanted";

  return el(
    "div",
    { class: `spec-col is-${state}`, style: { "--class-color": color } },
    el(
      "div",
      { class: "spec-head" },
      el("span", { class: "spec-name truncate" }, spec),
      el("span", { class: "spec-class truncate" }, className),
      el(
        "span",
        { class: "spec-count-wrap" },
        el("span", { class: "spec-count" }, need > 0 ? `${real}/${need}` : String(real)),
        extra > 0 &&
          el(
            "span",
            { class: "spec-extra", title: t("prog.offSpecAvailable", { count: extra }) },
            `+${extra}`
          )
      )
    ),
    el(
      "div",
      { class: "spec-players" },
      have.length
        ? have.map((c) => playerRow(c, have))
        : el("span", { class: "spec-nobody" }, t("prog.nobody"))
    )
  );
}

/* ------------------------------------------------------------------ *
 * Composition editor
 * ------------------------------------------------------------------ */

function openCompEditor(comp, onSave) {
  const draft = {
    size: comp.size,
    counts: new Map(),
  };
  for (const [key, n] of demandOf(comp)) draft.counts.set(key, n);

  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body modal-wide" });

  // Refs for in-place updates. Re-rendering the whole modal on every +/−
  // would reset the scroll position, which makes picking DPS at the bottom
  // of the list impossible.
  const rowRefs = new Map();
  let totalEl = null;

  function close() {
    overlay.remove();
  }

  function total() {
    let n = 0;
    for (const v of draft.counts.values()) n += v;
    return n;
  }

  function updateTotal() {
    if (!totalEl) return;
    const used = total();
    totalEl.textContent = `${used} / ${draft.size}`;
    totalEl.classList.toggle("is-over", used > draft.size);
  }

  function bump(key, delta) {
    if (delta > 0 && total() >= draft.size) return;

    const next = Math.max(0, (draft.counts.get(key) || 0) + delta);
    if (next === 0) draft.counts.delete(key);
    else draft.counts.set(key, next);

    const ref = rowRefs.get(key);
    if (ref) {
      ref.count.textContent = String(next);
      ref.row.classList.toggle("is-set", next > 0);
    }
    updateTotal();
  }

  /**
   * Apply the counts to the EXISTING arrangement rather than rebuilding it.
   *
   * Rebuilding from scratch destroyed any party layout the admin had dragged
   * into place, which made the editor actively hostile: bumping one number
   * reshuffled the whole raid. So this diffs instead — removes surplus,
   * places additions into empty slots, and leaves everything else alone.
   */
  function buildSlots() {
    const size = draft.size;
    const slots = (comp.slots || []).slice(0, size);
    while (slots.length < size) slots.push(null);

    // Where each spec currently sits.
    const placed = new Map();
    slots.forEach((slot, i) => {
      if (!slot) return;
      const key = specKey(slot.class, slot.spec);
      if (!placed.has(key)) placed.set(key, []);
      placed.get(key).push(i);
    });

    // Drop surplus, taking from the back so earlier parties keep their people.
    for (const [key, indices] of placed) {
      const want = draft.counts.get(key) || 0;
      for (let i = indices.length - 1; i >= want; i--) slots[indices[i]] = null;
    }

    // Place additions in whichever party has the most room, so multiples of
    // a spec spread out instead of stacking into party one.
    const partyCount = size / PARTY_SIZE;
    const freeIn = (p) =>
      slots.slice(p * PARTY_SIZE, (p + 1) * PARTY_SIZE).filter((s) => !s).length;

    for (const [key, want] of draft.counts) {
      const already = Math.min(placed.get(key)?.length || 0, want);
      const [className, spec] = key.split("|");

      for (let n = already; n < want; n++) {
        let best = -1;
        let bestFree = 0;
        for (let p = 0; p < partyCount; p++) {
          const free = freeIn(p);
          if (free > bestFree) {
            bestFree = free;
            best = p;
          }
        }
        if (best === -1) break; // raid is full

        const offset = slots
          .slice(best * PARTY_SIZE, (best + 1) * PARTY_SIZE)
          .findIndex((s) => !s);
        slots[best * PARTY_SIZE + offset] = { class: className, spec };
      }
    }

    return slots;
  }

  async function save() {
    await onSave({ size: draft.size, slots: buildSlots() });
    close();
  }

  function render() {
    const byRole = allSpecsByRole();
    const used = total();
    rowRefs.clear();
    totalEl = el(
      "span",
      { class: `comp-total ${used > draft.size ? "is-over" : ""}` },
      `${used} / ${draft.size}`
    );

    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el("h2", { class: "modal-title" }, t("prog.editComp")),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close }, "✕")
      ),
      el(
        "div",
        { class: "modal-scroll" },
        el(
          "div",
          { class: "row", style: { marginBottom: "16px" } },
          el("span", { class: "label", style: { margin: 0 } }, t("prog.raidSize")),
          el(
            "div",
            { class: "segmented" },
            RAID_SIZES.map((size) =>
              el(
                "button",
                {
                  type: "button",
                  "aria-pressed": String(size === draft.size),
                  onClick: () => {
                    draft.size = size;
                    render();
                  },
                },
                String(size)
              )
            )
          ),
          el("span", { class: "grow" }),
          totalEl
        ),

        ["Tank", "Healer", "DPS"].map((role) =>
          el(
            "div",
            { class: "count-band" },
            el("h3", { class: "band-title" }, t(`role.${role.toLowerCase()}`)),
            el(
              "div",
              { class: "count-list" },
              byRole[role].map(({ className, spec, color }) => {
                const key = specKey(className, spec);
                const n = draft.counts.get(key) || 0;
                const count = el("span", { class: "count-n" }, String(n));
                const row = el(
                  "div",
                  { class: `count-row ${n ? "is-set" : ""}`, style: { "--class-color": color } },
                  el(
                    "div",
                    { class: "stack grow" },
                    el("strong", { class: "count-spec" }, spec),
                    el("span", { class: "count-class" }, className)
                  ),
                  el("button", { class: "step", onClick: () => bump(key, -1) }, "−"),
                  count,
                  el("button", { class: "step", onClick: () => bump(key, 1) }, "+")
                );
                rowRefs.set(key, { row, count });
                return row;
              })
            )
          )
        )
      ),
      el(
        "div",
        { class: "modal-foot" },
        el("span", { class: "foot-note" }, t("prog.editHint")),
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel")),
        el("button", { class: "btn btn-primary", onClick: save }, t("common.save"))
      )
    );
  }

  render();
  overlay.append(body);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  document.body.append(overlay);
}

/* ------------------------------------------------------------------ *
 * Saved compositions
 * ------------------------------------------------------------------ */

function openCompLibrary({ compositions, current, onLoad, onSave, onDelete }) {
  let name = "";
  let list = [...(compositions || [])];

  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body" });

  function close() {
    overlay.remove();
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast(t("prog.compNameRequired"));
      return;
    }
    try {
      list = await onSave(trimmed);
      name = "";
      render();
    } catch (err) {
      // Previously this threw into a void and the button just did nothing,
      // which reads as "the app is broken" rather than "that failed".
      const known = t(`error.${err.code}`);
      toast(known === `error.${err.code}` ? t("error.generic") : known);
    }
  }

  async function remove(comp) {
    if (!confirm(t("prog.deleteCompConfirm", { name: comp.name }))) return;
    try {
      list = await onDelete(comp.id);
      render();
    } catch {
      toast(t("error.generic"));
    }
  }

  /** A one-line read of what a saved comp contains, e.g. "3T · 9H · 28D". */
  function shape(comp) {
    const counts = { Tank: 0, Healer: 0, DPS: 0 };
    for (const slot of comp.slots || []) if (slot?.role) counts[slot.role]++;
    return `${comp.size} · ${counts.Tank}T ${counts.Healer}H ${counts.DPS}D`;
  }

  function render() {
    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el("h2", { class: "modal-title" }, t("prog.savedComps")),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close }, "✕")
      ),
      el(
        "div",
        { class: "modal-scroll" },
        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("prog.saveCurrentAs")),
          el(
            "div",
            { class: "row" },
            el("input", {
              class: "input grow",
              value: name,
              placeholder: t("prog.compNamePlaceholder"),
              maxlength: "40",
              onInput: (e) => (name = e.target.value),
              onKeydown: (e) => e.key === "Enter" && save(),
            }),
            el("button", { class: "btn", onClick: save }, t("common.save"))
          ),
          el("p", { class: "hint" }, t("prog.saveCurrentHint", { shape: shape(current) }))
        ),

        el("div", { class: "menu-sep", style: { margin: "16px 0" } }),

        list.length === 0
          ? el(
              "div",
              { class: "empty", style: { padding: "22px" } },
              el("p", { style: { margin: 0, fontSize: "13px" } }, t("prog.noSavedComps"))
            )
          : el(
              "div",
              { class: "comp-library" },
              list.map((comp) =>
                el(
                  "div",
                  { class: "comp-saved" },
                  el(
                    "div",
                    { class: "stack grow" },
                    el("strong", { class: "truncate" }, comp.name),
                    el("span", { class: "muted", style: { fontSize: "12px" } }, shape(comp))
                  ),
                  el(
                    "button",
                    {
                      class: "btn btn-sm",
                      onClick: () => {
                        onLoad(comp);
                        close();
                      },
                    },
                    t("prog.load")
                  ),
                  el(
                    "button",
                    { class: "btn btn-sm btn-danger-outline", onClick: () => remove(comp) },
                    t("common.delete")
                  )
                )
              )
            )
      ),
      el(
        "div",
        { class: "modal-foot" },
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel"))
      )
    );
  }

  render();
  overlay.append(body);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  document.body.append(overlay);
}

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

const COLLAPSE_KEY = "nf_prog_collapsed";
const DENSITY_KEY = "nf_prog_density";

/**
 * Order spec columns so a class's specs sit together, with the class blocks
 * themselves ordered by combined shortfall.
 *
 * Sorting every spec independently by shortfall scatters a class across the
 * row — Arcane fourth, Fire tenth, Frost eleventh — which is accurate but
 * unreadable. Grouping keeps Mage together while still drifting the classes
 * you're short of toward the left, so the board keeps its point.
 *
 * DPS additionally keeps pure classes ahead of hybrids.
 */
function groupByClass(columns, { pureFirst }) {
  const groups = new Map();
  for (const col of columns) {
    const key = col.entry.className;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(col);
  }

  const ordered = [...groups.entries()].map(([className, cols]) => ({
    className,
    cols: cols.sort(
      (a, b) =>
        realCount(a.have) - a.need - (realCount(b.have) - b.need) ||
        b.need - a.need ||
        a.entry.spec.localeCompare(b.entry.spec)
    ),
    delta: cols.reduce((n, c) => n + (realCount(c.have) - c.need), 0),
    need: cols.reduce((n, c) => n + c.need, 0),
  }));

  ordered.sort((a, b) => {
    if (pureFirst) {
      const byKind = Number(isHybrid(a.className)) - Number(isHybrid(b.className));
      if (byKind) return byKind;
    }
    return a.delta - b.delta || b.need - a.need || a.className.localeCompare(b.className);
  });

  return ordered;
}

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* a lost preference is not worth an error */
  }
}

export function renderProgression(root, guildId) {
  let data = null;
  let failure = null;
  let includeAlts = false;
  let includeOffSpec = false;
  let dragFrom = null;
  const collapsed = loadCollapsed();
  let density = localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";

  const canEdit = () => data && (data.role === "owner" || data.role === "admin");

  async function load() {
    try {
      data = await api.guild(guildId);
      if (!data.guild.idealComp) {
        data.guild.idealComp = { size: 40, slots: Array(40).fill(null) };
      }
    } catch (err) {
      failure = err.code;
    }
    render();
  }

  async function persistComp(comp) {
    try {
      const res = await api.setGuildComp(guildId, comp);
      data.guild.idealComp = res.idealComp;
      toast(t("prog.compSaved"));
      render();
    } catch {
      toast(t("error.generic"));
    }
  }

  function onDragStart(e, index) {
    dragFrom = index;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  }

  function onDrop(e, index) {
    e.preventDefault();
    const from = dragFrom ?? Number(e.dataTransfer.getData("text/plain"));
    if (from === null || Number.isNaN(from) || from === index) return;
    const slots = [...data.guild.idealComp.slots];
    [slots[from], slots[index]] = [slots[index], slots[from]];
    dragFrom = null;
    persistComp({ size: data.guild.idealComp.size, slots });
  }

  function onClear(index) {
    const slots = [...data.guild.idealComp.slots];
    slots[index] = null;
    persistComp({ size: data.guild.idealComp.size, slots });
  }

  function render() {
    if (failure) {
      mount(root, el("div", { class: "empty" }, t(`error.${failure}`)));
      return;
    }
    if (!data) {
      mount(root, el("div", { class: "empty" }, t("common.loading")));
      return;
    }

    const comp = data.guild.idealComp;
    const characters = data.characters || [];
    const demand = demandOf(comp);
    const supply = supplyOf(characters, { includeAlts, includeOffSpec });
    const byRole = allSpecsByRole();
    const hasComp = demand.size > 0;

    // Biggest shortfall first. Specs nobody wants and nobody plays are hidden
    // once a comp exists — they're noise, not information.
    //
    // DPS additionally groups pure classes before hybrids, because that's how
    // people read the roster: five Mages and five Shadow Priests are not the
    // same kind of five.
    const bands = ["Tank", "Healer", "DPS"].map((role) => {
      const columns = byRole[role]
        .map((entry) => {
          const key = specKey(entry.className, entry.spec);
          return { entry, have: supply.get(key) || [], need: demand.get(key) || 0 };
        })
        .filter((col) => !hasComp || col.need > 0 || col.have.length > 0);

      // Grouped by class, class blocks ordered by combined shortfall.
      const groups = groupByClass(columns, { pureFirst: role === "DPS" });
      return { role, groups, columns: groups.flatMap((g) => g.cols) };
    });

    const byName = Object.fromEntries(bands.map((b) => [b.role, b]));
    const counted = characters.filter(
      (c) => includeAlts || c.commitment === "primary"
    ).length;

    function bandSection(band, { pair } = {}) {
      const { role, columns, groups } = band;
      const isCollapsed = collapsed.has(role);
      // Collapsed and compact share a rendering; collapsed just isn't a choice
      // the user made for the whole board.
      const asChips = isCollapsed || density === "compact";
      const have = columns.reduce((n, c) => n + realCount(c.have), 0);
      const extra = columns.reduce((n, c) => n + offSpecCount(c.have), 0);
      const need = columns.reduce((n, c) => n + c.need, 0);

      return el(
        "section",
        {
          class: `band ${pair ? "band-in-pair" : ""}`,
          // Proportional width so Tanks (3 specs) doesn't claim as much room
          // as Healers (5+), while both still wrap internally if they grow.
          style: pair ? { flex: `${Math.max(columns.length, 1)} 1 280px` } : null,
        },
        el(
          "button",
          {
            class: "band-head",
            "aria-expanded": String(!isCollapsed),
            onClick: () => {
              isCollapsed ? collapsed.delete(role) : collapsed.add(role);
              saveCollapsed(collapsed);
              render();
            },
          },
          el("span", { class: `band-caret ${isCollapsed ? "is-collapsed" : ""}` }, "▾"),
          el("h2", { class: "band-title" }, t(`role.${role.toLowerCase()}`)),
          // Words rather than "9/7", which reads as a score nobody can parse.
          // The hover explains that surplus isn't rejection — the thing
          // people actually worry about when they see themselves in a
          // crowded column.
          el(
            "span",
            { class: "band-summary", title: t("prog.surplusExplainer") },
            need > 0
              ? el(
                  "span",
                  {},
                  el("strong", {}, String(have)),
                  ` ${t("prog.levelling")}`,
                  extra > 0 && el("span", { class: "band-extra" }, ` +${extra} ${t("prog.offSpecShort")}`),
                  " · ",
                  el("strong", {}, String(need)),
                  ` ${t("prog.needed")}`,
                  el("span", { class: "info-mark", "aria-hidden": "true" }, "ⓘ")
                )
              : el(
                  "span",
                  {},
                  el("strong", {}, String(have)),
                  ` ${t("prog.levelling")}`,
                  extra > 0 && el("span", { class: "band-extra" }, ` +${extra} ${t("prog.offSpecShort")}`)
                )
          )
        ),
        columns.length === 0
          ? !isCollapsed && el("p", { class: "muted", style: { fontSize: "13px" } }, t("prog.nobody"))
          : asChips
          ? el(
              "div",
              { class: "band-chips" },
              groups.map((group) =>
                el(
                  "div",
                  { class: "chip-group" },
                  group.cols.map((col) => specChip(col.entry, col.have, col.need))
                )
              )
            )
          : el(
              "div",
              { class: "band-cols" },
              groups.map((group) =>
                el(
                  "div",
                  { class: "col-group" },
                  group.cols.map((col) => specColumn(col.entry, col.have, col.need))
                )
              )
            )
      );
    }

    mount(
      root,
      /* Header ------------------------------------------------------- */
      el(
        "div",
        { class: "page-head row-between" },
        el(
          "div",
          {},
          el("h1", { class: "page-title" }, t("prog.title")),
          el("p", { class: "page-sub" }, t("prog.sub"))
        ),
        el(
          "div",
          { class: "row" },
          el(
            "label",
            { class: "toggle", title: t("prog.includeAltsHint") },
            el("input", {
              type: "checkbox",
              checked: includeAlts || null,
              onChange: () => {
                includeAlts = !includeAlts;
                render();
              },
            }),
            t("prog.includeAlts")
          ),
          el(
            "label",
            { class: "toggle", title: t("prog.includeOffSpecHint") },
            el("input", {
              type: "checkbox",
              checked: includeOffSpec || null,
              onChange: () => {
                includeOffSpec = !includeOffSpec;
                render();
              },
            }),
            t("prog.includeOffSpec")
          ),
          // Yours alone — stored in this browser, nobody else sees it.
          el(
            "div",
            { class: "segmented segmented-sm", role: "group", title: t("prog.densityHint") },
            [
              ["comfortable", t("prog.comfortable")],
              ["compact", t("prog.compact")],
            ].map(([key, label]) =>
              el(
                "button",
                {
                  type: "button",
                  "aria-pressed": String(density === key),
                  onClick: () => {
                    density = key;
                    try {
                      localStorage.setItem(DENSITY_KEY, key);
                    } catch {
                      /* a lost preference is not worth an error */
                    }
                    render();
                  },
                },
                label
              )
            )
          ),
          canEdit() &&
            el(
              "button",
              {
                class: "btn btn-sm desktop-only-control",
                onClick: () =>
                  openCompLibrary({
                    compositions: data.guild.compositions || [],
                    current: comp,
                    onLoad: (saved) =>
                      persistComp({ size: saved.size, slots: saved.slots }),
                    onSave: async (name) => {
                      const res = await api.saveComposition(guildId, {
                        name,
                        size: comp.size,
                        slots: comp.slots,
                      });
                      data.guild.compositions = res.compositions;
                      toast(t("prog.compStored", { name }));
                      return res.compositions;
                    },
                    onDelete: async (id) => {
                      const res = await api.deleteComposition(guildId, id);
                      data.guild.compositions = res.compositions;
                      return res.compositions;
                    },
                  }),
              },
              t("prog.savedComps")
            ),
          canEdit() &&
            el(
              "button",
              {
                class: "btn btn-sm desktop-only-control",
                onClick: () => openCompEditor(comp, persistComp),
              },
              t("prog.editComp")
            )
        )
      ),

      /* Guild identity strip — centres the guild name and rehomes the
         count, which was crowding the page subtitle.                    */
      el(
        "div",
        { class: "guild-strip" },
        el("span", { class: "guild-strip-name" }, data.guild.name),
        el("span", { class: "guild-strip-sep" }, "·"),
        el(
          "span",
          { class: "guild-strip-count" },
          t("prog.counted", { count: counted })
        )
      ),

      /* Ideal composition -------------------------------------------- */
      el(
        "section",
        { class: "comp-panel" },
        el(
          "div",
          { class: "comp-head" },
          el("span", { class: "comp-title" }, t("prog.idealComp", { size: comp.size })),
          el("span", { class: "grow" }),
          canEdit() && el("span", { class: "comp-hint" }, t("prog.dragHint"))
        ),
        hasComp
          ? compGrid(comp, { canEdit: canEdit(), onDragStart, onDrop, onClear })
          : el(
              "div",
              { class: "empty", style: { padding: "26px" } },
              el("p", { style: { margin: "0 0 4px", fontSize: "13.5px" } }, t("prog.noComp")),
              el(
                "p",
                { class: "muted", style: { margin: 0, fontSize: "12.5px" } },
                canEdit() ? t("prog.noCompAdmin") : t("prog.noCompMember")
              )
            )
      ),

      /* Spec bands --------------------------------------------------- *
         Tanks and Healers share a row — together they're about a quarter of
         the raid and reading them side by side makes the shortfall obvious.
         DPS takes the full width below, since it's most of the roster.      */
      el(
        "div",
        { class: "bands" },
        el(
          "div",
          { class: "band-pair" },
          bandSection(byName.Tank, { pair: true }),
          bandSection(byName.Healer, { pair: true })
        ),
        bandSection(byName.DPS)
      )
    );
  }

  load();
}
