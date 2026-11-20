import { el, mount } from "../core/dom.js";
import { t, formatDate } from "../core/i18n.js";
import { CHANGELOG } from "../config/changelog.js";

/**
 * What changed, newest first.
 *
 * Kept as a top-level nav item during testing rather than tucked into the
 * account menu — testers need to know what's new without being told, and
 * something they have to hunt for may as well not exist. Move it into the
 * menu once the guild is using the app for real.
 */

const TYPE_ORDER = ["added", "changed", "fixed", "note"];

export function renderChangelog(root) {
  mount(
    root,
    el(
      "div",
      { class: "page-head" },
      el("h1", { class: "page-title" }, t("changelog.title")),
      el("p", { class: "page-sub" }, t("changelog.sub"))
    ),

    el(
      "div",
      { class: "changelog" },
      CHANGELOG.map((day) => {
        // Group within a day so additions read before fixes.
        const grouped = TYPE_ORDER.map((type) => ({
          type,
          items: day.entries.filter((e) => e.type === type),
        })).filter((g) => g.items.length);

        return el(
          "section",
          { class: "log-day" },
          el(
            "div",
            { class: "log-date" },
            el("strong", {}, formatDate(`${day.date}T12:00:00Z`, { dateStyle: "long" })),
            el("span", { class: "log-count" }, t("changelog.changes", { count: day.entries.length }))
          ),
          el(
            "div",
            { class: "log-entries" },
            grouped.map((group) =>
              group.items.map((entry) =>
                el(
                  "div",
                  { class: "log-entry" },
                  el("span", { class: `log-tag is-${entry.type}` }, t(`changelog.${entry.type}`)),
                  el("span", { class: "log-text" }, entry.text)
                )
              )
            )
          )
        );
      })
    )
  );
}
