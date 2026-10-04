/* ============================================================
   Cadence — client logic (vanilla JS, no build step)
   i18n: simple dictionary below. Add a language by adding a key
   to I18N and switching settings.language (stored server-side).
   ============================================================ */
const I18N = {
  en: {
    unscheduled: "Backlog", no_nodes: "No structure yet",
    no_nodes_sub: "Create a category, project, list or task to get started.",
    no_chunks: "Nothing planned", no_chunks_sub: "Add a chunk to start working.",
    backlog_empty: "Backlog is empty", wagon_off: "Wagon sync is off",
    saved: "Saved", updated: "Updated", deleted: "Removed",
  },
};
let LANG = (window.__SETTINGS__ && window.__SETTINGS__.language) || "en";
const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k;

const EMOJIS = ["📁","🚀","✅","📝","💡","🎯","🔥","⏰","📚","🧩","🛠️","🎨","💻","📈","🧠",
  "🏆","🌱","☕","🧘","🗓️","📌","🎵","🧪","🏗️","✉️","💰","🧹","🏃","🛒","🖊️"];
const SYMBOLS = ["folder","rocket_launch","task_alt","checklist","bolt","timer","flag","star",
  "label","bookmark","work","school","fitness_center","palette","code","menu_book","savings",
  "home_repair_service","event","inbox"];
const TYPE_ICON = { category: "folder", project: "rocket_launch", list: "checklist", task: "task_alt" };
const TYPES = ["category", "project", "list", "task"];
const THEMES = [
  { id: "midnight", name: "Midnight", bg: "#0b0e17", accent: "#6d8cff", text: "#e9ecf6" },
  { id: "obsidian", name: "Obsidian", bg: "#0a0a0c", accent: "#d9d9df", text: "#ededf2" },
  { id: "forest", name: "Forest", bg: "#081210", accent: "#3ddc97", text: "#e6f3ec" },
  { id: "plum", name: "Plum", bg: "#120a17", accent: "#c979f0", text: "#f1e8f7" },
  { id: "ember", name: "Ember", bg: "#140b08", accent: "#ff8a4c", text: "#f8ece2" },
  { id: "arctic", name: "Arctic", bg: "#070f14", accent: "#4fd3e8", text: "#e4f3fa" },
];

// ---------------------------------------------------------- tiny utils
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function iso(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function fmtMin(min) {
  min = Math.round(min || 0);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function toMinutes(h, m) {
  if (h === "" && m === "") return null;
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
}
function iconIsSymbol(icon) { return /^[a-z_]+$/.test(icon || ""); }
function defaultIcon(type) { return TYPE_ICON[type] || "task_alt"; }
function renderIcon(container, icon, type) {
  container.textContent = "";
  const val = icon || defaultIcon(type);
  if (iconIsSymbol(val)) {
    const span = document.createElement("span");
    span.className = "material-symbols-rounded";
    span.textContent = val;
    container.appendChild(span);
  } else {
    container.textContent = val;
  }
}

function toast(msg, type = "info", ms = 3400) {
  const el = document.createElement("div");
  el.className = "toast" + (type !== "info" ? " " + type : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, ms);
}

async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-TZ": String(new Date().getTimezoneOffset()) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch (e) {
    toast("Connection issue — change may not have saved", "error");
    throw e;
  }
}

function openOverlay(id) { $(id).classList.add("open"); }
function closeOverlay(idOrEl) {
  const el = typeof idOrEl === "string" ? $(idOrEl) : idOrEl;
  el.classList.remove("open");
}
$$(".overlay").forEach((ov) => {
  ov.addEventListener("click", (e) => { if (e.target === ov) closeOverlay(ov); });
  $$("[data-close]", ov).forEach((b) => b.addEventListener("click", () => closeOverlay(ov)));
});
function anyModalOpen() { return $$(".overlay.open").length > 0; }

function armDanger(btn, onConfirm, labelIdle, labelArmed) {
  btn.textContent = labelIdle;
  btn.addEventListener("click", () => {
    if (btn.dataset.armed) { onConfirm(); btn.dataset.armed = ""; btn.textContent = labelIdle; }
    else {
      btn.dataset.armed = "1"; btn.textContent = labelArmed || "Confirm?";
      setTimeout(() => { if (btn.dataset.armed) { btn.dataset.armed = ""; btn.textContent = labelIdle; } }, 2600);
    }
  });
}

// ---------------------------------------------------------- global state
let STATE = null;
let VIEW = { sidebarOpen: true, windowStart: iso(new Date()), dragging: false };
let firstLoadDone = false;
let wagonTimer = null, pollTimer = null;

async function loadState(opts = {}) {
  let s;
  try { s = await api("GET", "/api/state"); } catch (e) { return; }
  STATE = s;
  if (!firstLoadDone) {
    VIEW.sidebarOpen = !!STATE.settings.sidebar_default_open;
    VIEW.windowStart = STATE.today;
    applySidebarClass();
  }
  document.documentElement.dataset.theme = STATE.settings.theme;
  document.documentElement.dataset.density = STATE.settings.density;
  $("#zoomSlider").value = STATE.settings.zoom;
  renderSidebar();
  renderBoard();
  updateModeUI();
  if ((opts.checkRollover || !firstLoadDone) && STATE.missed && STATE.missed.length) openRolloverModal();
  firstLoadDone = true;
}

