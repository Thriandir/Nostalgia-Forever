import { el, toast } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { applyTheme, getTheme } from "../core/theme.js";
import { api } from "../core/api.js";
import { store } from "../core/store.js";
import {
  userZone,
  setUserZone,
  detectZone,
  hasZoneOverride,
  serverZone,
  nowIn,
  zoneLabel,
  zoneOffset,
  offsetLabel,
} from "../core/time.js";

/**
 * What to say about a Battle.net link.
 *
 * The count on its own was misleading: fifty retail and Classic alts tell the
 * guild roster nothing, and promising their levels "keep themselves up to
 * date" was simply untrue. So Forever characters are counted separately, and
 * when there are none we say so plainly rather than implying the feature is
 * working.
 */
function battlenetHint(user) {
  if (!user.battlenetId) return t("profile.battlenetHint");

  const all = user.wowCharacters || [];
  const forever = all.filter((c) => /forever/i.test(c.namespace || ""));

  if (forever.length) return t("profile.battlenetForever", { count: forever.length });
  if (all.length) return t("profile.battlenetOtherOnly", { count: all.length });
  return t("profile.battlenetNoChars");
}

const LINK_ICONS = {
  discord: "💬",
  battlenet: "⚔",
  telegram: "✈",
  app: "📱",
};

/**
 * One row in Linked accounts.
 *
 * Discord and Battle.net are live; Telegram and the mobile app are still
 * placeholders and render disabled rather than hidden, so people can see
 * what's coming and guild admins have something to point at when they make
 * one required.
 */
/** Copy-to-clipboard button. These handles exist to be pasted at people. */
function copyButton(value, label) {
  return el(
    "button",
    {
      class: "copy-btn",
      title: t("profile.copyHandle", { label }),
      "aria-label": t("profile.copyHandle", { label }),
      onClick: async (e) => {
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(value);
          toast(t("profile.copied", { value }));
        } catch {
          // Clipboard is blocked in some contexts; showing the value at
          // least lets them select it by hand.
          prompt(t("profile.copyHandle", { label }), value);
        }
      },
    },
    "⧉"
  );
}

function linkRow({
  name,
  hint,
  icon,
  connected,
  value,
  provider,
  actionLabel,
  onChange,
  copyable,
  secondaryAction,
}) {
  const live = Boolean(provider);

  return el(
    "div",
    { class: "link-row" },
    el(
      "div",
      { class: "link-head" },
      el("span", { class: "link-icon" }, LINK_ICONS[icon] || "•"),
      el(
        "div",
        { class: "stack grow" },
        el("strong", { class: "link-name" }, name),
        el(
          "span",
          { class: "link-value-row" },
          el(
            "span",
            { class: `link-status ${connected ? "is-connected" : ""}` },
            connected ? value : t("profile.notConnected")
          ),
          connected && copyable && copyButton(copyable, name)
        )
      ),
      connected && secondaryAction,
      live
        ? connected
          ? el(
              "button",
              {
                class: "btn btn-sm",
                onClick: async () => {
                  if (!confirm(t("profile.unlinkConfirm", { name }))) return;
                  try {
                    const { user } = await api.unlink(provider);
                    store.setUser(user);
                    toast(t("profile.unlinked", { name }));
                    onChange();
                  } catch {
                    toast(t("error.generic"));
                  }
                },
              },
              t("profile.disconnect")
            )
          : el(
              "button",
              {
                class: "btn btn-sm btn-primary",
                // Full-page redirect: OAuth can't round-trip through fetch.
                onClick: () => {
                  window.location.href = api.linkUrl(provider);
                },
              },
              t("profile.connect")
            )
        : el(
            "button",
            { class: "btn btn-sm", disabled: true, title: t("profile.comingSoon") },
            actionLabel || t("profile.connect")
          )
    ),
    hint && el("p", { class: "hint" }, hint)
  );
}

