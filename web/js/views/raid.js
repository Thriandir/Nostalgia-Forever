import { el, mount, toast } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { store } from "../core/store.js";
import * as router from "../core/router.js";
import { describeInstant } from "../core/time.js";
import { colorFor, shortRace } from "../config/game.js";
import { shortName, fullName } from "../core/names.js";

/**
 * A single raid.
 *
 * Members see the roster and a signup control. Officers additionally see the
 * pending queue and can accept or decline, which drops people into slots and
 * cancels their offers on other raids the same day.
 */

const PARTY_SIZE = 5;

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function slotCell(slot, character, roster) {
  const color = character ? colorFor(character.class) : null;

  return el(
    "div",
    {
      class: `rslot ${character ? "is-filled" : "is-empty"}`,
      style: color ? { "--class-color": color } : null,
      title: slot.spec ? `${slot.spec} ${slot.class}` : t("raid.anySpec"),
    },
    character
      ? el(
          "div",
          { class: "stack grow" },
          el(
            "span",
            { class: "rslot-name truncate", title: fullName(character) },
            shortName(character, roster),
            el("span", { class: "race-badge", title: character.race }, shortRace(character.race))
          ),
          el("span", { class: "rslot-spec truncate" }, `${character.spec} ${character.class}`)
        )
      : el(
          "div",
          { class: "stack grow" },
          el("span", { class: "rslot-wanted truncate" }, slot.spec || t("raid.anySpec")),
          el("span", { class: "rslot-class truncate" }, slot.class || "—")
        )
  );
}

function signupRow(signup, character, { canManage, onAccept, onDecline, roster }) {
  const color = character ? colorFor(character.class) : null;

  return el(
    "div",
    {
      class: `signup-row is-${signup.status}`,
      style: color ? { "--class-color": color } : null,
    },
    el(
      "div",
      { class: "stack grow" },
      el(
        "span",
        { class: "signup-name", title: character ? fullName(character) : "" },
        character ? shortName(character, roster) : t("raid.unknownCharacter"),
        character &&
          el("span", { class: "race-badge", title: character.race }, shortRace(character.race))
      ),
      el(
        "span",
        { class: "signup-meta truncate" },
        character ? `${character.spec} ${character.class} · ${character.role}` : "",
        signup.note && ` — ${signup.note}`
      ),
      signup.status === "cancelled" &&
        signup.cancelReason === "accepted_elsewhere" &&
        el("span", { class: "signup-reason" }, t("raid.cancelledElsewhere")),
      signup.cancelReason &&
        signup.cancelReason !== "accepted_elsewhere" &&
        el("span", { class: "signup-reason" }, signup.cancelReason)
    ),
    signup.status !== "pending" && el("span", { class: `signup-state is-${signup.status}` }, t(`raid.signup.${signup.status}`)),
    canManage &&
      signup.status === "pending" &&
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn btn-sm btn-primary", onClick: () => onAccept(signup) }, t("raid.accept")),
        el("button", { class: "btn btn-sm btn-danger-outline", onClick: () => onDecline(signup) }, t("raid.decline"))
      )
  );
}

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