function applySidebarClass() { $("#sidebar").classList.toggle("collapsed", !VIEW.sidebarOpen); }

// =========================================================== SIDEBAR
function renderSidebar() {
  const tree = $("#nodeTree");
  tree.innerHTML = "";
  const showArchived = $("#showArchived").checked;
  const nodes = STATE.nodes.filter((n) => showArchived || !n.archived);
  if (!nodes.length) {
    tree.appendChild(emptyState("account_tree", t("no_nodes"), t("no_nodes_sub")));
    return;
  }
  const byParent = {};
  nodes.forEach((n) => { const k = n.parent_id || "root"; (byParent[k] = byParent[k] || []).push(n); });
  tree.appendChild(renderNodeList(byParent["root"] || [], byParent, "root"));
}

function emptyState(icon, title, sub) {
  const d = document.createElement("div");
  d.className = "empty-state";
  d.innerHTML = `<span class="material-symbols-rounded">${icon}</span>`;
  const b = document.createElement("b"); b.textContent = title; d.appendChild(b);
  const s = document.createElement("span"); s.textContent = sub; d.appendChild(s);
  return d;
}

const expanded = new Set(JSON.parse(localStorage.getItem("cadence_expanded") || "[]"));
function saveExpanded() { localStorage.setItem("cadence_expanded", JSON.stringify([...expanded])); }

function renderNodeList(list, byParent, parentKey) {
  const wrap = document.createElement("div");
  wrap.className = parentKey === "root" ? "node-list" : "node-children";
  wrap.dataset.parent = parentKey;
  list.slice().sort((a, b) => a.order_index - b.order_index).forEach((n) => {
    const children = byParent[n.id] || [];
    const row = buildNodeRow(n, children.length > 0);
    wrap.appendChild(row);
    if (children.length) wrap.appendChild(renderNodeList(children, byParent, String(n.id)));
  });
  return wrap;
}

function buildNodeRow(n, hasChildren) {
  const row = document.createElement("div");
  row.className = `node-row type-${n.type}` + (n.archived ? " archived" : "") + (expanded.has(n.id) ? " open" : "");
  row.dataset.id = n.id;

  const chev = document.createElement("span");
  chev.className = "chev" + (hasChildren ? "" : " empty");
  chev.innerHTML = '<span class="material-symbols-rounded">chevron_right</span>';
  chev.addEventListener("click", (e) => { e.stopPropagation(); if (!hasChildren) return; toggleExpand(n.id, row); });
  row.appendChild(chev);

  const icon = document.createElement("span"); icon.className = "node-icon"; renderIcon(icon, n.icon, n.type);
  row.appendChild(icon);

  const name = document.createElement("span"); name.className = "node-name"; name.textContent = n.name;
  row.appendChild(name);

  if (n.estimate_min) {
    const p = document.createElement("span"); p.className = "node-progress";
    p.textContent = `${fmtMin(n.progress_min)}/${fmtMin(n.estimate_min)}`;
    row.appendChild(p);
  }

  const actions = document.createElement("span"); actions.className = "node-actions";
  const addBtn = iconBtnSm("add", "Add child"); addBtn.addEventListener("click", (e) => { e.stopPropagation(); openNodeModal(null, n.id); });
  const editBtn = iconBtnSm("edit", "Edit"); editBtn.addEventListener("click", (e) => { e.stopPropagation(); openNodeModal(n, n.parent_id); });
  const grip = iconBtnSm("drag_indicator", "Drag to move"); grip.className += " node-grip";
  grip.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); beginNodeDrag(e, row, n); });
  actions.append(addBtn, editBtn, grip);
  row.appendChild(actions);

  row.addEventListener("click", () => { if (hasChildren) toggleExpand(n.id, row); });
  return row;
}
function iconBtnSm(symbol, title) {
  const b = document.createElement("button");
  b.className = "chunk-btn"; b.title = title; b.type = "button";
  b.innerHTML = `<span class="material-symbols-rounded">${symbol}</span>`;
  return b;
}
function toggleExpand(id, row) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  row.classList.toggle("open"); saveExpanded();
}

