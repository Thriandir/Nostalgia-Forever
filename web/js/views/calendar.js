import { el, mount, toast } from "../core/dom.js";
import { t, formatDate } from "../core/i18n.js";
import { api } from "../core/api.js";
import { store } from "../core/store.js";
import { fullName } from "../core/names.js";
import * as router from "../core/router.js";
import {
  describeInstant,
  zonedToUtc,
  serverZone,
  userZone,
  zoneLabel,
} from "../core/time.js";

/**
 * The raid calendar.
 *
 * Desktop gets a month grid; narrow screens get a chronological list, because
 * a seven-column month on a phone is unreadable and members do most of their
 * signing up on a phone.
 *
 * Every time shown is dual — local and server — and the two differ by an hour
 * for half the year, which is exactly when people miss raids.
 */

const MAX_VISIBLE_PER_DAY = 3;

/** Must match PALETTE in the worker — colours are stored as keys, not hex. */
const PALETTE = ["red", "orange", "green", "blue", "purple", "teal"];

/** Row of colour swatches, shared by both raid creation forms. */
function colourPicker(current, onPick) {
  return el(
    "div",
    { class: "colour-picks colour-picks-left" },
    PALETTE.map((colour) =>
      el("button", {
        type: "button",
        class: `colour-pick is-${colour} ${current === colour ? "is-on" : ""}`,
        title: colour,
        onClick: () => onPick(colour),
      })
    )
  );
}

/* ------------------------------------------------------------------ *
 * Date helpers
 * ------------------------------------------------------------------ */

function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
function addMonths(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
}
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/** Monday-first grid covering the whole month plus its ragged edges. */
function monthGrid(monthStart) {
  const first = new Date(monthStart);
  const offset = (first.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - offset);

  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    days.push(d);
  }
  return days;
}

/** Which calendar day a raid falls on, judged in the viewer's own timezone. */
function dayKeyFor(startsAt) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: userZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(startsAt));
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function statusBadge(status) {
  return el("span", { class: `raid-status is-${status}` }, t(`raid.status.${status}`));
}

function raidChip(raid, { compact } = {}) {
  const when = describeInstant(raid.startsAt);
  const full = raid.filled >= raid.size;

  return el(
    "button",
    {
      class: `raid-chip is-${raid.status} is-c-${raid.colour || "blue"} ${full ? "is-full" : ""}`,
      onClick: () => router.navigate(`/r/${raid.id}`),
      title: `${raid.title} · ${when.local} ${when.localLabel}${
        when.sameZone ? "" : ` · ${when.server} ${when.serverLabel}`
      }`,
    },
    el("span", { class: "raid-chip-time" }, when.local),
    el("span", { class: "raid-chip-title truncate" }, raid.title),
    !compact &&
      el(
        "span",
        { class: "raid-chip-count" },
        `${raid.filled}/${raid.size}`,
        raid.pending > 0 && el("span", { class: "raid-chip-pending" }, `·${raid.pending}`)
      )
  );
}

/* ------------------------------------------------------------------ *
 * Create raid
 * ------------------------------------------------------------------ */

