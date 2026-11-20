/**
 * Hash router covering the two zones:
 *   /me/*        personal zone, no guild context
 *   /g/:id/*     guild zone
 *
 * Hash-based so Cloudflare Pages needs no rewrite rules.
 */

const routes = [];
let notFound = null;
let onNavigate = null;

/** register("/me/profile", handler) — ":param" segments are captured. */
export function register(pattern, handler) {
  const names = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      names.push(seg.slice(1));
      return "([^/]+)";
    })
    .join("/");
  routes.push({ regex: new RegExp(`^${source}$`), names, handler });
}

export function setNotFound(handler) {
  notFound = handler;
}

export function setNavigationHook(fn) {
  onNavigate = fn;
}

export function currentPath() {
  const raw = location.hash.replace(/^#/, "");
  const path = raw.split("?")[0];
  return path || "/";
}

export function currentQuery() {
  const raw = location.hash.replace(/^#/, "");
  const idx = raw.indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : raw.slice(idx + 1));
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) return resolve();
  if (replace) history.replaceState(null, "", target);
  else location.hash = target;
  if (replace) resolve();
}

export function resolve() {
  const path = currentPath();
  for (const route of routes) {
    const match = route.regex.exec(path);
    if (!match) continue;
    const params = {};
    route.names.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1])));
    onNavigate?.(path);
    return route.handler({ params, query: currentQuery(), path });
  }
  onNavigate?.(path);
  return notFound?.({ path });
}

export function start() {
  window.addEventListener("hashchange", resolve);
  resolve();
}