// ---- sidebar drag & drop (reorder + re-parent) ----
function beginNodeDrag(e, rowEl, node) {
  const rect = rowEl.getBoundingClientRect();
  const ghost = rowEl.cloneNode(true); ghost.classList.add("drag-ghost"); ghost.style.width = rect.width + "px";
  document.body.appendChild(ghost);
  const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
  const placeholder = document.createElement("div"); placeholder.className = "drag-placeholder"; placeholder.style.height = rect.height + "px";
  rowEl.after(placeholder);
  rowEl.style.display = "none";
  document.body.classList.add("dnd-active");
  VIEW.dragging = true;
  let info = null, nestEl = null;
  const moveGhost = (ev) => { ghost.style.left = (ev.clientX - offX) + "px"; ghost.style.top = (ev.clientY - offY) + "px"; };
  moveGhost(e);

  function onMove(ev) {
    moveGhost(ev);
    if (nestEl) { nestEl.classList.remove("nest-target"); nestEl = null; }
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const overRow = el && el.closest(".node-row");
    if (overRow && overRow !== rowEl) {
      const r = overRow.getBoundingClientRect();
      const relY = (ev.clientY - r.top) / r.height;
      const parentKey = overRow.parentElement.dataset.parent || "root";
      if (relY < 0.28) {
        info = { parentId: parentKey === "root" ? null : parseInt(parentKey), beforeId: parseInt(overRow.dataset.id) };
        overRow.parentElement.insertBefore(placeholder, overRow);
      } else if (relY > 0.72) {
        info = { parentId: parentKey === "root" ? null : parseInt(parentKey), afterId: parseInt(overRow.dataset.id) };
        const after = overRow.nextElementSibling && overRow.nextElementSibling.classList.contains("node-children") ? overRow.nextElementSibling : overRow;
        after.after(placeholder);
      } else {
        info = { parentId: parseInt(overRow.dataset.id), nest: true };
        nestEl = overRow; overRow.classList.add("nest-target");
        if (placeholder.parentElement) placeholder.remove();
      }
    } else if (el && el.closest("#nodeTree") && !overRow) {
      info = { parentId: null, append: true };
      if (placeholder.parentElement !== $("#nodeTree")) $("#nodeTree").appendChild(placeholder);
    }
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (nestEl) nestEl.classList.remove("nest-target");
    document.body.classList.remove("dnd-active");
    ghost.remove(); rowEl.style.display = ""; VIEW.dragging = false;
    if (placeholder.parentElement) placeholder.remove();
    commitNodeDrop(node, info);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function commitNodeDrop(node, info) {
  if (!info) return;
  const newParent = info.parentId;
  if (info.nest) expanded.add(newParent), saveExpanded();
  let siblings = STATE.nodes.filter((n) => (n.parent_id || null) === (newParent || null) && n.id !== node.id)
    .sort((a, b) => a.order_index - b.order_index);
  let idx = siblings.length;
  if (info.beforeId !== undefined) { const i = siblings.findIndex((s) => s.id === info.beforeId); if (i >= 0) idx = i; }
  if (info.afterId !== undefined) { const i = siblings.findIndex((s) => s.id === info.afterId); if (i >= 0) idx = i + 1; }
  siblings.splice(idx, 0, { id: node.id });
  const updates = siblings.map((s, i) => ({ id: s.id, parent_id: newParent, order_index: i }));
  if ((node.parent_id || null) !== (newParent || null)) {
    const oldSibs = STATE.nodes.filter((n) => (n.parent_id || null) === (node.parent_id || null) && n.id !== node.id)
      .sort((a, b) => a.order_index - b.order_index);
    oldSibs.forEach((s, i) => updates.push({ id: s.id, parent_id: node.parent_id || null, order_index: i }));
  }
  api("POST", "/api/nodes/reorder", { updates }).then(() => loadState());
}

// =========================================================== BOARD
function renderBoard() {
  const scroll = $("#boardScroll");
  scroll.innerHTML = "";
  const range = STATE.settings.day_range || 7;
  const start = new Date(VIEW.windowStart + "T00:00:00");
  scroll.appendChild(renderColumn(null, "Backlog", "inbox", true));
  for (let i = 0; i < range; i++) scroll.appendChild(renderColumn(iso(addDays(start, i)), null, null, false));
  const end = addDays(start, range - 1);
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  $("#rangeLabel").textContent = `${fmt(start)} – ${fmt(end)}`;
}

function renderColumn(dayIso, forcedTitle, forcedIcon, isBacklog) {
  const chunks = STATE.chunks.filter((c) => (c.day || null) === (dayIso || null)).sort((a, b) => a.order_index - b.order_index);
  const col = document.createElement("div");
  col.className = "day-col" + (isBacklog ? " backlog" : "") + (!isBacklog && dayIso === STATE.today ? " today" : "");

  const planned = chunks.reduce((s, c) => s + c.duration_min, 0);
  const done = chunks.reduce((s, c) => s + c.done_sec / 60, 0);
  const pct = planned ? clamp((done / planned) * 100, 0, 100) : 0;

  const head = document.createElement("div"); head.className = "day-head";
  const top = document.createElement("div"); top.className = "day-head-top";
  const titleWrap = document.createElement("div");
  if (isBacklog) {
    titleWrap.innerHTML = `<div class="day-title"><span class="material-symbols-rounded" style="font-size:15px;vertical-align:-3px;margin-inline-end:4px;">inbox</span>${forcedTitle}</div><div class="day-sub">Unscheduled</div>`;
  } else {
    const d = new Date(dayIso + "T00:00:00");
    const wd = d.toLocaleDateString(undefined, { weekday: "short" });
    const md = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    titleWrap.innerHTML = `<div class="day-title">${wd}</div><div class="day-sub">${md}${dayIso === STATE.today ? " · Today" : ""}</div>`;
  }
  top.appendChild(titleWrap);
  head.appendChild(top);
  const bar = document.createElement("div"); bar.className = "day-progress-bar";
  bar.innerHTML = `<div class="day-progress-fill" style="width:${pct}%"></div>`;
  head.appendChild(bar);
  const times = document.createElement("div"); times.className = "day-times";
  times.innerHTML = `<span>${fmtMin(done)} done</span><span>${fmtMin(planned)} planned</span>`;
  head.appendChild(times);
  col.appendChild(head);

  const list = document.createElement("div"); list.className = "chunk-list"; list.dataset.day = dayIso === null ? "null" : dayIso;
  if (!chunks.length) {
    list.appendChild(emptyState(isBacklog ? "inbox" : "event_available", isBacklog ? t("backlog_empty") : t("no_chunks"), isBacklog ? "Drag chunks here or create one." : t("no_chunks_sub")));
  } else {
    chunks.forEach((c) => list.appendChild(renderChunkCard(c)));
  }
  col.appendChild(list);

  const add = document.createElement("button"); add.className = "day-add"; add.type = "button";
  add.textContent = "+ Add chunk";
  add.addEventListener("click", () => openChunkModal(null, dayIso));
  col.appendChild(add);
  return col;
}

function renderChunkCard(chunk) {
  const nodes = chunk.links.map((l) => STATE.nodes.find((n) => n.id === l.node_id)).filter(Boolean);
  const card = document.createElement("div");
  card.className = "chunk-card" + (chunk.done_sec >= chunk.duration_min * 60 && chunk.duration_min > 0 ? " done" : "");
  card.dataset.id = chunk.id;
  const unitPx = STATE.settings.zoom || 64;
  const h = Math.max(38, (chunk.duration_min / 60) * unitPx);
  card.style.minHeight = h + "px";
  if (h < 54) card.classList.add("compact");
  card.dataset.dur = fmtMin(chunk.duration_min);

  const fill = document.createElement("div"); fill.className = "chunk-fill";
  fill.style.width = clamp((chunk.done_sec / (chunk.duration_min * 60 || 1)) * 100, 0, 100) + "%";
  card.appendChild(fill);

  const top = document.createElement("div"); top.className = "chunk-top";
  const chips = document.createElement("div"); chips.className = "chunk-nodes";
  const maxChips = 3;
  nodes.slice(0, maxChips).forEach((n) => {
    const chip = document.createElement("span"); chip.className = "node-chip"; chip.title = n.name;
    const ic = document.createElement("span"); renderIcon(ic, n.icon, n.type); chip.appendChild(ic);
    const nm = document.createElement("span"); nm.className = "name"; nm.textContent = n.name; chip.appendChild(nm);
    chips.appendChild(chip);
  });
  if (nodes.length > maxChips) {
    const chip = document.createElement("span"); chip.className = "node-chip more";
    chip.textContent = "+" + (nodes.length - maxChips);
    chip.title = nodes.slice(maxChips).map((n) => n.name).join(", ");
    chips.appendChild(chip);
  }
  if (!nodes.length) { const chip = document.createElement("span"); chip.className = "node-chip more"; chip.textContent = "unlinked"; chips.appendChild(chip); }
  top.appendChild(chips);

  const actions = document.createElement("div"); actions.className = "chunk-actions";
  const complete = iconBtnSm(chunk.done_sec >= chunk.duration_min * 60 ? "check_circle" : "radio_button_unchecked", "Toggle complete");
  complete.addEventListener("click", (e) => { e.stopPropagation(); api("PATCH", `/api/chunks/${chunk.id}`, { complete: !(chunk.done_sec >= chunk.duration_min * 60) }).then(loadState); });
  const more = iconBtnSm("more_horiz", "Edit chunk");
  more.addEventListener("click", (e) => { e.stopPropagation(); openChunkModal(chunk); });
  actions.append(complete, more);
  top.appendChild(actions);
  card.appendChild(top);

  const title = document.createElement("div"); title.className = "chunk-title";
  title.textContent = nodes.length ? nodes[0].name + (nodes.length > 1 ? ` +${nodes.length - 1}` : "") : "Unlinked chunk";
  card.appendChild(title);

  const bar = document.createElement("div"); bar.className = "chunk-bar";
  bar.innerHTML = `<div class="chunk-bar-fill" style="width:${clamp((chunk.done_sec / (chunk.duration_min * 60 || 1)) * 100, 0, 100)}%"></div>`;
  card.appendChild(bar);

  const meta = document.createElement("div"); meta.className = "chunk-meta";
  const effort = Math.max(1, ...nodes.map((n) => n.effort || 5), chunk._effort || 1);
  const dots = document.createElement("div"); dots.className = "effort-dots";
  for (let i = 0; i < 5; i++) { const s = document.createElement("span"); if (i < Math.round(effort / 2)) s.classList.add("on"); dots.appendChild(s); }
  meta.appendChild(dots);
  const txt = document.createElement("span"); txt.textContent = `${fmtMin(chunk.done_sec / 60)} / ${fmtMin(chunk.duration_min)}`;
  meta.appendChild(txt);
  card.appendChild(meta);

  card.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; beginChunkDrag(e, card, chunk); });
  return card;
}