function openCreateRaid(guildId, compositions, onCreated) {
  const zone = serverZone();
  const now = new Date();

  const draft = {
    title: "",
    date: isoDay(new Date(now.getTime() + 86400000)),
    time: "20:00",
    compositionId: compositions[0]?.id || null,
    size: compositions[0]?.size || 40,
    colour: "blue",
    notes: "",
  };
  let invalid = new Set();

  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body" });
  const close = () => overlay.remove();

  async function save() {
    // The admin types server time; we convert to a UTC instant here so the
    // stored value is unambiguous regardless of daylight saving.
    const startsAt = zonedToUtc(draft.date, draft.time, zone);
    if (!startsAt) {
      invalid = new Set(["startsAt"]);
      render();
      return;
    }
    try {
      const res = await api.createRaid(guildId, {
        title: draft.title,
        startsAt: startsAt.toISOString(),
        compositionId: draft.compositionId,
        size: draft.size,
        colour: draft.colour,
        notes: draft.notes,
        status: "open",
      });
      toast(t("raid.created"));
      close();
      onCreated(res.raid);
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
    const preview = zonedToUtc(draft.date, draft.time, zone);
    const shown = preview ? describeInstant(preview) : null;

    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el("h2", { class: "modal-title" }, t("raid.create")),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close }, "✕")
      ),
      el(
        "div",
        { class: "modal-scroll" },
        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("raid.title")),
          el("input", {
            class: `input ${invalid.has("title") ? "is-invalid" : ""}`,
            value: draft.title,
            placeholder: t("raid.titlePlaceholder"),
            maxlength: "60",
            onInput: (e) => (draft.title = e.target.value),
          })
        ),

        el(
          "div",
          { class: "field-row" },
          el(
            "div",
            { class: "field" },
            el("span", { class: "label" }, t("raid.date")),
            el("input", {
              class: "input",
              type: "date",
              value: draft.date,
              onChange: (e) => set({ date: e.target.value }),
            })
          ),
          el(
            "div",
            { class: "field" },
            el("span", { class: "label" }, `${t("raid.time")} · ${zoneLabel(zone)}`),
            el("input", {
              class: "input",
              type: "time",
              value: draft.time,
              onChange: (e) => set({ time: e.target.value }),
            })
          )
        ),

        // Say plainly what this lands as in the viewer's own time, because
        // the gap is an hour for half the year.
        shown &&
          el(
            "p",
            { class: "hint" },
            shown.sameZone
              ? t("raid.timeSame", { time: shown.server })
              : t("raid.timePreview", {
                  server: `${shown.server} ${shown.serverLabel}`,
                  local: `${shown.local} ${shown.localLabel}`,
                })
          ),

        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("raid.composition")),
          compositions.length
            ? el(
                "select",
                {
                  class: "select",
                  onChange: (e) => {
                    const chosen = compositions.find((c) => c.id === e.target.value);
                    set({ compositionId: chosen?.id || null, size: chosen?.size || 40 });
                  },
                },
                compositions.map((c) =>
                  el(
                    "option",
                    { value: c.id, selected: c.id === draft.compositionId || null },
                    `${c.name} · ${c.size}`
                  )
                )
              )
            : el("p", { class: "hint" }, t("raid.noCompositions"))
        ),

        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("raid.colour")),
          colourPicker(draft.colour, (c) => set({ colour: c })),
          el("p", { class: "hint" }, t("raid.colourHint"))
        ),

        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, `${t("raid.notes")} (${t("common.optional")})`),
          el("textarea", {
            class: "input",
            rows: "3",
            value: draft.notes,
            placeholder: t("raid.notesPlaceholder"),
            maxlength: "500",
            onInput: (e) => (draft.notes = e.target.value),
          })
        )
      ),
      el(
        "div",
        { class: "modal-foot" },
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel")),
        el("button", { class: "btn btn-primary", onClick: save }, t("raid.create"))
      )
    );
  }

  render();
  overlay.append(body);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  document.body.append(overlay);
}

/* ------------------------------------------------------------------ *
 * Recurring raids — two stages
 * ------------------------------------------------------------------ *
 *
 * Stage one sets the pattern, stage two shows exactly which dates it produced
 * so the admin can untick the ones they don't want. Reviewing before creating
 * beats creating-then-deleting: there's nothing to remember to undo, and no
 * raid briefly exists that shouldn't.
 *
 * Deliberately capped at the month being viewed. A pattern that runs forever
 * accumulates raids nobody is thinking about.
 */

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

