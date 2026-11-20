/**
 * Sign-in, step 2: connect Battle.net.
 *
 * Google is always the identity (Battle.net gives no email, so it can't be
 * the account key without creating duplicates). Every Google sign-in lands
 * here; if Battle.net is already linked we forward straight on, otherwise we
 * ask for it.
 *
 * Back signs out so a different Google account can be chosen — Google shows
 * its account picker every time. Skip exists so a Blizzard outage on launch
 * day doesn't lock anyone out; remove it to make Battle.net mandatory.
 */
import { el } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { store } from "../core/store.js";
import * as router from "../core/router.js";
import { APP } from "../config/app.js";

const NEXT_KEY = "nf_welcome_next";
const bnetMark = `
<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#148eff"/>
<path fill="#fff" d="M8 7h5.2c2 0 3.3 1 3.3 2.6 0 1-.6 1.8-1.5 2.1 1.1.3 1.9 1.2 1.9 2.4 0 1.8-1.4 2.9-3.6 2.9H8V7zm2.2 1.9v2.2h2.6c.8 0 1.3-.4 1.3-1.1s-.5-1.1-1.3-1.1h-2.6zm0 4v2.3h2.9c.9 0 1.4-.4 1.4-1.1 0-.8-.5-1.2-1.4-1.2h-2.9z"/></svg>`;

function safePath(p) {
  return typeof p === "string" && /^\/[\w\-/]*$/.test(p) ? p : "/me/characters";
}

function forward() {
  const next = safePath(sessionStorage.getItem(NEXT_KEY));
  sessionStorage.removeItem(NEXT_KEY);
  sessionStorage.removeItem("nf_next");
  router.navigate(next === "/" ? "/me/characters" : next, { replace: true });
}

export async function renderWelcome(root, { signOut }) {
  const query = router.currentQuery();
  if (query.get("next")) sessionStorage.setItem(NEXT_KEY, query.get("next"));
  const linkResult = query.get("link");

  // Coming back from Blizzard successfully: pick up the new link, move on.
  if (linkResult === "ok") {
    try {
      store.hydrate(await api.me());
    } catch {
      /* forward anyway; the profile page will show the state */
    }
    return forward();
  }

  if (store.user?.battlenetId) return forward();

  const user = store.user || {};
  const failed = linkResult && linkResult !== "ok";
  const failKey = `profile.link_${linkResult}`;
  const failText = failed ? (t(failKey) === failKey ? t("error.generic") : t(failKey)) : null;

  // Clean the URL so a refresh doesn't re-announce a failure.
  if (linkResult) history.replaceState(null, "", `${location.pathname}#/welcome`);

  root.replaceChildren(
    el(
      "div",
      { class: "signin-wrap" },
      el(
        "div",
        { class: "signin" },
        el("div", { class: "signin-step" }, t("welcome.step")),
        el("h1", {}, t("welcome.title")),
        el("p", {}, t("welcome.blurb")),

        el(
          "div",
          { class: "welcome-account" },
          user.avatarUrl
            ? el("img", { class: "avatar avatar-sm", src: user.avatarUrl, alt: "" })
            : el("div", { class: "avatar avatar-sm" }),
          el(
            "div",
            { class: "welcome-account-text" },
            el("strong", { class: "truncate" }, user.displayName || ""),
            el("span", { class: "muted truncate" }, user.email || "")
          )
        ),

        failText && el("div", { class: "banner banner-error" }, failText),

        el(
          "button",
          {
            class: "btn btn-bnet",
            onClick: () => {
              window.location.href = api.linkUrl("battlenet", "/welcome");
            },
          },
          el("span", { html: bnetMark, style: { display: "flex" } }),
          t("welcome.connect")
        ),

        el(
          "div",
          { class: "welcome-actions" },
          el(
            "button",
            { class: "btn btn-ghost", onClick: () => signOut() },
            "← ",
            t("welcome.back")
          ),
          el("button", { class: "btn-link", onClick: forward }, t("welcome.skip"))
        ),

        el("div", { class: "signin-foot" }, t("welcome.foot", { app: APP.name }))
      )
    )
  );
}
