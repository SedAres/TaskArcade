/* ==========================================================================
   TaskArcade — accessible pointer-based sorting
   Reordering starts only from an explicit handle, so tapping, selecting text,
   opening a task and scrolling never accidentally become a drag. Pointer events
   cover mouse, touch and stylus; Alt+Arrow keys provide a keyboard equivalent.
   ========================================================================== */

import { emit } from "./core.js";

const MOVE_TOLERANCE = 5;
const DEFAULT_CONTAINERS = "[data-dnd-container], .day-tasks, .task-list";
let active = null;

export function initDragAndDrop(root, {
  selector,
  onDrop,
  getDay = null,
  handleSelector = ".task-drag",
  containerSelector = DEFAULT_CONTAINERS,
  keyboardReorder = true,
} = {}) {
  if (!root || !selector) return;
  root.__taskArcadeDndConfig = { selector, onDrop, getDay, handleSelector, containerSelector, keyboardReorder };
  if (root.dataset.dndInit === "true") return;
  root.dataset.dndInit = "true";

  const start = (event) => {
    const config = root.__taskArcadeDndConfig;
    if (!config || active || (event.pointerType === "mouse" && event.button !== 0)) return;
    const handle = event.target.closest(config.handleSelector);
    if (!handle || !root.contains(handle) || handle.disabled) return;
    const item = handle.closest(config.selector);
    if (!item || !root.contains(item)) return;

    const sourceContainer = item.parentElement;
    active = {
      root,
      selector: config.selector,
      onDrop: config.onDrop,
      getDay: config.getDay,
      handle,
      item,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - item.getBoundingClientRect().left,
      offsetY: event.clientY - item.getBoundingClientRect().top,
      sourceContainer,
      sourceDay: Number(item.dataset.day) || Number(config.getDay?.(item)) || Number(item.querySelector?.("[data-day]")?.dataset.day) || null,
      originalIds: orderedItems(sourceContainer, config.selector).map(getNodeId),
      originalStyle: item.getAttribute("style"),
      armed: false,
      placeholder: null,
      containerSelector: config.containerSelector,
    };

    if (event.pointerType !== "mouse") event.preventDefault();
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* capture is optional */ }
  };

  const move = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.armed) {
      if (Math.hypot(dx, dy) < MOVE_TOLERANCE) return;
      armDrag(active);
    }

    event.preventDefault();
    positionGhost(event.clientX, event.clientY);

    const hit = document.elementFromPoint(event.clientX, event.clientY);
    let target = hit?.closest(active.containerSelector) || null;
    if (!target || !active.root.contains(target)) target = active.placeholder.parentElement;
    if (!target || !active.root.contains(target)) return;

    const after = itemAfterPoint(target, active.selector, active.item, event.clientY);
    if (after) {
      if (after !== active.placeholder && after.previousElementSibling !== active.placeholder) {
        target.insertBefore(active.placeholder, after);
      }
    } else if (active.placeholder.parentElement !== target || active.placeholder !== target.lastElementChild) {
      target.appendChild(active.placeholder);
    }

    active.root.querySelectorAll(".drag-over").forEach((node) => node.classList.remove("drag-over"));
    target.classList.add("drag-over");
  };

  const finish = (event, cancelled = false) => {
    if (!active || (event?.pointerId !== undefined && event.pointerId !== active.pointerId)) return;
    const finished = active;
    active = null;
    if (!finished.armed) return;

    const target = finished.placeholder?.parentElement || finished.sourceContainer;
    if (cancelled || !target || !finished.root.contains(target)) {
      finished.placeholder?.remove();
      finished.sourceContainer.insertBefore(finished.item, finished.sourceContainer.childNodes[
        Math.min(finished.originalIndex || 0, finished.sourceContainer.childNodes.length)
      ] || null);
    } else {
      target.insertBefore(finished.item, finished.placeholder);
      finished.placeholder.remove();
    }

    restoreItem(finished);
    finished.root.querySelectorAll(".drag-over").forEach((node) => node.classList.remove("drag-over"));
    document.body.classList.remove("is-dragging-task");

    if (cancelled || !target) return;
    const ids = orderedItems(target, finished.selector).map(getNodeId).filter(Boolean);
    const targetDay = Number(target.dataset.day)
      || Number(target.closest(".day-column")?.dataset.day)
      || (target === finished.sourceContainer ? (Number(finished.getDay?.(finished.item)) || finished.sourceDay) : null);
    const changed = target !== finished.sourceContainer || ids.join(",") !== finished.originalIds.join(",");
    if (changed && ids.length) {
      const context = { day: targetDay || null, from: finished.sourceDay, container: target };
      emit("dnd-drop", { ids: ids.map(Number), ...context });
      finished.onDrop?.(ids.map(Number), context);
    }
  };

  root.addEventListener("pointerdown", start);
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", (event) => finish(event, false));
  window.addEventListener("pointercancel", (event) => finish(event, true));
  root.addEventListener("dragstart", (event) => event.preventDefault());

  root.addEventListener("keydown", (event) => {
      const config = root.__taskArcadeDndConfig;
      if (!config?.keyboardReorder || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const handle = event.target.closest(config.handleSelector);
      const item = handle?.closest(config.selector);
      if (!item || !root.contains(item)) return;
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const siblings = orderedItems(item.parentElement, config.selector);
      const index = siblings.indexOf(item);
      const target = siblings[index + direction];
      if (!target) return;
      event.preventDefault();
      if (direction < 0) item.parentElement.insertBefore(item, target);
      else item.parentElement.insertBefore(target, item);
      const ids = orderedItems(item.parentElement, config.selector).map(getNodeId).map(Number).filter(Boolean);
      const day = Number(item.parentElement.dataset.day) || Number(config.getDay?.(item)) || Number(item.dataset.day) || null;
      config.onDrop?.(ids, { day, from: day, container: item.parentElement });
      handle.focus({ preventScroll: true });
  });
}