function openRecurringRaids(guildId, compositions, month, onCreated) {
  const zone = serverZone();
  const draft = {
    title: "",
    weekdays: new Set([1]), // Monday
    time: "20:00",
    compositionId: compositions[0]?.id || null,
    colour: "blue",
    notes: "",
  };
  let stage = 1;
  let dates = [];
  const skipped = new Set();

  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body modal-wide" });
  const close = () => overlay.remove();

  /** Every matching day left in the viewed month, today onward. */
  function datesInMonth() {
    const out = [];
    const year = month.getUTCFullYear();
    const m = month.getUTCMonth();
    const todayKey = isoDay(new Date());

    for (let day = 1; day <= 31; day++) {
      const d = new Date(Date.UTC(year, m, day));
      if (d.getUTCMonth() !== m) break;
      if (!draft.weekdays.has(d.getUTCDay())) continue;
      const key = isoDay(d);
      if (key < todayKey) continue; // no point scheduling the past
      out.push(key);
    }
    return out;
  }

  async function create() {
    const wanted = dates.filter((d) => !skipped.has(d));
    if (!wanted.length) return;

    const instants = wanted
      .map((d) => zonedToUtc(d, draft.time, zone))
      .filter(Boolean)
      .map((d) => d.toISOString());

    try {
      const res = await api.createRaids(guildId, {
        title: draft.title,
        startsAt: instants,
        compositionId: draft.compositionId,
        colour: draft.colour,
        notes: draft.notes,
        status: "open",
      });
      toast(t("raid.bulkCreated", { count: res.created }));
      close();
      onCreated();
    } catch {
      toast(t("error.generic"));
    }
  }

  function renderStageOne() {
    const weekdayButtons = WEEKDAY_ORDER.map((dow) => {
      const label = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
        new Date(Date.UTC(2024, 0, 7 + dow)) // 2024-01-07 was a Sunday
      );
      return el(
        "button",
        {
          type: "button",
          class: `day-toggle ${draft.weekdays.has(dow) ? "is-on" : ""}`,
          onClick: () => {
            draft.weekdays.has(dow) ? draft.weekdays.delete(dow) : draft.weekdays.add(dow);
            render();
          },
        },
        label
      );
    });

    return [
      el(
        "div",
        { class: "field" },
        el("span", { class: "label" }, t("raid.title")),
        el("input", {
          class: "input",
          value: draft.title,
          placeholder: t("raid.recurringTitlePlaceholder"),
          maxlength: "60",
          onInput: (e) => (draft.title = e.target.value),
        }),
        el("p", { class: "hint" }, t("raid.recurringTitleHint"))
      ),
      el(
        "div",
        { class: "field" },
        el("span", { class: "label" }, t("raid.whichDays")),
        el("div", { class: "day-toggles" }, weekdayButtons)
      ),
      el(
        "div",
        { class: "field-row" },
        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, `${t("raid.time")} · ${zoneLabel(zone)}`),
          el("input", {
            class: "input",
            type: "time",
            value: draft.time,
            onChange: (e) => (draft.time = e.target.value),
          })
        ),
        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("raid.composition")),
          compositions.length
            ? el(
                "select",
                {
                  class: "select",
                  onChange: (e) => (draft.compositionId = e.target.value),
                },
                compositions.map((c) =>
                  el(
                    "option",
                    { value: c.id, selected: c.id === draft.compositionId || null },
                    `${c.name} · ${c.size}`
                  )
                )
              )
            : el("p", { class: "hint" }, t("raid.noCompositions"))
        )
      ),
      el(
        "div",
        { class: "field" },
        el("span", { class: "label" }, t("raid.colour")),
        colourPicker(draft.colour, (c) => {
          draft.colour = c;
          render();
        })
      ),
      el("p", { class: "hint" }, t("raid.recurringScope")),
    ];
  }

  function renderStageTwo() {
    if (!dates.length) {
      return [
        el(
          "div",
          { class: "empty", style: { padding: "26px" } },
          el("p", { style: { margin: 0, fontSize: "13.5px" } }, t("raid.recurringNoDates"))
        ),
      ];
    }

    const keeping = dates.filter((d) => !skipped.has(d)).length;

    return [
      el("p", { class: "card-sub" }, t("raid.recurringReview", { count: keeping })),
      el(
        "div",
        { class: "date-list" },
        dates.map((date) => {
          const instant = zonedToUtc(date, draft.time, zone);
          const shown = instant ? describeInstant(instant) : null;
          const on = !skipped.has(date);

          return el(
            "label",
            { class: `date-row ${on ? "" : "is-skipped"}` },
            el("input", {
              type: "checkbox",
              checked: on || null,
              onChange: () => {
                on ? skipped.add(date) : skipped.delete(date);
                render();
              },
            }),
            el(
              "div",
              { class: "stack grow" },
              el(
                "strong",
                {},
                new Intl.DateTimeFormat(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  timeZone: "UTC",
                }).format(new Date(`${date}T12:00:00Z`))
              ),
              shown &&
                el(
                  "span",
                  { class: "muted", style: { fontSize: "12px" } },
                  shown.sameZone
                    ? shown.local
                    : `${shown.local} ${shown.localLabel} · ${shown.server} ${shown.serverLabel}`
                )
            )
          );
        })
      ),
    ];
  }

  function render() {
    const keeping = dates.filter((d) => !skipped.has(d)).length;

    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el(
          "h2",
          { class: "modal-title" },
          stage === 1 ? t("raid.recurringTitle") : t("raid.recurringReviewTitle")
        ),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close }, "✕")
      ),
      el("div", { class: "modal-scroll" }, stage === 1 ? renderStageOne() : renderStageTwo()),
      el(
        "div",
        { class: "modal-foot" },
        el("span", { class: "grow" }),
        stage === 1
          ? el(
              "div",
              { class: "row" },
              el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel")),
              el(
                "button",
                {
                  class: "btn btn-primary",
                  disabled: (!draft.weekdays.size || draft.title.trim().length < 2) || null,
                  onClick: () => {
                    dates = datesInMonth();
                    skipped.clear();
                    stage = 2;
                    render();
                  },
                },
                t("raid.preview")
              )
            )
          : el(
              "div",
              { class: "row" },
              el(
                "button",
                {
                  class: "btn btn-ghost",
                  onClick: () => {
                    stage = 1;
                    render();
                  },
                },
                t("raid.back")
              ),
              el(
                "button",
                { class: "btn btn-primary", disabled: !keeping || null, onClick: create },
                t("raid.createCount", { count: keeping })
              )
            )
      )
    );
  }

  render();
  overlay.append(body);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  document.body.append(overlay);
}

