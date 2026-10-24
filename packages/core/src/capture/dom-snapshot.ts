import type { DOMSnapshot } from "./types.js";

/**
 * Injected into the Playwright page via page.evaluate()
 */
export function extractDOMSnapshotInBrowser(): DOMSnapshot {
  const MAX_ELEMENTS = 3000;
  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;

  function generateSelector(el: Element): string {
    if (el.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(el.id)) {
      const idSelector = `#${el.id}`;
      if (document.querySelectorAll(idSelector).length === 1) {
        return idSelector;
      }
    }

    const path: string[] = [];
    let current: Element | null = el;

    while (current && current !== document.documentElement && path.length < 5) {
      let selector = current.tagName.toLowerCase();
      if (current.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(current.id)) {
        selector += `#${current.id}`;
        path.unshift(selector);
        break;
      }

      if (current.classList && current.classList.length > 0) {
        const validClasses = Array.from(current.classList)
          .filter((cls) => /^[a-zA-Z0-9_-]+$/.test(cls) && !cls.includes(":"))
          .slice(0, 2);
        if (validClasses.length > 0) {
          selector += `.${validClasses.join(".")}`;
        }
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current?.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(" > ") || el.tagName.toLowerCase();
  }

  const allElements = document.querySelectorAll("*");
  const elements = [];
  const elementToId = new Map<Element, string>();

  let counter = 0;
  for (let i = 0; i < allElements.length; i++) {
    if (elements.length >= MAX_ELEMENTS) break;

    const el = allElements[i] as HTMLElement;
    if (!el || typeof el.getBoundingClientRect !== "function") continue;

    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity || "1") === 0
    ) {
      continue;
    }

    const clientRect = el.getBoundingClientRect();
    if (clientRect.width === 0 && clientRect.height === 0) {
      continue;
    }

    // Coordinates in document CSS pixels
    const docX = clientRect.left + scrollX;
    const docY = clientRect.top + scrollY;

    const zIndexParsed = parseInt(style.zIndex, 10);
    const zIndex = isNaN(zIndexParsed) ? 0 : zIndexParsed;

    const tagName = el.tagName.toLowerCase();
    const isInteractive =
      tagName === "button" ||
      tagName === "a" ||
      tagName === "input" ||
      tagName === "select" ||
      tagName === "textarea" ||
      style.cursor === "pointer" ||
      el.getAttribute("role") === "button" ||
      el.getAttribute("role") === "link" ||
      el.getAttribute("role") === "checkbox" ||
      el.getAttribute("role") === "menuitem" ||
      (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1");

    // Shallow text snippet (direct text or short innerText)
    let text = "";
    if (
      tagName !== "script" &&
      tagName !== "style" &&
      tagName !== "svg" &&
      tagName !== "path"
    ) {
      const rawText = el.innerText || el.textContent || "";
      text = rawText.trim().replace(/\s+/g, " ").slice(0, 120);
    }

    const isClipped =
      (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) &&
      (style.overflow === "hidden" ||
        style.overflowX === "hidden" ||
        style.overflowY === "hidden" ||
        style.overflow === "clip");

    const id = `el-${counter++}`;
    elementToId.set(el, id);

    let parentId: string | null = null;
    let p = el.parentElement;
    while (p) {
      if (elementToId.has(p)) {
        parentId = elementToId.get(p)!;
        break;
      }
      p = p.parentElement;
    }

    elements.push({
      id,
      selector: generateSelector(el),
      tagName,
      text,
      rect: {
        x: Math.round(docX),
        y: Math.round(docY),
        width: Math.round(clientRect.width),
        height: Math.round(clientRect.height),
        top: Math.round(docY),
        left: Math.round(docX),
        right: Math.round(docX + clientRect.width),
        bottom: Math.round(docY + clientRect.height)
      },
      styles: {
        zIndex,
        overflow: style.overflow || "visible",
        overflowX: style.overflowX || "visible",
        overflowY: style.overflowY || "visible",
        position: style.position || "static",
        display: style.display || "block",
        visibility: style.visibility || "visible",
        opacity: parseFloat(style.opacity || "1"),
        fontSize: style.fontSize || "",
        lineHeight: style.lineHeight || "",
        color: style.color || "",
        backgroundColor: style.backgroundColor || ""
      },
      metrics: {
        scrollWidth: el.scrollWidth || 0,
        scrollHeight: el.scrollHeight || 0,
        clientWidth: el.clientWidth || 0,
        clientHeight: el.clientHeight || 0
      },
      isInteractive,
      isClipped,
      parentId
    });
  }

  const docEl = document.documentElement;
  const body = document.body;

  const docScrollWidth = Math.max(
    docEl?.scrollWidth || 0,
    body?.scrollWidth || 0,
    window.innerWidth
  );
  const docScrollHeight = Math.max(
    docEl?.scrollHeight || 0,
    body?.scrollHeight || 0,
    window.innerHeight
  );

  return {
    document: {
      scrollWidth: Math.round(docScrollWidth),
      scrollHeight: Math.round(docScrollHeight),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    },
    elements
  };
}
