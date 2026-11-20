/**
 * Tiny DOM helpers. No framework, no build step.
 *
 *   el("div", { class: "card" }, el("h2", {}, "Hello"))
 *   el("button", { onClick: fn, disabled: true }, "Save")
 */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") applyStyle(node, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "html") node.innerHTML = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }

  append(node, children);
  return node;
}

/**
 * Apply a style object.
 *
 * Custom properties MUST go through setProperty — assigning them as ordinary
 * keys on CSSStyleDeclaration silently does nothing, which is exactly the
 * kind of failure that looks like a CSS problem for an hour.
 */
function applyStyle(node, styles) {
  for (const [prop, value] of Object.entries(styles)) {
    if (value === null || value === undefined) continue;
    if (prop.startsWith("--")) node.style.setProperty(prop, String(value));
    else node.style[prop] = value;
  }
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

let toastTimer = null;
export function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = el("div", { class: "toast", role: "status" }, message);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2600);
}
