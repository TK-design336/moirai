/** Shared scroll-tracking copy button positioning (code blocks + draft blocks). */

export const FLOATING_COPY_PAD = 6;
export const FLOATING_COPY_BTN_H = 28;
export const FLOATING_COPY_VIEW_MARGIN = 8;

export function collectVerticalScrollRoots(wrap: HTMLElement): HTMLElement[] {
  const roots = new Set<HTMLElement | Window>();
  roots.add(window);

  const cm = wrap.closest(".chat-messages");
  if (cm instanceof HTMLElement) roots.add(cm);

  let n: HTMLElement | null = wrap.parentElement;
  while (n) {
    const { overflowY } = getComputedStyle(n);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      roots.add(n);
    }
    n = n.parentElement;
  }
  return [...roots] as HTMLElement[];
}

export function computeFloatingCopyTopPx(wrapRect: DOMRect, clipRect: DOMRect | null): number {
  const pad = FLOATING_COPY_PAD;
  const btnH = FLOATING_COPY_BTN_H;
  const vm = FLOATING_COPY_VIEW_MARGIN;
  const visibleTop = clipRect?.top ?? 0;
  const visibleBottom = clipRect?.bottom ?? window.innerHeight;
  const blockHi = Math.max(pad, wrapRect.height - btnH - pad);
  const viewLo = visibleTop + vm - wrapRect.top;
  const viewHi = visibleBottom - vm - btnH - wrapRect.top;
  const lo = Math.max(pad, viewLo);
  const hi = Math.min(blockHi, viewHi);
  if (lo <= hi) return Math.min(Math.max(pad, lo), hi);
  return pad;
}
