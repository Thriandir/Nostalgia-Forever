/**
 * Nostalgia Forever — entry point.
 *
 * Boot order: theme → locale → session → router.
 * Theme and locale come first so an unauthenticated user never sees a flash
 * of the wrong palette.
 */

import { APP } from "./config/app.js";
import { el, mount } from "./core/dom.js";
import { t, setLocale, detectLocale, getLocale } from "./core/i18n.js";
import { applyTheme, detectMode } from "./core/theme.js";
import { api, ApiError } from "./core/api.js";
import { store, subscribe } from "./core/store.js";
import * as router from "./core/router.js";
import { renderSignIn } from "./views/signin.js";
import { renderProfile } from "./views/profile.js";
import { renderCharacters } from "./views/characters.js";
import { renderGuilds, renderJoin } from "./views/guilds.js";
import { renderProgression } from "./views/progression.js";
import { renderCalendar } from "./views/calendar.js";
import { renderRaid } from "./views/raid.js";
import { renderChangelog } from "./views/changelog.js";
import { renderWelcome } from "./views/welcome.js";

const root = document.getElementById("app");

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

/** Compact EN | TR switch. Lives in the chrome so it's reachable everywhere. */
function languageToggle() {
  const current = getLocale();
  return el(
    "div",
    { class: "segmented segmented-sm", role: "group", "aria-label": t("nav.language") },
    APP.locales.map((code) =>
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(code === current),
          onClick: () => changeLocale(code),
        },
        code.toUpperCase()
      )
    )
  );
}

/**
 * Account menu. Sign out lives in here deliberately — a bare button in the
 * corner is too easy to hit by accident.
 */
function accountMenu() {
  const user = store.user;
  const menu = el("div", { class: "menu-panel", hidden: true, role: "menu" });

  const button = el(
    "button",
    {
      class: "menu-trigger",
      "aria-haspopup": "true",
      "aria-expanded": "false",
      "aria-label": t("nav.menu"),
      onClick: (e) => {
        e.stopPropagation();
        toggle();
      },
    },
    user?.avatarUrl
      ? el("img", { class: "avatar avatar-sm", src: user.avatarUrl, alt: "" })
      : el("span", { class: "avatar avatar-sm" }),
    el("span", { class: "menu-caret", "aria-hidden": "true" }, "▾")
  );

  function close() {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside);
  }
  function onOutside() {
    close();
  }
  function toggle() {
    if (menu.hidden) {
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      setTimeout(() => document.addEventListener("click", onOutside), 0);
    } else {
      close();
    }
  }

  mount(
    menu,
    el(
      "div",
      { class: "menu-head" },
      el("strong", { class: "truncate" }, user?.displayName || ""),
      el("span", { class: "muted truncate", style: { fontSize: "12px" } }, user?.email || "")
    ),
    el(
      "button",
      {
        class: "menu-item",
        role: "menuitem",
        onClick: () => {
          close();
          router.navigate("/me/profile");
        },
      },
      t("nav.profile")
    ),
    el("div", { class: "menu-sep" }),
    el(
      "button",
      { class: "menu-item menu-item-quiet", role: "menuitem", onClick: signOut },
      t("nav.signOut")
    )
  );

  return el("div", { class: "menu" }, button, menu);
}

function topbar() {
  // Characters and Guilds stay visible at all times — they're what people
  // actually move between. Everything else goes in the account menu.
  const nav = [
    ["/me/characters", t("nav.characters")],
    ["/me/guilds", t("nav.guilds")],
  ];

  // Progression only appears once you're in a guild, since it's meaningless
  // without one.
  const guildId = store.activeGuildId || store.memberships[0]?.guildId;
  if (guildId) {
    nav.push([`/g/${guildId}/progression`, t("nav.progression")]);
    nav.push([`/g/${guildId}/calendar`, t("nav.calendar")]);
  }

  // Top level during testing so testers trip over it rather than hunt for it.
  nav.push(["/changelog", t("nav.changelog")]);

  const here = router.currentPath();

  return el(
    "header",
    { class: "topbar" },
    el(
      "div",
      { class: "brand" },
      el("span", { class: "brand-name" }, APP.name),
      el("span", { class: "brand-sub" }, t("app.tagline"))
    ),
    el(
      "nav",
      { class: "topbar-nav" },
      nav.map(([path, label]) =>
        el(
          "button",
          {
            class: `btn btn-sm ${here === path ? "" : "btn-ghost"}`,
            onClick: () => router.navigate(path),
          },
          label
        )
      )
    ),
    el("div", { class: "topbar-actions" }, languageToggle(), accountMenu())
  );
}