// ---- board drag & drop ----
function beginChunkDrag(e, cardEl, chunk) {
  const startX = e.clientX, startY = e.clientY;
  let active = false, ghost, placeholder, rect, offX, offY;
  function activate(ev) {
    active = true; VIEW.dragging = true;
    rect = cardEl.getBoundingClientRect(); offX = startX - rect.left; offY = startY - rect.top;
    ghost = cardEl.cloneNode(true); ghost.classList.add("drag-ghost"); ghost.style.width = rect.width + "px";
    document.body.appendChild(ghost);
    placeholder = document.createElement("div"); placeholder.className = "drag-placeholder"; placeholder.style.height = rect.height + "px";
    cardEl.after(placeholder);
    cardEl.classList.add("dragging-source");
    document.body.classList.add("dnd-active");
    moveGhost(ev);
  }
  function moveGhost(ev) { if (ghost) { ghost.style.left = (ev.clientX - offX) + "px"; ghost.style.top = (ev.clientY - offY) + "px"; } }
  function onMove(ev) {
    if (!active) { if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) activate(ev); else return; }
    moveGhost(ev);
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const list = el && el.closest(".chunk-list");
    if (!list) return;
    const overCard = el.closest(".chunk-card");
    if (overCard && overCard !== cardEl) {
      const r = overCard.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) list.insertBefore(placeholder, overCard); else overCard.after(placeholder);
    } else if (!overCard) list.appendChild(placeholder);
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!active) { openChunkModal(chunk); return; }
    document.body.classList.remove("dnd-active"); VIEW.dragging = false;
    cardEl.classList.remove("dragging-source");
    ghost.remove();
    const targetList = placeholder.parentElement;
    const day = targetList.dataset.day === "null" ? null : targetList.dataset.day;
    targetList.insertBefore(cardEl, placeholder);
    placeholder.remove();
    commitChunkDrop(chunk, day);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function commitChunkDrop(chunk, day) {
  const srcDay = chunk.day || null;
  const updates = [];
  const dayKey = day === null ? "null" : day;
  $$(`.chunk-list[data-day="${CSS.escape(dayKey)}"] .chunk-card`).forEach((el, i) => updates.push({ id: parseInt(el.dataset.id), day, order_index: i }));
  if (srcDay !== (day || null)) {
    const srcKey = srcDay === null ? "null" : srcDay;
    $$(`.chunk-list[data-day="${CSS.escape(srcKey)}"] .chunk-card`).forEach((el, i) => { if (parseInt(el.dataset.id) !== chunk.id) updates.push({ id: parseInt(el.dataset.id), day: srcDay, order_index: i }); });
  }
  api("POST", "/api/chunks/reorder", { updates }).then(() => loadState());
}