function segmented(options, value, onPick) {
  return el(
    "div",
    { class: "segmented", role: "group" },
    options.map(([key, label]) =>
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(key === value),
          onClick: () => onPick(key),
        },
        label
      )
    )
  );
}

/** Zone list for the manual picker, newest browsers give us the full IANA set. */
function zoneOptions() {
  try {
    const all = Intl.supportedValuesOf?.("timeZone");
    if (all && all.length) return all;
  } catch {
    /* fall through */
  }
  return [
    "Europe/Istanbul", "Europe/Paris", "Europe/Berlin", "Europe/London",
    "Europe/Madrid", "Europe/Moscow", "Europe/Kyiv", "Europe/Amsterdam",
    "America/New_York", "America/Chicago", "America/Los_Angeles",
    "Asia/Dubai", "Asia/Tokyo", "Australia/Sydney", "UTC",
  ];
}

/** "2 hours" / "90 minutes" — used for the gap between local and server. */
function describeGap(ms) {
  const mins = Math.abs(Math.round(ms / 60000));
  if (mins % 60 === 0) {
    const h = mins / 60;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return `${mins} minutes`;
}

function timeCard(refs) {
  const local = userZone();
  const server = serverZone();
  const now = new Date();
  const gap = zoneOffset(local, now) - zoneOffset(server, now);

  refs.localClock = el("strong", { style: { fontSize: "19px" } }, nowIn(local));
  refs.serverClock = el("strong", { style: { fontSize: "19px" } }, nowIn(server));

  let gapLine;
  if (gap === 0) gapLine = t("time.sameAsServer");
  else if (gap > 0) gapLine = t("time.aheadBy", { hours: describeGap(gap) });
  else gapLine = t("time.behindBy", { hours: describeGap(gap) });

  return el(
    "section",
    { class: "card" },
    el("h2", { class: "card-title" }, t("time.title")),
    el("p", { class: "card-sub" }, t("time.sub")),

    el(
      "div",
      { class: "clock-pair" },
      el(
        "div",
        { class: "clock" },
        refs.localClock,
        el("span", { class: "clock-zone" }, `${t("time.yourTime")} · ${zoneLabel(local, now)}`),
        el("span", { class: "clock-sub" }, local)
      ),
      el(
        "div",
        { class: "clock" },
        refs.serverClock,
        el("span", { class: "clock-zone" }, `${t("time.serverTime")} · ${zoneLabel(server, now)}`),
        el("span", { class: "clock-sub" }, `${server} · ${offsetLabel(server, now)}`)
      )
    ),

    el("p", { class: "hint", style: { marginTop: "12px" } }, gapLine),
    gap !== 0 && el("p", { class: "hint" }, t("time.dstNote")),

    el(
      "div",
      { class: "field", style: { marginTop: "16px" } },
      el("label", { class: "label", for: "pf-zone" }, t("time.yours")),
      el(
        "div",
        { class: "row" },
        el(
          "select",
          {
            id: "pf-zone",
            class: "select grow",
            onChange: (e) => {
              setUserZone(e.target.value);
              refs.rerender();
            },
          },
          zoneOptions().map((zone) =>
            el("option", { value: zone, selected: zone === local || null }, zone)
          )
        ),
        hasZoneOverride() &&
          el(
            "button",
            {
              class: "btn btn-sm",
              onClick: () => {
                setUserZone(null);
                refs.rerender();
              },
            },
            t("time.useDetected")
          )
      ),
      el(
        "p",
        { class: "hint" },
        hasZoneOverride() ? `${t("time.detected")}: ${detectZone()}` : t("time.detected")
      )
    )
  );
}

export function renderProfile(root) {
  const theme = getTheme();
  const refs = { rerender: () => render() };

  // Surface the outcome of a linking round-trip, then clean the URL so a
  // refresh doesn't re-announce it.
  const linkResult = new URLSearchParams(location.hash.split("?")[1] || "").get("link");
  if (linkResult) {
    const key = `profile.link_${linkResult}`;
    const message = t(key);
    toast(message === key ? t("error.generic") : message);
    history.replaceState(null, "", `${location.pathname}#/me/profile`);
    // A successful link changed the user server-side; pull it back in.
    if (linkResult === "ok") {
      api.me().then((me) => {
        store.hydrate(me);
        render();
      }).catch(() => {});
    }
  }

  // One ticking clock for the whole view, cleaned up when the view is replaced.
  const ticker = setInterval(() => {
    if (!root.isConnected || !refs.localClock?.isConnected) {
      clearInterval(ticker);
      return;
    }
    refs.localClock.textContent = nowIn(userZone());
    refs.serverClock.textContent = nowIn(serverZone());
  }, 1000);

  const draft = {
    displayName: store.user.displayName || "",
    themeMode: store.user.themeMode || theme.mode,
    whatsappPhone: store.user.whatsappPhone || "",
    whatsappUsername: store.user.whatsappUsername || "",
  };

  let saveBtn;
  let phoneError = false;

  /** E.164, same rule the server enforces. Empty is fine — it's optional. */
  function phoneIsValid(raw) {
    const cleaned = String(raw || "").replace(/[\s\-().]/g, "");
    return cleaned === "" || /^\+[1-9]\d{7,14}$/.test(cleaned);
  }

  async function save() {
    if (!phoneIsValid(draft.whatsappPhone)) {
      phoneError = true;
      render();
      return;
    }
    phoneError = false;

    saveBtn.disabled = true;
    const original = saveBtn.textContent;
    saveBtn.textContent = t("profile.saving");
    try {
      const { user: updated } = await api.updateProfile({
        displayName: draft.displayName.trim() || store.user.email,
        themeMode: draft.themeMode,
        whatsappPhone: draft.whatsappPhone.trim() || null,
        whatsappUsername: draft.whatsappUsername.trim() || null,
      });
      store.setUser(updated);
      toast(t("profile.saved"));
      render();
    } catch {
      toast(t("error.generic"));
      saveBtn.disabled = false;
      saveBtn.textContent = original;
    }
  }

  function render() {
    // Read fresh each time — linking an account replaces the stored user.
    const user = store.user;

    root.replaceChildren(
      el(
        "div",
        { class: "page-head" },
        el("h1", { class: "page-title" }, t("profile.title")),
        el("p", { class: "page-sub" }, t("profile.sub"))
      ),

      /* Identity ------------------------------------------------------- */
      el(
        "section",
        { class: "card" },
        el("h2", { class: "card-title" }, t("profile.identity")),
        el("p", { class: "card-sub" }, t("profile.identitySub")),

        el(
          "div",
          { class: "row", style: { marginBottom: "16px" } },
          user.avatarUrl
            ? el("img", { class: "avatar avatar-lg", src: user.avatarUrl, alt: "" })
            : el("div", { class: "avatar avatar-lg" }),
          el(
            "div",
            { class: "stack grow" },
            el("strong", { class: "truncate" }, user.displayName),
            el("span", { class: "muted truncate", style: { fontSize: "13px" } }, user.email)
          )
        ),

        el(
          "div",
          { class: "field" },
          el("label", { class: "label", for: "pf-name" }, t("profile.displayName")),
          el("input", {
            id: "pf-name",
            class: "input",
            value: draft.displayName,
            placeholder: t("profile.displayNamePlaceholder"),
            maxlength: "40",
            onInput: (e) => (draft.displayName = e.target.value),
          })
        )
      ),

      /* Preferences ---------------------------------------------------- */
      el(
        "section",
        { class: "card" },
        el("h2", { class: "card-title" }, t("profile.preferences")),
        el("p", { class: "card-sub" }, t("profile.preferencesSub")),

        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("profile.theme")),
          segmented(
            [
              ["light", t("profile.themeLight")],
              ["dark", t("profile.themeDark")],
            ],
            draft.themeMode,
            (key) => {
              draft.themeMode = key;
              applyTheme({ mode: key });
              render();
            }
          )
        ),

        el(
          "div",
          { class: "field" },
          el("span", { class: "label" }, t("profile.faction")),
          segmented(
            [
              ["horde", "Horde"],
              ["alliance", "Alliance"],
            ],
            getTheme().faction,
            (key) => {
              applyTheme({ faction: key });
              localStorage.setItem("nf_faction", key);
              render();
            }
          ),
          el("p", { class: "hint" }, t("profile.factionSub"))
        )
      ),

      /* Time zone ------------------------------------------------------ */
      timeCard(refs),

      /* Linked accounts ------------------------------------------------ */
      el(
        "section",
        { class: "card" },
        el("h2", { class: "card-title" }, t("profile.linked")),
        el("p", { class: "card-sub" }, t("profile.linkedSub")),

        linkRow({
          name: t("profile.discord"),
          hint: t("profile.discordHint"),
          icon: "discord",
          provider: "discord",
          connected: Boolean(user.discordId),
          value: user.discordTag,
          copyable: user.discordTag,
          onChange: render,
        }),

        linkRow({
          name: t("profile.battlenet"),
          hint: battlenetHint(user),
          icon: "battlenet",
          provider: "battlenet",
          connected: Boolean(user.battlenetId),
          value: user.battleTag || t("profile.isLinked"),
          copyable: user.battleTag,
          onChange: render,
          // Re-running the link is the refresh. Blizzard's tokens are short
          // lived and we deliberately don't store them, so there's nothing
          // to poll with — and nothing running in the background either.
          secondaryAction: el(
            "button",
            {
              class: "btn btn-sm btn-ghost",
              title: t("profile.recheckHint"),
              onClick: () => {
                window.location.href = api.linkUrl("battlenet");
              },
            },
            t("profile.recheck")
          ),
        }),

        /* WhatsApp is data we hold rather than an account we connect, so it
           gets fields instead of a Connect button. */
        el(
          "div",
          { class: "link-row link-row-open" },
          el(
            "div",
            { class: "link-head" },
            el("span", { class: "link-icon" }, "🟢"),
            el("strong", { class: "link-name" }, t("profile.whatsapp"))
          ),
          el(
            "div",
            { class: "field-row", style: { marginTop: "10px" } },
            el(
              "div",
              { class: "field" },
              el("label", { class: "label", for: "pf-wa-phone" }, t("profile.whatsappPhone")),
              el("input", {
                id: "pf-wa-phone",
                class: `input ${phoneError ? "is-invalid" : ""}`,
                type: "tel",
                inputmode: "tel",
                value: draft.whatsappPhone,
                placeholder: t("profile.whatsappPhonePlaceholder"),
                maxlength: "20",
                onInput: (e) => (draft.whatsappPhone = e.target.value),
              })
            ),
            el(
              "div",
              { class: "field" },
              el("label", { class: "label", for: "pf-wa-user" }, t("profile.whatsappUsername")),
              el("input", {
                id: "pf-wa-user",
                class: "input",
                value: draft.whatsappUsername,
                placeholder: t("profile.whatsappUsernamePlaceholder"),
                maxlength: "40",
                onInput: (e) => (draft.whatsappUsername = e.target.value),
              })
            )
          ),
          el(
            "p",
            { class: `hint ${phoneError ? "hint-error" : ""}` },
            phoneError ? t("profile.invalidPhone") : t("profile.whatsappPhoneHint")
          )
        ),

        linkRow({
          name: t("profile.telegram"),
          hint: t("profile.telegramHint"),
          icon: "telegram",
          connected: false,
        }),

        linkRow({
          name: t("profile.mobileApp"),
          hint: t("profile.mobileAppHint"),
          icon: "app",
          connected: false,
          actionLabel: t("profile.download"),
        })
      ),

      (saveBtn = el("button", { class: "btn btn-primary", onClick: save }, t("profile.save")))
    );
  }

  render();
}