function orderedItems(container, selector) {
  return Array.from(container?.children || []).filter((node) => node.matches?.(selector) && !node.classList.contains("is-dragging") && !node.classList.contains("dnd-placeholder"));
}

function getNodeId(node) {
  return node?.dataset?.id || node?.querySelector?.("[data-id]")?.dataset?.id || "";
}

function itemAfterPoint(container, selector, dragging, y) {
  const candidates = orderedItems(container, selector).filter((node) => node !== dragging);
  let best = null;
  let bestOffset = Number.NEGATIVE_INFINITY;
  for (const node of candidates) {
    const box = node.getBoundingClientRect();
    const offset = y - (box.top + box.height / 2);
    if (offset < 0 && offset > bestOffset) {
      best = node;
      bestOffset = offset;
    }
  }
  return best;
}

function armDrag(state) {
  if (!state || active !== state) return;
  state.armed = true;
  const item = state.item;
  const rect = item.getBoundingClientRect();
  const siblings = Array.from(state.sourceContainer.childNodes);
  state.originalIndex = siblings.indexOf(item);
  const placeholder = item.cloneNode(false);
  placeholder.classList.remove("is-dragging", "is-dragging-ghost");
  placeholder.classList.add("dnd-placeholder");
  placeholder.removeAttribute("id");
  placeholder.removeAttribute("tabindex");
  placeholder.removeAttribute("style");
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.style.height = `${rect.height}px`;
  placeholder.style.minHeight = `${rect.height}px`;
  placeholder.style.width = `${rect.width}px`;
  state.placeholder = placeholder;
  state.sourceContainer.insertBefore(placeholder, item);

  item.classList.add("is-dragging", "is-dragging-ghost");
  item.style.position = "fixed";
  item.style.margin = "0";
  item.style.width = `${rect.width}px`;
  item.style.height = `${rect.height}px`;
  item.style.left = `${rect.left}px`;
  item.style.top = `${rect.top}px`;
  item.style.zIndex = "120";
  item.style.pointerEvents = "none";
  item.style.transform = "scale(1.015)";
  document.body.classList.add("is-dragging-task");
  if (navigator.vibrate && state.pointerType !== "mouse") navigator.vibrate(10);
}

function positionGhost(x, y) {
  if (!active?.armed) return;
  active.item.style.left = `${x - active.offsetX}px`;
  active.item.style.top = `${y - active.offsetY}px`;
}

function restoreItem(state) {
  state.item.classList.remove("is-dragging", "is-dragging-ghost");
  if (state.originalStyle === null) state.item.removeAttribute("style");
  else state.item.setAttribute("style", state.originalStyle);
}

/** Programmatic reorder used by keyboard controls and focused task views. */
export function nudgeTask(node, direction, { onDrop, selector = "[data-id]" } = {}) {
  if (!node) return;
  const container = node.parentElement;
  const siblings = orderedItems(container, selector);
  const index = siblings.indexOf(node);
  const target = siblings[index + direction];
  if (!target) return;
  if (direction < 0) container.insertBefore(node, target);
  else container.insertBefore(target, node);
  const ids = orderedItems(container, selector).map(getNodeId).map(Number).filter(Boolean);
  onDrop?.(ids, { day: Number(container.dataset.day) || null, container });
  node.focus({ preventScroll: true });
}