export function renderRaid(root, raidId) {
  let data = null;
  let failure = null;

  const canManage = () => data && (data.role === "owner" || data.role === "admin");

  async function load() {
    try {
      data = await api.raid(raidId);
    } catch (err) {
      failure = err.code;
    }
    render();
  }

  /** The signup this viewer owns, if any. */
  function mySignup() {
    return (data.signups || []).find(
      (s) => s.userId === store.user.id && !["declined", "cancelled", "withdrawn"].includes(s.status)
    );
  }

  function characterById(id) {
    return (data.characters || []).find((c) => c.id === id) || null;
  }

  /** My characters in this guild that could actually raid. */
  function myEligible() {
    return (data.characters || []).filter(
      (c) => c.userId === store.user.id && !c.deletedAt
    );
  }

  async function signUp(characterId, note) {
    try {
      const res = await api.signUp(raidId, characterId, note);
      data.signups = res.signups;
      toast(t("raid.signedUp"));
      render();
    } catch (err) {
      const known = t(`error.${err.code}`);
      toast(known === `error.${err.code}` ? t("error.generic") : known);
    }
  }

  async function withdraw() {
    const signup = mySignup();
    // Backing out after acceptance leaves a hole, so it needs a reason.
    let reason = "";
    if (signup?.status === "accepted") {
      reason = prompt(t("raid.withdrawReasonPrompt")) || "";
      if (!reason.trim()) {
        toast(t("raid.withdrawReasonRequired"));
        return;
      }
    } else if (!confirm(t("raid.withdrawConfirm"))) {
      return;
    }

    try {
      const res = await api.withdraw(raidId, reason);
      data.raid = res.raid;
      data.signups = res.signups;
      toast(t("raid.withdrawn"));
      render();
    } catch {
      toast(t("error.generic"));
    }
  }

  async function accept(signup) {
    try {
      const res = await api.acceptSignup(raidId, signup.id);
      data.raid = res.raid;
      data.signups = res.signups;
      if (res.cancelledElsewhere?.length) {
        toast(
          t("raid.acceptedAndCancelled", {
            count: res.cancelledElsewhere.length,
            raids: res.cancelledElsewhere.join(", "),
          })
        );
      } else {
        toast(t("raid.accepted"));
      }
      render();
    } catch (err) {
      const known = t(`error.${err.code}`);
      toast(known === `error.${err.code}` ? t("error.generic") : known);
    }
  }

  async function decline(signup) {
    const reason = prompt(t("raid.declineReasonPrompt")) || "";
    try {
      const res = await api.declineSignup(raidId, signup.id, reason);
      data.raid = res.raid;
      data.signups = res.signups;
      toast(t("raid.declined"));
      render();
    } catch {
      toast(t("error.generic"));
    }
  }

  async function setStatus(status) {
    try {
      const res = await api.updateRaid(raidId, { status });
      data.raid = res.raid;
      toast(t("raid.statusChanged", { status: t(`raid.status.${status}`) }));
      render();
    } catch {
      toast(t("error.generic"));
    }
  }

  function signupPanel() {
    const mine = mySignup();
    const eligible = myEligible();
    const open = data.raid.status === "open";

    const filled = data.raid.slots.filter((s) => s.characterId).length;
    const full = filled >= data.raid.slots.length;

    if (mine) {
      // A pending signup on a full raid is a reserve in everything but name,
      // so say so rather than leaving people to wonder.
      const asReserve = mine.status === "pending" && full;

      return el(
        "section",
        { class: "card signup-card" },
        el(
          "div",
          { class: "row-between" },
          el(
            "div",
            { class: "stack grow" },
            el(
              "strong",
              {},
              asReserve ? t("raid.yourStatus.reserve") : t(`raid.yourStatus.${mine.status}`)
            ),
            el(
              "span",
              { class: "muted", style: { fontSize: "12.5px" } },
              fullName(characterById(mine.characterId) || {})
            ),
            asReserve && el("span", { class: "hint", style: { margin: 0 } }, t("raid.reserveHint"))
          ),
          el("button", { class: "btn btn-sm", onClick: withdraw }, t("raid.withdraw"))
        )
      );
    }

    if (!open) {
      return el(
        "section",
        { class: "card" },
        el("p", { class: "muted", style: { margin: 0, fontSize: "13.5px" } }, t("raid.closedToSignups"))
      );
    }

    if (!eligible.length) {
      return el(
        "section",
        { class: "card" },
        el("p", { class: "muted", style: { margin: 0, fontSize: "13.5px" } }, t("raid.noCharacters"))
      );
    }

    let chosen = eligible[0].id;
    let note = "";

    return el(
      "section",
      { class: "card signup-card" },
      el("h2", { class: "card-title" }, full ? t("raid.signUpReserveTitle") : t("raid.signUpTitle")),
      el("p", { class: "card-sub" }, full ? t("raid.signUpReserveSub") : t("raid.signUpSub")),
      // Explicit proportions: both .select and .input are width:100%, so in a
      // plain flex row they fight and the note collapses to nothing.
      el(
        "div",
        { class: "signup-controls" },
        el(
          "select",
          { class: "select signup-character", onChange: (e) => (chosen = e.target.value) },
          eligible.map((c) =>
            el("option", { value: c.id }, `${fullName(c)} — ${c.spec} ${c.class}`)
          )
        ),
        el("input", {
          class: "input signup-note",
          placeholder: t("raid.notePlaceholder"),
          maxlength: "140",
          onInput: (e) => (note = e.target.value),
        }),
        el(
          "button",
          { class: "btn btn-primary signup-go", onClick: () => signUp(chosen, note) },
          t("raid.signUp")
        )
      )
    );
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

    const raid = data.raid;
    const when = describeInstant(raid.startsAt);
    const signups = data.signups || [];
    const pending = signups.filter((s) => s.status === "pending");
    const resolved = signups.filter((s) => s.status !== "pending");
    const filled = raid.slots.filter((s) => s.characterId).length;

    const parties = [];
    for (let i = 0; i < raid.slots.length; i += PARTY_SIZE) {
      parties.push(raid.slots.slice(i, i + PARTY_SIZE));
    }

    mount(
      root,
      el(
        "div",
        { class: "page-head" },
        el(
          "button",
          { class: "btn btn-sm btn-ghost", onClick: () => router.navigate(`/g/${raid.guildId}/calendar`) },
          `‹ ${t("raid.backToCalendar")}`
        ),
        el(
          "div",
          { class: "row-between", style: { marginTop: "10px" } },
          el(
            "div",
            {},
            el(
              "h1",
              { class: "page-title" },
              raid.title,
              " ",
              el("span", { class: `raid-status is-${raid.status}` }, t(`raid.status.${raid.status}`))
            ),
            el(
              "p",
              { class: "page-sub" },
              when.date,
              " · ",
              el("strong", {}, `${when.local} ${when.localLabel}`),
              !when.sameZone && ` · ${when.server} ${when.serverLabel} ${t("time.serverTime")}`,
              ` · ${filled}/${raid.slots.length}`
            )
          ),
          canManage() &&
            el(
              "div",
              { class: "row" },
              raid.status === "open" &&
                el("button", { class: "btn btn-sm", onClick: () => setStatus("locked") }, t("raid.lock")),
              raid.status === "locked" &&
                el("button", { class: "btn btn-sm", onClick: () => setStatus("open") }, t("raid.reopen")),
              raid.status !== "cancelled" &&
                el(
                  "button",
                  {
                    class: "btn btn-sm btn-danger-outline",
                    onClick: async () => {
                      if (!confirm(t("raid.cancelConfirm"))) return;
                      try {
                        const res = await api.cancelRaid(raidId);
                        data.raid = res.raid;
                        toast(t("raid.cancelled"));
                        render();
                      } catch {
                        toast(t("error.generic"));
                      }
                    },
                  },
                  t("raid.cancel")
                )
            )
        )
      ),

      raid.notes && el("div", { class: "banner banner-info" }, raid.notes),

      signupPanel(),

      /* Roster ------------------------------------------------------- */
      el(
        "section",
        { class: "card" },
        el(
          "div",
          { class: "row-between", style: { marginBottom: "12px" } },
          el("h2", { class: "card-title", style: { margin: 0 } }, t("raid.roster")),
          raid.compositionName &&
            el("span", { class: "tag tag-soft" }, raid.compositionName)
        ),
        el(
          "div",
          { class: "raid-parties" },
          parties.map((slots, i) =>
            el(
              "div",
              { class: "raid-party" },
              el("span", { class: "party-label" }, t("prog.party", { n: i + 1 })),
              slots.map((slot) => slotCell(slot, characterById(slot.characterId), data.characters))
            )
          )
        )
      ),

      /* Pending queue — officers only ------------------------------- */
      canManage() &&
        pending.length > 0 &&
        el(
          "section",
          { class: "card" },
          el("h2", { class: "card-title" }, t("raid.pending", { count: pending.length })),
          el("p", { class: "card-sub" }, t("raid.pendingSub")),
          el(
            "div",
            { class: "signup-list" },
            pending.map((s) =>
              signupRow(s, characterById(s.characterId), {
                canManage: true,
                onAccept: accept,
                onDecline: decline,
                roster: data.characters,
              })
            )
          )
        ),

      /* Everyone who has answered ------------------------------------ */
      resolved.length > 0 &&
        el(
          "section",
          { class: "card" },
          el("h2", { class: "card-title" }, t("raid.responses")),
          el(
            "div",
            { class: "signup-list" },
            resolved.map((s) =>
              signupRow(s, characterById(s.characterId), { canManage: false, roster: data.characters })
            )
          )
        )
    );
  }

  load();
}