// =========================================================== NODE MODAL
let editingNode = null, nodeModalParent = null, selectedType = "task";
function openNodeModal(node, parentId) {
  editingNode = node; nodeModalParent = parentId || null;
  $("#nodeModalTitle").textContent = node ? "Edit node" : "New node";
  $("#nodeName").value = node ? node.name : "";
  selectedType = node ? node.type : "task";
  $$("#nodeTypeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.v === selectedType));
  $("#nodeIcon").value = node ? node.icon : "";
  $("#nodeEffort").value = node ? node.effort : 5;
  $("#effortVal").textContent = node ? node.effort : 5;
  $("#estH").value = node && node.estimate_min ? Math.floor(node.estimate_min / 60) : "";
  $("#estM").value = node && node.estimate_min ? node.estimate_min % 60 : "";
  $("#remH").value = node && node.remaining_min ? Math.floor(node.remaining_min / 60) : "";
  $("#remM").value = node && node.remaining_min ? node.remaining_min % 60 : "";
  $("#planMode").value = (node && node.plan_mode) || "count";
  $("#planValue").value = (node && node.plan_value) || 4;
  $("#genChunksBtn").style.display = node ? "" : "none";
  $("#deleteNodeBtn").style.display = node ? "" : "none";
  $("#archiveBtn").style.display = node ? "" : "none";
  $("#archiveBtn").textContent = node && node.archived ? "Unarchive" : "Archive";
  openOverlay("#nodeModalOverlay");
  $("#nodeName").focus();
}
$$("#nodeTypeSeg button").forEach((b) => b.addEventListener("click", () => { selectedType = b.dataset.v; $$("#nodeTypeSeg button").forEach((x) => x.classList.toggle("active", x === b)); }));
$("#nodeEffort").addEventListener("input", (e) => $("#effortVal").textContent = e.target.value);

(function buildIconPickers() {
  const eg = $("#emojiGrid"), sg = $("#symbolGrid");
  EMOJIS.forEach((em) => { const b = document.createElement("button"); b.type = "button"; b.textContent = em; b.addEventListener("click", () => $("#nodeIcon").value = em); eg.appendChild(b); });
  SYMBOLS.forEach((s) => { const b = document.createElement("button"); b.type = "button"; b.innerHTML = `<span class="material-symbols-rounded">${s}</span>`; b.title = s; b.addEventListener("click", () => $("#nodeIcon").value = s); sg.appendChild(b); });
})();

$("#saveNodeBtn").addEventListener("click", () => {
  const payload = {
    name: $("#nodeName").value.trim() || "Untitled",
    type: selectedType,
    icon: $("#nodeIcon").value.trim(),
    effort: parseInt($("#nodeEffort").value, 10),
    estimate_min: toMinutes($("#estH").value, $("#estM").value),
    remaining_min: toMinutes($("#remH").value, $("#remM").value),
    plan_mode: $("#planMode").value,
    plan_value: parseInt($("#planValue").value, 10) || 4,
  };
  const req = editingNode ? api("PATCH", `/api/nodes/${editingNode.id}`, payload) : api("POST", "/api/nodes", { ...payload, parent_id: nodeModalParent });
  req.then(() => { closeOverlay("#nodeModalOverlay"); toast(t("saved"), "success"); loadState(); });
});
$("#genChunksBtn").addEventListener("click", () => {
  if (!editingNode) return;
  api("POST", `/api/nodes/${editingNode.id}/generate_chunks`, { plan_mode: $("#planMode").value, plan_value: parseInt($("#planValue").value, 10) || 4 })
    .then((r) => { closeOverlay("#nodeModalOverlay"); toast(`Generated ${r.created} chunk(s)`, "success"); loadState(); });
});
$("#archiveBtn").addEventListener("click", () => {
  if (!editingNode) return;
  api("PATCH", `/api/nodes/${editingNode.id}`, { archived: editingNode.archived ? 0 : 1 })
    .then(() => { closeOverlay("#nodeModalOverlay"); toast(t("updated"), "success"); loadState(); });
});
armDanger($("#deleteNodeBtn"), () => { if (editingNode) api("DELETE", `/api/nodes/${editingNode.id}`).then(() => { closeOverlay("#nodeModalOverlay"); toast(t("deleted")); loadState(); }); }, "Delete", "Confirm delete?");
$("#addRootNode").addEventListener("click", () => openNodeModal(null, null));

// =========================================================== CHUNK MODAL
let currentChunk = null, chunkDay = null, working = [];
function openChunkModal(chunk, day) {
  currentChunk = chunk; chunkDay = day !== undefined ? day : (chunk ? chunk.day : null);
  $("#chunkModalTitle").textContent = chunk ? "Edit chunk" : "New chunk";
  $("#chunkDuration").value = chunk ? chunk.duration_min : 25;
  const pct = chunk && chunk.duration_min ? clamp((chunk.done_sec / (chunk.duration_min * 60)) * 100, 0, 100) : 0;
  $("#chunkDoneRange").value = pct;
  $("#chunkDoneLabel").textContent = chunk ? `${fmtMin(chunk.done_sec / 60)} / ${fmtMin(chunk.duration_min)}` : "0m / 25m";
  working = chunk ? chunk.links.map((l) => ({ node_id: l.node_id, pct: l.pct })) : [];
  $("#chunkModal").classList.toggle("new-chunk", !chunk);
  $("#deleteChunkBtn").style.display = chunk ? "" : "none";
  $(".quick-row").style.display = chunk ? "" : "none";
  $(".split-field").style.display = chunk ? "" : "none";
  $("#saveChunkBtn").textContent = chunk ? "Save" : "Create";
  renderChunkLinks();
  openOverlay("#chunkModalOverlay");
}
function renderChunkLinks() {
  const wrap = $("#chunkLinks"); wrap.innerHTML = "";
  working.forEach((l) => {
    const node = STATE.nodes.find((n) => n.id === l.node_id);
    const row = document.createElement("div"); row.className = "link-row";
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = node ? node.name : "#" + l.node_id;
    const range = document.createElement("input"); range.type = "range"; range.min = 0; range.max = 100; range.value = Math.round(l.pct);
    const pctLabel = document.createElement("span"); pctLabel.className = "pct"; pctLabel.textContent = Math.round(l.pct) + "%";
    range.addEventListener("input", () => { setAlloc(l.node_id, parseFloat(range.value)); pctLabel.textContent = Math.round(l.pct) + "%"; syncOtherRanges(); });
    const rm = iconBtnSm("close", "Remove"); rm.className += " rm"; rm.addEventListener("click", () => removeLink(l.node_id));
    row.append(nm, range, pctLabel, rm);
    wrap.appendChild(row);
  });
  const sel = $("#addLinkSelect"); sel.innerHTML = "";
  const linked = new Set(working.map((l) => l.node_id));
  STATE.nodes.filter((n) => !n.archived && !linked.has(n.id)).forEach((n) => {
    const o = document.createElement("option"); o.value = n.id; o.textContent = n.name; sel.appendChild(o);
  });
}
function syncOtherRanges() { $$(".link-row").forEach((row, i) => { const l = working[i]; if (l) { row.querySelector("input[type=range]").value = Math.round(l.pct); row.querySelector(".pct").textContent = Math.round(l.pct) + "%"; } }); }
function setAlloc(nodeId, newPct) {
  newPct = clamp(newPct, 0, 100);
  const me = working.find((l) => l.node_id === nodeId);
  const others = working.filter((l) => l.node_id !== nodeId);
  const remaining = 100 - newPct;
  const oldSum = others.reduce((s, o) => s + o.pct, 0);
  others.forEach((o) => { o.pct = oldSum > 0 ? (o.pct / oldSum) * remaining : remaining / (others.length || 1); });
  me.pct = newPct;
}
function addLink(nodeId) {
  if (working.length >= 10) { toast("Max 10 linked nodes"); return; }
  const n = working.length + 1;
  working.forEach((l) => l.pct *= (n - 1) / n);
  working.push({ node_id: nodeId, pct: 100 / n });
  renderChunkLinks();
}
function removeLink(nodeId) {
  working = working.filter((l) => l.node_id !== nodeId);
  const sum = working.reduce((s, o) => s + o.pct, 0);
  if (working.length && sum > 0) working.forEach((o) => o.pct = (o.pct / sum) * 100);
  renderChunkLinks();
}
$("#addLinkBtn").addEventListener("click", () => { const v = $("#addLinkSelect").value; if (v) addLink(parseInt(v, 10)); });
$("#chunkDoneRange").addEventListener("input", (e) => {
  const dur = parseInt($("#chunkDuration").value, 10) || 25;
  const sec = Math.round(dur * 60 * (e.target.value / 100));
  $("#chunkDoneLabel").textContent = `${fmtMin(sec / 60)} / ${fmtMin(dur)}`;
});
$$(".chip-btn").forEach((b) => b.addEventListener("click", () => {
  if (!currentChunk) { toast("Create the chunk first"); return; }
  if (b.dataset.add) api("PATCH", `/api/chunks/${currentChunk.id}`, { add_sec: parseInt(b.dataset.add, 10) * 60 }).then(() => { toast(t("updated"), "success"); closeOverlay("#chunkModalOverlay"); loadState(); });
  if (b.dataset.complete !== undefined) api("PATCH", `/api/chunks/${currentChunk.id}`, { complete: b.dataset.complete === "1" }).then(() => { toast(t("updated"), "success"); closeOverlay("#chunkModalOverlay"); loadState(); });
}));
$("#saveChunkBtn").addEventListener("click", () => {
  const duration = parseInt($("#chunkDuration").value, 10) || 25;
  if (currentChunk) {
    const donePct = parseFloat($("#chunkDoneRange").value) || 0;
    const done_sec = Math.round(duration * 60 * donePct / 100);
    const links = {}; working.forEach((l) => links[l.node_id] = l.pct);
    api("PATCH", `/api/chunks/${currentChunk.id}`, { duration_min: duration, done_sec, links })
      .then(() => { closeOverlay("#chunkModalOverlay"); toast(t("saved"), "success"); loadState(); });
  } else {
    api("POST", "/api/chunks", { duration_min: duration, day: chunkDay, node_ids: working.map((l) => l.node_id) })
      .then(() => { closeOverlay("#chunkModalOverlay"); toast("Chunk added", "success"); loadState(); });
  }
});
$("#splitEqualBtn").addEventListener("click", () => { if (!currentChunk) return; api("POST", `/api/chunks/${currentChunk.id}/split`, { mode: "equal", value: parseInt($("#splitEqualN").value, 10) || 2 }).then(() => { closeOverlay("#chunkModalOverlay"); toast("Split", "success"); loadState(); }); });
$("#splitSizeBtn").addEventListener("click", () => { if (!currentChunk) return; api("POST", `/api/chunks/${currentChunk.id}/split`, { mode: "size", value: parseInt($("#splitSizeN").value, 10) || 25 }).then(() => { closeOverlay("#chunkModalOverlay"); toast("Split", "success"); loadState(); }); });
armDanger($("#deleteChunkBtn"), () => { if (currentChunk) api("DELETE", `/api/chunks/${currentChunk.id}`).then(() => { closeOverlay("#chunkModalOverlay"); toast(t("deleted")); loadState(); }); }, "Delete", "Confirm delete?");

// =========================================================== SETTINGS
let selectedTheme = "midnight", selectedDensity = "cozy", selectedRange = 7;
(function buildThemeGrid() {
  const grid = $("#themeGrid");
  THEMES.forEach((th) => {
    const sw = document.createElement("div"); sw.className = "theme-swatch"; sw.dataset.id = th.id;
    sw.style.setProperty("--sw-bg", th.bg); sw.style.setProperty("--sw-accent", th.accent); sw.style.setProperty("--sw-text", th.text);
    sw.innerHTML = `<span class="dot"></span><span class="nm">${th.name}</span>`;
    sw.addEventListener("click", () => { selectedTheme = th.id; $$(".theme-swatch").forEach((s) => s.classList.toggle("active", s === sw)); document.documentElement.dataset.theme = th.id; });
    grid.appendChild(sw);
  });
})();
$$("#densitySeg button").forEach((b) => b.addEventListener("click", () => { selectedDensity = b.dataset.v; $$("#densitySeg button").forEach((x) => x.classList.toggle("active", x === b)); document.documentElement.dataset.density = selectedDensity; }));
$$("#rangeSeg button").forEach((b) => b.addEventListener("click", () => { selectedRange = parseInt(b.dataset.v, 10); $$("#rangeSeg button").forEach((x) => x.classList.toggle("active", x === b)); }));

function openSettingsModal() {
  const s = STATE.settings;
  selectedTheme = s.theme; selectedDensity = s.density; selectedRange = s.day_range;
  $$(".theme-swatch").forEach((sw) => sw.classList.toggle("active", sw.dataset.id === s.theme));
  $$("#densitySeg button").forEach((b) => b.classList.toggle("active", b.dataset.v === s.density));
  $$("#rangeSeg button").forEach((b) => b.classList.toggle("active", parseInt(b.dataset.v, 10) === s.day_range));
  $("#sidebarDefaultChk").checked = !!s.sidebar_default_open;
  $("#workspaceCode").value = `${location.origin}/  (workspace ${STATE.workspace_id})`;
  $("#wagonEnabled").checked = !!s.wagon_enabled;
  $("#wagonBaseUrl").value = s.wagon_base_url;
  $("#wagonPoll").value = s.wagon_poll_seconds;
  updateWagonHint(s.wagon_enabled ? "idle" : "off");
  openOverlay("#settingsOverlay");
}
$("#copyLinkBtn").addEventListener("click", () => { navigator.clipboard?.writeText(location.href); toast("Link copied", "success"); });
$("#saveSettingsBtn").addEventListener("click", () => {
  const payload = {
    theme: selectedTheme, density: selectedDensity, day_range: selectedRange,
    sidebar_default_open: $("#sidebarDefaultChk").checked,
    wagon_enabled: $("#wagonEnabled").checked,
    wagon_base_url: $("#wagonBaseUrl").value.trim() || "http://127.0.0.1:8787",
    wagon_poll_seconds: parseInt($("#wagonPoll").value, 10) || 10,
  };
  api("PUT", "/api/settings", payload).then((r) => {
    STATE.settings = r.settings;
    closeOverlay("#settingsOverlay");
    toast(t("saved"), "success");
    renderBoard();
    setupWagonPolling();
  });
});

// =========================================================== MODE + WAGON
function updateModeUI() {
  const pill = $("#modePill");
  pill.classList.toggle("work", STATE.mode === "work");
  $("#modeText").textContent = STATE.mode === "work" ? "Work" : "Free";
  pill.title = STATE.settings.wagon_enabled ? "Mode controlled by Wagon Sync" : "Toggle Work / Free";
}
$("#modePill").addEventListener("click", () => {
  if (STATE.settings.wagon_enabled) { toast("Mode is controlled by Wagon Sync", "info"); return; }
  const next = STATE.mode === "work" ? "free" : "work";
  api("POST", "/api/mode", { mode: next, src: "local" }).then((s) => { STATE = s; updateModeUI(); renderBoard(); });
});
function updateWagonHint(status) {
  const map = { off: "Wagon: disabled", idle: "Wagon: connecting…", ok: "Wagon: connected", not_running: "Wagon: not running", unreachable: "Wagon: unreachable" };
  const el = $("#wagonHint"); if (el) el.textContent = map[status] || "";
  const top = $("#wagonStatus"); const txt = $("#wagonStatusText");
  if (status === "off") { top.hidden = true; return; }
  top.hidden = false; txt.textContent = map[status];
  top.classList.toggle("ok", status === "ok"); top.classList.toggle("err", status === "unreachable" || status === "not_running");
}
function setEffectiveMode(mode, src) {
  if (!STATE || (STATE.mode === mode && STATE.mode_src === src)) return;
  api("POST", "/api/mode", { mode, src }).then((s) => { STATE = s; updateModeUI(); renderBoard(); });
}
async function pollWagon() {
  const base = (STATE.settings.wagon_base_url || "").replace(/\/$/, "");
  try {
    const res = await fetch(base + "/api/state", { cache: "no-store" });
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    if (!data.session || data.session.status !== "running" || !data.session.current) {
      updateWagonHint("not_running"); setEffectiveMode("free", "wagon");
    } else {
      updateWagonHint("ok"); setEffectiveMode(data.session.current.kind === "work" ? "work" : "free", "wagon");
    }
  } catch (e) { updateWagonHint("unreachable"); }
}
function setupWagonPolling() {
  if (wagonTimer) clearInterval(wagonTimer);
  if (!STATE.settings.wagon_enabled) { updateWagonHint("off"); return; }
  pollWagon();
  wagonTimer = setInterval(pollWagon, Math.max(3, STATE.settings.wagon_poll_seconds || 10) * 1000);
}

// =========================================================== ROLLOVER
function openRolloverModal() {
  const list = $("#rolloverList"); list.innerHTML = "";
  STATE.missed.forEach((c) => {
    const row = document.createElement("label"); row.className = "rollover-item";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true; cb.dataset.id = c.id;
    const info = document.createElement("div"); info.className = "info";
    const names = c.node_names.map((n) => n.name).join(", ") || "Unlinked";
    info.innerHTML = `<div class="ttl">${names}</div><div class="sub">${c.day} · ${fmtMin(c.done_sec / 60)} / ${fmtMin(c.duration_min)}</div>`;
    row.append(cb, info); list.appendChild(row);
  });
  openOverlay("#rolloverOverlay");
}
$$("#rolloverModal [data-action]").forEach((b) => b.addEventListener("click", () => {
  const ids = $$("#rolloverList input:checked").map((cb) => parseInt(cb.dataset.id, 10));
  if (!ids.length) { closeOverlay("#rolloverOverlay"); return; }
  api("POST", "/api/rollover", { ids, action: b.dataset.action, target: "backlog" })
    .then(() => { closeOverlay("#rolloverOverlay"); toast("Updated", "success"); loadState(); });
}));

// =========================================================== TOPBAR WIRING
$("#sidebarToggle").addEventListener("click", () => { VIEW.sidebarOpen = !VIEW.sidebarOpen; applySidebarClass(); });
$("#prevWindow").addEventListener("click", () => { VIEW.windowStart = iso(addDays(new Date(VIEW.windowStart + "T00:00:00"), -(STATE.settings.day_range || 7))); renderBoard(); });
$("#nextWindow").addEventListener("click", () => { VIEW.windowStart = iso(addDays(new Date(VIEW.windowStart + "T00:00:00"), STATE.settings.day_range || 7)); renderBoard(); });
$("#todayBtn").addEventListener("click", () => { VIEW.windowStart = STATE.today; renderBoard(); });
$("#refreshBtn").addEventListener("click", () => loadState({ checkRollover: true }));
$("#settingsBtn").addEventListener("click", openSettingsModal);
$("#showArchived").addEventListener("change", renderSidebar);
let zoomSaveTimer = null;
$("#zoomSlider").addEventListener("input", (e) => { STATE.settings.zoom = parseInt(e.target.value, 10); renderBoard(); });
$("#zoomSlider").addEventListener("change", (e) => {
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => api("PUT", "/api/settings", { zoom: parseInt(e.target.value, 10) }), 300);
});

// =========================================================== BOOTSTRAP
loadState().then(() => { setupWagonPolling(); });
pollTimer = setInterval(() => { if (!VIEW.dragging && !anyModalOpen()) loadState(); }, 13000);