/* ------------------------------------------------------------------ *
 * Bulk signup
 * ------------------------------------------------------------------ */

function openBulkSignup(guildId, raids, characters, onDone) {
  // Only raids still taking signups, soonest first.
  const open = raids
    .filter((r) => r.status === "open" && r.startsAt >= new Date().toISOString())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const chosen = new Set(open.map((r) => r.id));
  let characterId = characters[0]?.id || null;
  let note = "";
  let weekdayFilter = null;

  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div", { class: "modal-body" });
  const close = () => overlay.remove();

  async function submit() {
    if (!chosen.size || !characterId) return;
    try {
      const res = await api.bulkSignUp(guildId, [...chosen], characterId, note);
      toast(t("raid.bulkSignedUp", { count: res.added }));
      close();
      onDone();
    } catch {
      toast(t("error.generic"));
    }
  }

  function applyWeekday(dow) {
    weekdayFilter = dow;
    chosen.clear();
    for (const r of open) {
      if (dow === null || new Date(r.startsAt).getDay() === dow) chosen.add(r.id);
    }
    render();
  }

  function render() {
    mount(
      body,
      el(
        "div",
        { class: "modal-head" },
        el("h2", { class: "modal-title" }, t("raid.bulkSignUpTitle")),
        el("button", { class: "btn btn-sm btn-ghost", onClick: close }, "✕")
      ),
      el(
        "div",
        { class: "modal-scroll" },
        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("raid.withCharacter")),
          el(
            "select",
            { class: "select", onChange: (e) => (characterId = e.target.value) },
            characters.map((c) =>
              el("option", { value: c.id }, `${fullName(c)} — ${c.spec} ${c.class}`)
            )
          )
        ),

        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("raid.quickPick")),
          el(
            "div",
            { class: "day-toggles" },
            el(
              "button",
              {
                type: "button",
                class: `day-toggle ${weekdayFilter === null ? "is-on" : ""}`,
                onClick: () => applyWeekday(null),
              },
              t("raid.allDays")
            ),
            WEEKDAY_ORDER.map((dow) =>
              el(
                "button",
                {
                  type: "button",
                  class: `day-toggle ${weekdayFilter === dow ? "is-on" : ""}`,
                  onClick: () => applyWeekday(dow),
                },
                new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
                  new Date(Date.UTC(2024, 0, 7 + dow))
                )
              )
            )
          )
        ),

        open.length
          ? el(
              "div",
              { class: "date-list" },
              open.map((r) => {
                const when = describeInstant(r.startsAt);
                const on = chosen.has(r.id);
                const full = r.filled >= r.size;
                return el(
                  "label",
                  { class: `date-row ${on ? "" : "is-skipped"}` },
                  el("input", {
                    type: "checkbox",
                    checked: on || null,
                    onChange: () => {
                      on ? chosen.delete(r.id) : chosen.add(r.id);
                      render();
                    },
                  }),
                  el(
                    "div",
                    { class: "stack grow" },
                    el("strong", { class: "truncate" }, r.title),
                    el(
                      "span",
                      { class: "muted", style: { fontSize: "12px" } },
                      `${when.date} · ${when.local} ${when.localLabel}`
                    )
                  ),
                  // Say plainly that a full raid means the reserve list.
                  full && el("span", { class: "tag tag-soft" }, t("raid.reserveOnly"))
                );
              })
            )
          : el(
              "div",
              { class: "empty", style: { padding: "22px" } },
              el("p", { style: { margin: 0, fontSize: "13.5px" } }, t("raid.noneOpen"))
            ),

        el(
          "div",
          { class: "field", style: { marginTop: "14px" } },
          el("span", { class: "label" }, `${t("raid.notes")} (${t("common.optional")})`),
          el("input", {
            class: "input",
            placeholder: t("raid.notePlaceholder"),
            maxlength: "140",
            onInput: (e) => (note = e.target.value),
          })
        )
      ),
      el(
        "div",
        { class: "modal-foot" },
        el("span", { class: "grow" }),
        el("button", { class: "btn btn-ghost", onClick: close }, t("common.cancel")),
        el(
          "button",
          { class: "btn btn-primary", disabled: !chosen.size || null, onClick: submit },
          t("raid.signUpCount", { count: chosen.size })
        )
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

export function renderCalendar(root, guildId) {
  let month = startOfMonth(new Date());
  let raids = [];
  let role = "member";
  let compositions = [];
  let myCharacters = [];
  let guild = null;
  let failure = null;
  let loading = true;

  const canEdit = () => role === "owner" || role === "admin";

  async function load() {
    loading = true;
    render();
    try {
      // A generous window either side, so the ragged edges of the grid are
      // populated rather than suspiciously empty.
      const from = addMonths(month, -1).toISOString();
      const to = addMonths(month, 2).toISOString();
      const res = await api.raids(guildId, from, to);
      raids = res.raids || [];
      role = res.role;

      // One guild fetch covers both the composition list officers need and
      // the member's own characters, which bulk signup needs.
      if (!guild) {
        const res = await api.guild(guildId);
        guild = res.guild;
        compositions = guild.compositions || [];
        myCharacters = (res.characters || []).filter(
          (c) => c.userId === store.user.id && !c.deletedAt
        );
      }
    } catch (err) {
      failure = err.code;
    }
    loading = false;
    render();
  }

  function byDay() {
    const map = new Map();
    for (const raid of raids) {
      const key = dayKeyFor(raid.startsAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(raid);
    }
    return map;
  }

  /**
   * Reset bars for a given day, in the viewer's own time.
   *
   * Weekly rather than daily — the server reset is a Wednesday thing, and
   * raid lockouts hang off their own schedules, so a three-day lockout shows
   * up twice a week on different days from the 40-man.
   *
   * The hour is fixed in server time but lands differently for everyone else,
   * and that converted number is the useful one. Recomputed per day because
   * the offset shifts when daylight saving moves on one side and not the
   * other.
   */
  function resetBars(dayKey) {
    const resets = guild?.resets || [];
    if (!resets.length) return null;

    // getUTCDay on a noon-UTC instant gives the weekday without edge cases.
    const weekday = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
    const due = resets.filter((r) => (r.weekdays || []).includes(weekday));
    if (!due.length) return null;

    return el(
      "div",
      { class: "cal-resets" },
      due.map((reset) => {
        const instant = zonedToUtc(dayKey, reset.time, serverZone(guild));
        const shown = instant ? describeInstant(instant, guild) : null;

        return el(
          "div",
          {
            class: `cal-reset is-${reset.colour || "red"}`,
            title: shown
              ? t("raid.resetHint", {
                  name: reset.name,
                  local: `${shown.local} ${shown.localLabel}`,
                  server: `${reset.time} ${shown.serverLabel}`,
                })
              : reset.name,
          },
          el("span", { class: "cal-reset-time" }, shown ? shown.local : reset.time),
          el("span", { class: "cal-reset-name truncate" }, reset.name)
        );
      })
    );
  }

  function monthView(grouped) {
    const days = monthGrid(month);
    const thisMonth = month.getUTCMonth();
    const todayKey = dayKeyFor(new Date().toISOString());

    const weekdays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.UTC(2024, 0, 1 + i)); // a Monday
      weekdays.push(
        el(
          "div",
          { class: "cal-weekday" },
          new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(d)
        )
      );
    }

    return el(
      "div",
      { class: "cal-grid" },
      weekdays,
      days.map((day) => {
        const key = isoDay(day);
        const list = grouped.get(key) || [];
        const visible = list.slice(0, MAX_VISIBLE_PER_DAY);
        const hidden = list.length - visible.length;

        return el(
          "div",
          {
            class: `cal-day ${day.getUTCMonth() === thisMonth ? "" : "is-outside"} ${
              key === todayKey ? "is-today" : ""
            }`,
          },
          el("span", { class: "cal-date" }, String(day.getUTCDate())),
          resetBars(key),
          visible.map((r) => raidChip(r, { compact: true })),
          hidden > 0 &&
            el(
              "button",
              {
                class: "cal-more",
                onClick: () => {
                  // Jumping to the first hidden raid beats a cramped popover.
                  router.navigate(`/r/${list[MAX_VISIBLE_PER_DAY].id}`);
                },
              },
              t("raid.more", { count: hidden })
            )
        );
      })
    );
  }

  function listView(grouped) {
    const keys = [...grouped.keys()].sort();
    const upcoming = keys.filter((k) => k >= dayKeyFor(new Date().toISOString()));

    if (!upcoming.length) {
      return el(
        "div",
        { class: "empty" },
        el("p", { style: { margin: 0, fontSize: "13.5px" } }, t("raid.noneUpcoming"))
      );
    }

    return el(
      "div",
      { class: "cal-list" },
      upcoming.map((key) =>
        el(
          "div",
          { class: "cal-list-day" },
          el(
            "div",
            { class: "cal-list-date" },
            formatDate(`${key}T12:00:00Z`, { weekday: "short", day: "numeric", month: "short" })
          ),
          el("div", { class: "cal-list-raids" }, grouped.get(key).map((r) => raidChip(r)))
        )
      )
    );
  }

  function render() {
    if (failure) {
      mount(root, el("div", { class: "empty" }, t(`error.${failure}`)));
      return;
    }

    const grouped = byDay();
    const monthLabel = new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(month);

    mount(
      root,
      el(
        "div",
        { class: "page-head row-between" },
        el(
          "div",
          {},
          el("h1", { class: "page-title" }, t("raid.calendar")),
          el("p", { class: "page-sub" }, t("raid.calendarSub"))
        ),
        el(
          "div",
          { class: "row" },
          myCharacters.length > 0 &&
            el(
              "button",
              {
                class: "btn btn-sm",
                onClick: () => openBulkSignup(guildId, raids, myCharacters, () => load()),
              },
              t("raid.bulkSignUp")
            ),
          canEdit() &&
            el(
              "button",
              {
                class: "btn btn-sm",
                onClick: () =>
                  openRecurringRaids(guildId, compositions, month, () => load()),
              },
              t("raid.recurring")
            ),
          canEdit() &&
            el(
              "button",
              {
                class: "btn btn-primary",
                onClick: () => openCreateRaid(guildId, compositions, () => load()),
              },
              t("raid.create")
            )
        )
      ),

      el(
        "div",
        { class: "cal-bar" },
        el(
          "button",
          {
            class: "btn btn-sm btn-ghost",
            onClick: () => {
              month = addMonths(month, -1);
              load();
            },
          },
          "‹"
        ),
        el("strong", { class: "cal-month" }, monthLabel),
        el(
          "button",
          {
            class: "btn btn-sm btn-ghost",
            onClick: () => {
              month = addMonths(month, 1);
              load();
            },
          },
          "›"
        ),
        el("span", { class: "grow" }),
        el(
          "button",
          {
            class: "btn btn-sm btn-ghost",
            onClick: () => {
              month = startOfMonth(new Date());
              load();
            },
          },
          t("raid.today")
        ),
        loading && el("span", { class: "cal-loading" }, t("common.loading"))
      ),

      // Two renderings of the same data — CSS decides which is visible.
      el("div", { class: "cal-month-only" }, monthView(grouped)),
      el("div", { class: "cal-list-only" }, listView(grouped))
    );
  }

  load();
}
