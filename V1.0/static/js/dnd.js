/* ==========================================================================
   TaskArcade — drag & drop
   Pointer-event based so it behaves identically with mouse, touch and pen.
   Works for:
     * the Now list (single container)
     * the timeline (many containers — dragging between days moves the task)
   The dragged node is moved live in the DOM and the resulting order is handed
   back through onDrop(orderedIds, context).
   ========================================================================== */

import { $$, emit } from "./core.js";

const HOLD_MS = 180;
const MOVE_TOLERANCE = 6;

let active = null;

export function initDragAndDrop(root, { selector, onDrop, getDay = null, handleSelector = null } = {}) {
  if (!root || root.dataset.dndInit === "true") return;
  root.dataset.dndInit = "true";

  const start = (event) => {
    const card = event.target.closest(selector);
    if (!card || !root.contains(card)) return;
    if (event.target.closest("button, a, input, select, textarea")) return;

    const handle = card.querySelector(".task-drag");
    const isHandle = handle && handle.contains(event.target);

    active = {
      card,
      startX: event.clientX,
      startY: event.clientY,
      armed: false,
      timer: null,
      pointerId: event.pointerId,
      root,
      selector,
      onDrop,
      getDay,
      sourceDay: card.dataset.day ? Number(card.dataset.day) : null,
    };

    if (isHandle || event.pointerType === "mouse") {
      // Handles (and mouse) start dragging immediately.
      window.setTimeout(() => {
        if (active && active.card === card) armDrag(active);
      }, 40);
    } else {
      active.timer = window.setTimeout(() => armDrag(active), HOLD_MS);
    }
  };

  const move = (event) => {
    if (!active) return;
    const dx = Math.abs(event.clientX - active.startX);
    const dy = Math.abs(event.clientY - active.startY);

    if (!active.armed) {
      if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
        if (active.timer && !active.card.querySelector(".task-drag")) {
          window.clearTimeout(active.timer);
          active = null;
        }
      }
      return;
    }

    event.preventDefault();
    positionGhost(event.clientX, event.clientY);
    const target = containerFromPoint(event.clientX, event.clientY) || active.sourceContainer;
    if (target) {
      const after = cardAfterPoint(target, event.clientY);
      if (after == null) target.appendChild(active.card);
      else if (after !== active.card) target.insertBefore(active.card, after);
      highlightContainer(target);
    }
  };

  const end = () => {
    if (!active) return;
    const finished = active;
    if (finished.timer) window.clearTimeout(finished.timer);
    if (!finished.armed) {
      active = null;
      return;
    }

    const container = finished.card.parentElement;
    const targetDay = container?.dataset.day ? Number(container.dataset.day) : finished.sourceDay;
    const ids = $$(selector, container).map((node) => Number(node.dataset.id));

    finished.card.classList.remove("is-dragging", "is-dragging-ghost");
    finished.card.style.position = "";
    finished.card.style.left = "";
    finished.card.style.top = "";
    finished.card.style.width = "";
    document.body.classList.remove("is-dragging-task");
    clearHighlights();
    active = null;

    const changed = targetDay !== finished.sourceDay || true;
    if (changed && ids.length) {
      emit("dnd-drop", { ids, day: targetDay, from: finished.sourceDay });
      finished.onDrop?.(ids, { day: targetDay, from: finished.sourceDay });
    }
  };

  root.addEventListener("pointerdown", start);
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  root.addEventListener("dragstart", (event) => event.preventDefault());
}

function armDrag(state) {
  if (!state || active !== state) return;
  state.armed = true;
  state.sourceContainer = state.card.parentElement;
  const rect = state.card.getBoundingClientRect();
  state.card.classList.add("is-dragging", "is-dragging-ghost");
  state.card.style.width = `${rect.width}px`;
  state.card.style.position = "fixed";
  state.card.style.left = `${rect.left}px`;
  state.card.style.top = `${rect.top}px`;
  document.body.classList.add("is-dragging-task");
  if (navigator.vibrate) navigator.vibrate(12);
}

function positionGhost(x, y) {
  if (!active?.armed) return;
  const rect = active.card.getBoundingClientRect();
  active.card.style.left = `${x - rect.width / 2}px`;
  active.card.style.top = `${y - 22}px`;
}

function containerFromPoint(x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element) return null;
  return element.closest("[data-dnd-container], .day-tasks, .task-list");
}

function cardAfterPoint(container, y) {
  const cards = $$(":scope > [data-id]:not(.is-dragging)", container);
  return cards.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null },
  ).element;
}

function highlightContainer(container) {
  clearHighlights();
  container?.classList.add("drag-over");
}

function clearHighlights() {
  $$(".drag-over").forEach((node) => node.classList.remove("drag-over"));
}

/** Programmatic reorder used by Ctrl/⌘ + ↑/↓ keyboard shortcuts. */
export function nudgeTask(node, direction, { onDrop, selector = "[data-id]" } = {}) {
  if (!node) return;
  const container = node.parentElement;
  const siblings = $$(selector, container);
  const index = siblings.indexOf(node);
  const target = siblings[index + direction];
  if (!target) return;
  if (direction < 0) container.insertBefore(node, target);
  else container.insertBefore(target, node);
  const ids = $$(selector, container).map((item) => Number(item.dataset.id));
  onDrop?.(ids, { day: container.dataset.day ? Number(container.dataset.day) : null });
  node.focus({ preventScroll: true });
}
