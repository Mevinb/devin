import crypto from "node:crypto";
import type { DOMSnapshot } from "../capture/types.js";

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
  const hasModal = visibleElements.some(
    (el) =>
      el.tagName === "dialog" ||
      el.selector.includes("modal") ||
      el.selector.includes("dialog") ||
      el.styles.zIndex > 50
  );

  // Detect key headings and modal titles
  const headings = visibleElements
    .filter((el) => el.tagName.match(/^h[1-3]$/) || el.selector.includes("title"))
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
