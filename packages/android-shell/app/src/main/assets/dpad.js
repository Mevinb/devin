(() => {
  if (window.__pixelSentinelDpad) return;
  window.__pixelSentinelDpad = true;
  const vectors = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  document.addEventListener("keydown", (event) => {
    const direction = vectors[event.key];
    const active = document.activeElement;
    if (!direction || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (active?.matches("input,textarea,select,[contenteditable]:not([contenteditable=false])")) return;
    // Let the page's handlers and WebView's own navigation run first. Fall back only
    // if neither handled the key nor moved focus; native key events still reach the page.
    setTimeout(() => {
      if (event.defaultPrevented || document.activeElement !== active) return;
      const candidates = [...document.querySelectorAll("a[href],button,input,textarea,select,[tabindex]")].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return element !== active && element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") &&
          rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
      const rect = active?.getBoundingClientRect();
      let next;
      if (!rect || active === document.body || active === document.documentElement) next = candidates[0];
      else {
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        let best = Infinity;
        for (const element of candidates) {
          const box = element.getBoundingClientRect();
          const dx = box.x + box.width / 2 - x, dy = box.y + box.height / 2 - y;
          const forward = dx * direction[0] + dy * direction[1];
          const sideways = Math.abs(dx * direction[1] - dy * direction[0]);
          if (forward <= 1) continue;
          const score = forward + 3 * sideways;
          if (score < best) { best = score; next = element; }
        }
      }
      if (next) { next.focus({ preventScroll: true }); next.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    }, 0);
  });
})();
