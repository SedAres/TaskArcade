/* ==========================================================================
   TaskArcade — touch gestures
   Swipe-to-complete / swipe-to-defer and long-press for the action sheet.
   Written with pointer events so the same code path works with a mouse, a
   finger and a stylus; drags that start on a button or a scrollable handle are
   ignored so normal tapping still feels immediate.
   ========================================================================== */

import { isTouch } from "./core.js";

const SWIPE_THRESHOLD = 88;
const SWIPE_MAX = 132;
const LONG_PRESS_MS = 520;
const MOVE_TOLERANCE = 14;

/**
 * Attach swipe handling to an element.
 * opts: { onRight(), onLeft(), axis: "x", className }
 */
export function attachSwipe(node, { onRight, onLeft, threshold = SWIPE_THRESHOLD } = {}) {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let lockedAxis = null;
  let delta = 0;
  let moved = false;

  const reset = (animate = true) => {
    tracking = false;
    lockedAxis = null;
    delta = 0;
    node.classList.remove("is-swiping", "swiping-left", "swiping-right");
    node.style.transition = animate ? "transform 180ms cubic-bezier(.16,1,.3,1)" : "";
    node.style.transform = "";
    window.setTimeout(() => { node.style.transition = ""; }, 200);
  };

  node.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.target.closest("button, a, input, textarea, select, .task-drag, [data-no-swipe]")) return;
      startX = event.clientX;
      startY = event.clientY;
      tracking = true;
      lockedAxis = null;
      moved = false;
      delta = 0;
      node.style.transition = "none";
    },
    { passive: true },
  );

  node.addEventListener(
    "pointermove",
    (event) => {
      if (!tracking) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      if (!lockedAxis) {
        if (Math.abs(dx) < MOVE_TOLERANCE && Math.abs(dy) < MOVE_TOLERANCE) return;
        lockedAxis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
        if (lockedAxis === "x") node.classList.add("is-swiping");
      }
      if (lockedAxis !== "x") {
        if (Math.abs(dy) > MOVE_TOLERANCE) reset(false);
        return;
      }

      moved = true;
      delta = dx;
      const resistance = Math.sign(delta) * Math.min(Math.abs(delta), SWIPE_MAX) * 0.9;
      node.style.transform = `translateX(${resistance}px)`;
      node.classList.toggle("swiping-right", delta > 20);
      node.classList.toggle("swiping-left", delta < -20);

      if ((delta > 0 && !onRight) || (delta < 0 && !onLeft)) {
        node.style.transform = `translateX(${resistance * 0.25}px)`;
      }
    },
    { passive: true },
  );

  const finish = () => {
    if (!tracking) return;
    const finalDelta = delta;
    const wasTracking = lockedAxis === "x";
    reset(true);
    if (!wasTracking || !moved) return;
    if (finalDelta > threshold && onRight) onRight();
    else if (finalDelta < -threshold && onLeft) onLeft();
  };

  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", () => reset(false));
  node.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") finish();
  });
}

/**
 * Long-press → handler(). Uses pointer events and cancels if the finger moves.
 */
export function attachLongPress(node, handler, { delay = LONG_PRESS_MS } = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  const cancel = () => {
    if (timer) window.clearTimeout(timer);
    timer = null;
  };

  node.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, a, input, textarea, select, .task-drag")) return;
    startX = event.clientX;
    startY = event.clientY;
    fired = false;
    cancel();
    timer = window.setTimeout(() => {
      fired = true;
      handler();
    }, delay);
  });

  node.addEventListener("pointermove", (event) => {
    if (Math.abs(event.clientX - startX) > 12 || Math.abs(event.clientY - startY) > 12) cancel();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) => node.addEventListener(type, cancel));
  node.addEventListener("contextmenu", (event) => {
    if (isTouch()) {
      event.preventDefault();
      if (!fired) handler();
    }
  });
}

/**
 * Horizontal wheel / shift-wheel navigation used by the board layout on
 * desktop so users can page between days without a trackpad gesture.
 */
export function attachHorizontalWheel(node) {
  node.addEventListener(
    "wheel",
    (event) => {
      if (node.scrollWidth <= node.clientWidth) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (!event.shiftKey) return;
      node.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false },
  );
}

/** Keyboard reordering: Alt + ↑/↓ moves the focused task. */
export function attachKeyboardReorder(node, { onMove }) {
  node.addEventListener("keydown", (event) => {
    if (!event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onMove(event.key === "ArrowUp" ? -1 : 1);
  });
}
