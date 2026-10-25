import crypto from "node:crypto";
import type { DOMElementSnapshot, DOMSnapshot } from "../capture/types.js";

export function isDialogContainer(element: DOMElementSnapshot): boolean {
  return element.tagName === "dialog" || ["dialog", "alertdialog"].includes(element.role ?? "") || element.ariaModal === true ||
    (/modal|dialog/i.test(element.selector) && ["fixed", "absolute"].includes(element.styles.position));
}

export function computeStateFingerprint(domSnapshot: DOMSnapshot, url: string): {
  fingerprint: string;
  name: string;
} {
  const visibleElements = domSnapshot.elements.filter((el) => {
    return el.rect.width > 0 && el.rect.height > 0 && el.styles.visibility !== "hidden";
  });

  // Collect structural tokens
  const tokens: string[] = [];
  try {
    const parsedUrl = new URL(url);
    tokens.push(`path:${parsedUrl.pathname}`);
  } catch {
    tokens.push(`path:${url}`);
  }

  // Detect open dialogs, modals, drawers
  const hasModal = visibleElements.some(isDialogContainer);

  // Detect key headings and modal titles. Headings inside <header>/<nav> (site branding) don't describe
  // the state, so content headings win; a visible modal's title wins over everything.
  const byId = new Map(visibleElements.map((el) => [el.id, el]));
  const inChrome = (el: (typeof visibleElements)[number]) => {
    for (let p = el.parentId ? byId.get(el.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
      if (p.tagName === "header" || p.tagName === "nav" || p.selector.includes("topbar")) return true;
    }
    return false;
  };
  const inModal = (el: (typeof visibleElements)[number]) => {
    for (let p: (typeof visibleElements)[number] | undefined = el; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
      if (isDialogContainer(p)) return true;
    }
    return false;
  };
  const headingEls = visibleElements.filter((el) => el.tagName.match(/^h[1-3]$/) || el.selector.includes("title"));
  const ranked = [
    ...headingEls.filter(inModal),
    ...headingEls.filter((el) => !inModal(el) && !inChrome(el)),
    ...headingEls.filter((el) => !inModal(el) && inChrome(el))
  ];
  const headings = ranked
    .map((el) => el.text.trim())
    .filter(Boolean)
    .slice(0, 3);

  // Extract structural hierarchy
  for (const el of visibleElements.slice(0, 300)) {
    // Filter dynamic tokens from class names
    const cleanClasses = el.selector
      .replace(/#[a-zA-Z0-9_-]+/g, "")
      .replace(/:nth-of-type\(\d+\)/g, "")
      .replace(/\.css-[a-z0-9]+/g, "")
      .replace(/\.[a-zA-Z0-9_-]{12,}/g, "") // likely random hash
      .trim();

    tokens.push(`${el.tagName}[${cleanClasses}]`);
  }

  const hashInput = tokens.join("|");
  const fingerprint = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 16);

  // Derive human-readable state label
  let name = headings[0] || "";
  if (hasModal) {
    name = name ? `Modal: ${name}` : "Open Modal / Dialog";
  } else if (!name) {
    try {
      const parsedUrl = new URL(url);
      name = parsedUrl.pathname === "/" ? "Home View" : parsedUrl.pathname;
    } catch {
      name = "Main View";
    }
  }

  return { fingerprint, name };
}