/** Which guild the nav was last built for, so we only rebuild when it moves. */
let chromeGuildId = null;

function navGuildId() {
  return store.activeGuildId || store.memberships[0]?.guildId || null;
}

function shell(content) {
  mount(root, topbar(), el("main", { class: "main" }, content));
  chromeGuildId = navGuildId();
  return root.querySelector(".main");
}

/**
 * Rebuild the top bar in place.
 *
 * Re-running the whole route would also work, but it would discard any
 * unsaved edits in the form the user is standing in.
 */
export function refreshChrome() {
  const existing = root.querySelector(".topbar");
  if (existing) existing.replaceWith(topbar());
  chromeGuildId = navGuildId();
}

/**
 * The nav depends on state that views change underneath it — joining or
 * creating a guild adds the Progression tab. Without this, the tab wouldn't
 * appear until the next navigation, which reads as "nothing happened".
 *
 * Guarded on the guild actually changing, so ordinary character edits don't
 * rebuild the chrome on every keystroke.
 */
subscribe(() => {
  if (navGuildId() !== chromeGuildId) refreshChrome();
});

/** Switch language, persist it, and update both chrome and content. */
export async function changeLocale(code) {
  if (code === getLocale()) return;
  setLocale(code);
  refreshChrome();
  router.resolve();
  if (store.signedIn && store.user.locale !== code) {
    try {
      const { user } = await api.updateProfile({ locale: code });
      store.setUser(user);
    } catch {
      /* the UI is already switched; persisting is best-effort */
    }
  }
}

async function signOut() {
  try {
    await api.logout();
  } catch {
    /* clearing locally is enough */
  }
  store.clear();
  sessionStorage.removeItem("nf_next");
  router.navigate("/", { replace: true });
}

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

function requireAuth(render) {
  return (ctx) => {
    if (!store.signedIn) {
      sessionStorage.setItem("nf_next", ctx.path);
      renderSignIn(root, {});
      return;
    }
    const main = shell(el("div"));
    render(main, ctx);
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

router.register("/", () => {
  if (!store.signedIn) {
    const error = router.currentQuery().get("error");
    renderSignIn(root, { error });
    return;
  }
  router.navigate(store.characters.length ? "/me/characters" : "/me/characters", {
    replace: true,
  });
});

// Sign-in step 2. Full-screen like sign-in, so it skips the app shell.
router.register("/welcome", () => {
  if (!store.signedIn) return renderSignIn(root, {});
  renderWelcome(root, { signOut });
});

router.register("/me/profile", requireAuth((main) => renderProfile(main)));

router.register("/me/characters", requireAuth((main) => renderCharacters(main)));

router.register("/me/guilds", requireAuth((main) => renderGuilds(main)));

router.register(
  "/join/:code",
  requireAuth((main, ctx) => renderJoin(main, ctx.params.code.toUpperCase()))
);

/* Guild zone ------------------------------------------------------- */

router.register(
  "/g/:guildId/progression",
  requireAuth((main, ctx) => {
    // Data-dense and desktop-only, so it breaks out of the reading-width
    // constraint the rest of the app uses.
    main.classList.add("main-wide");
    store.setActiveGuild(ctx.params.guildId);
    renderProgression(main, ctx.params.guildId);
  })
);

router.register(
  "/g/:guildId/calendar",
  requireAuth((main, ctx) => {
    main.classList.add("main-wide");
    store.setActiveGuild(ctx.params.guildId);
    renderCalendar(main, ctx.params.guildId);
  })
);

router.register("/changelog", requireAuth((main) => renderChangelog(main)));

router.register(
  "/r/:raidId",
  requireAuth((main, ctx) => renderRaid(main, ctx.params.raidId))
);

router.setNotFound(() => router.navigate("/", { replace: true }));

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  applyTheme({
    faction: localStorage.getItem("nf_faction") || APP.defaultFaction,
    mode: detectMode(),
  });
  setLocale(detectLocale());

  try {
    const me = await api.me();
    store.hydrate(me);
    setLocale(me.user.locale || detectLocale());
    applyTheme({ mode: me.user.themeMode || detectMode() });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      // A network failure shouldn't look like a sign-out.
      if (err instanceof ApiError && err.code === "network") {
        mount(
          root,
          el(
            "div",
            { class: "signin-wrap" },
            el(
              "div",
              { class: "signin" },
              el("h1", {}, APP.name),
              el("div", { class: "banner banner-error" }, t("error.network")),
              el(
                "button",
                { class: "btn btn-primary", onClick: () => location.reload() },
                t("common.retry")
              )
            )
          )
        );
        return;
      }
    }
    store.clear();
  }

  router.start();
}

boot();
