import { el } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { APP } from "../config/app.js";

const googleMark = `
<svg viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.9 2.6 13.7l7.8 6.1C12.3 13.9 17.6 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17.3z"/>
  <path fill="#FBBC05" d="M10.4 28.2c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.1 0 19.9 0 23.5s1 7.4 2.6 10.8l7.8-6.1z"/>
  <path fill="#34A853" d="M24 47c6.2 0 11.5-2 15.3-5.6l-7.5-5.8c-2.1 1.4-4.8 2.2-7.8 2.2-6.4 0-11.7-4.4-13.6-10.3l-7.8 6.1C6.5 41.1 14.6 47 24 47z"/>
</svg>`;

export function renderSignIn(root, { error } = {}) {
  const next = sessionStorage.getItem("nf_next") || "/me/characters";

  root.replaceChildren(
    el(
      "div",
      { class: "signin-wrap" },
      el(
        "div",
        { class: "signin" },
        el("div", { class: "signin-step" }, t("signin.step")),
        el("h1", {}, APP.name),
        el("p", {}, t("signin.blurb")),

        error &&
          el("div", { class: "banner banner-error" }, t(`error.${error}`) || t("error.generic")),

        el(
          "button",
          {
            class: "btn btn-google",
            onClick: () => {
              window.location.href = api.loginUrl(next);
            },
          },
          el("span", { html: googleMark, style: { display: "flex" } }),
          t("signin.google")
        ),

        el("div", { class: "signin-foot" }, t("signin.foot"))
      )
    )
  );
}
