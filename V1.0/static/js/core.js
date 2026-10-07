/* ==========================================================================
   TaskArcade — core
   A tiny framework: DOM builder, event bus, reactive store, formatters and
   preference persistence. Everything else in static/js builds on this file.
   ========================================================================== */

import {
  normalizeDigits as normalizeCalendarDigits, toPersianDigits, calendarSystem,
  formatCalendarDate as formatCalendarDateValue, addIsoDays, isoDayDifference, isoParts,
} from "./calendar-utils.js";

/* --------------------------------------------------------------------------
   DOM helpers
   -------------------------------------------------------------------------- */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
export const byId = (id) => document.getElementById(id);

/**
 * Hyperscript-lite element factory.
 *   h("div", { class: "row", onclick: fn }, ["text", childNode])
 */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key === "html") el.innerHTML = value;
    else if (["title", "placeholder", "aria-label", "aria-description"].includes(key) && typeof value === "string") {
      const rawClass = String(attrs?.class || "");
      const preserve = /(?:^|\s)(?:task-title|task-notes|task-notes-inline|subtask-title|project-name|project-description|project-task-name|template-name|template-title|session-title|queue-title|upnext-title|routine-title|routine-step-title|routine-description|routine-step-notes|user-content)(?:\s|$)/.test(rawClass) || Boolean(attrs?.["data-no-translate"]);
      const translate = !preserve && typeof window !== "undefined" ? window.TaskArcadeI18n?.t : null;
      el.setAttribute(key, translate ? translate(value) : value);
    }
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (key === "value") {
      el.value = value;
    } else if (key in el && key !== "list" && typeof value !== "object") {
      try { el[key] = value; } catch { el.setAttribute(key, value); }
    } else {
      el.setAttribute(key, value === true ? "" : value);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else {
      const rawTargets = ".task-title, .task-notes, .task-notes-inline, .subtask-title, .project-name, .project-description, .project-task-name, .template-name, .template-title, .session-title, .queue-title, .upnext-title, .routine-title, .routine-step-title, .routine-description, .routine-step-notes, .user-content, [data-no-translate]";
      const preserve = parent.matches?.(rawTargets) || parent.closest?.(rawTargets);
      const translate = !preserve && typeof window !== "undefined" ? window.TaskArcadeI18n?.t : null;
      const value = translate ? translate(String(child)) : String(child);
      parent.appendChild(document.createTextNode(value));
    }
  }
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function icon(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `i ${extraClass}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let queued = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn(...args);
    } else if (!queued) {
      queued = window.setTimeout(() => {
        queued = null;
        last = Date.now();
        fn(...args);
      }, wait - (now - last));
    }
  };
}

export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const uid = () => Math.random().toString(36).slice(2, 10);

/* --------------------------------------------------------------------------
   Event bus
   -------------------------------------------------------------------------- */
const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  listeners.get(event)?.forEach((handler) => {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[bus] handler for "${event}" failed`, error);
    }
  });
  listeners.get("*")?.forEach((handler) => handler({ event, payload }));
}

export const BUS = { on, emit };

/* --------------------------------------------------------------------------
   Store
   -------------------------------------------------------------------------- */
export const store = {
  state: {
    app: {},
    settings: {},
    tags: [],
    aliases: {},
    tasks: [],
    projects: [],
    recurrences: [],
    templates: [],
    events: [],
    sessions: [],
    day_logs: [],
    history: [],
    meta: { themes: [], palette: [], shortcuts: [], stats: {}, today: {}, priority_labels: {} },
  },
  meta: {},
  loaded: false,

  set(data) {
    if (!data || typeof data !== "object") return this.state;
    const incoming = { ...data };
    delete incoming.bad_lines;
    Object.assign(this.state, incoming);
    if (incoming.meta) {
      this.meta = incoming.meta;
      delete this.state.meta;
    }
    this.loaded = true;
    emit("state", this.state);
    return this.state;
  },

  get(key, fallback = undefined) {
    const value = this.state[key];
    return value === undefined ? fallback : value;
  },

  setting(key, fallback = undefined) {
    const value = this.state.settings?.[key];
    return value === undefined || value === null || value === "" ? fallback : value;
  },

  /** Numeric setting with a floor, handy for guards like "5 … 500". */
  settingNum(key, fallback = 0) {
    const value = Number(this.setting(key, fallback));
    return Number.isFinite(value) ? value : fallback;
  },

  tag(name) {
    const needle = String(name || "").toLowerCase();
    return (this.state.tags || []).find((tag) => tag.name === needle) || null;
  },

  tagColor(name) {
    return this.tag(name)?.color || "#8D99AE";
  },

  tagSoft(name) {
    const color = this.tagColor(name);
    if (!color.startsWith("#") || color.length < 7) return "rgba(141, 153, 174, .18)";
    return `${color}29`;
  },

  aliasFor(name) {
    const needle = String(name || "").toLowerCase();
    const entries = Object.entries(this.state.aliases || {}).filter(([, target]) => target === needle);
    return entries.map(([alias]) => alias).sort((a, b) => a.length - b.length);
  },

  resolveTag(token) {
    const needle = String(token || "").toLowerCase().replace(/^#/, "");
    if (!needle) return "";
    return this.state.aliases?.[needle] || needle;
  },
};

/* --------------------------------------------------------------------------
   Formatters
   -------------------------------------------------------------------------- */
const TIME_FORMAT_LABELS = {
  hm: "1h 30m",
  clock: "90:00",
  decimal: "1.5h",
  minutes: "90m",
};

export function wantsPersianDigits() {
  const style = store.setting("digit_style", "auto");
  return style === "persian" || (style === "auto" && store.setting("language", "en") === "fa");
}

export function formatNumber(value) {
  const text = String(value ?? "");
  return wantsPersianDigits() ? toPersianDigits(text) : text;
}

export function currentCalendarSystem() {
  return calendarSystem(store.get("settings", {}) || {});
}

export function calendarAnchorDate() {
  const saved = String(store.setting("calendar_start_date", "") || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(saved)) return saved;
  // Before the user chooses an anchor, associate today's local date with the
  // current virtual day; this gives the Jalali picker useful dates immediately.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  try { return addIsoDays(today, 1 - store.settingNum("current_day_index", 1)); } catch { return today; }
}

export function calendarDateForDay(dayIndex) {
  try { return addIsoDays(calendarAnchorDate(), Math.max(1, Number(dayIndex) || 1) - 1); } catch { return ""; }
}

export function formatCalendarDate(value, { system = currentCalendarSystem(), separator = "/" } = {}) {
  if (!value) return "";
  try {
    return formatCalendarDateValue(String(value).slice(0, 10), system, { digits: wantsPersianDigits() ? "persian" : "latin", separator });
  } catch { return String(value); }
}

export function calendarDayLabel(dayIndex) {
  return formatCalendarDate(calendarDateForDay(dayIndex));
}

/** Format a number of seconds honouring the user's duration preference. */
export function fmtDuration(seconds, mode = null) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const style = mode || store.setting("time_format", "hm");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const fa = store.setting("language", "en") === "fa";
  const num = (value) => formatNumber(value);

  switch (style) {
    case "clock": {
      const mm = String(minutes).padStart(2, "0");
      const hh = hours > 0 ? String(hours).padStart(2, "0") + ":" : "";
      return num(`${hh}${mm}:${String(secs).padStart(2, "0")}`);
    }
    case "decimal": {
      const value = total / 3600;
      const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(value < 1 ? 2 : 1);
      const rendered = rounded.replace(/\.0+$/, "");
      return fa ? `${num(rendered.replace(".", "٫"))} ساعت` : `${rendered}h`;
    }
    case "minutes":
      return fa ? `${num(Math.round(total / 60))} دقیقه` : `${total >= 3600 ? Math.round(total / 60) : (minutes || Math.floor(total / 60))}m`;
    default: {
      if (fa) {
        const parts = [];
        if (hours) parts.push(`${num(hours)} ساعت`);
        if (minutes) parts.push(`${num(minutes)} دقیقه`);
        if (!parts.length && secs) parts.push(`${num(secs)} ثانیه`);
        return parts.length ? parts.join(" و ") : "۰ دقیقه";
      }
      if (hours && minutes) return `${hours}h ${minutes}m`;
      if (hours) return `${hours}h`;
      if (minutes) return `${minutes}m`;
      return `${secs}s`;
    }
  }
}

/** Short variant used inside dense chips. */
export function fmtShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  const fa = store.setting("language", "en") === "fa";
  if (fa) {
    if (hours && minutes) return `${formatNumber(hours)}س ${formatNumber(String(minutes).padStart(2, "0"))}د`;
    if (hours) return `${formatNumber(hours)}س`;
    return `${formatNumber(minutes)}د`;
  }
  if (hours && minutes) return `${hours}h${String(minutes).padStart(2, "0")}`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

/** mm:ss for live countdowns. */
export function fmtClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const value = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
  return formatNumber(value);
}

export function fmtPercent(value, digits = 0) {
  const num = Number(value) || 0;
  const formatted = formatNumber(num.toFixed(digits));
  return store.setting("language", "en") === "fa" ? `${formatted}٪` : `${formatted}%`;
}

export function fmtMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  if (store.setting("language", "en") === "fa") {
    const parts = [];
    if (hours) parts.push(`${formatNumber(hours)} ساعت`);
    if (mins) parts.push(`${formatNumber(mins)} دقیقه`);
    return parts.length ? parts.join(" و ") : "۰ دقیقه";
  }
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function localizedText(value) {
  return typeof window !== "undefined" ? (window.TaskArcadeI18n?.t?.(value) ?? value) : value;
}

export function dayLabel(dayIndex, current = null) {
  const index = Math.max(1, Number(dayIndex) || 1);
  const today = current ?? store.settingNum("current_day_index", 1);
  const offset = index - today;
  let relative;
  if (offset === 0) relative = localizedText("Today");
  else if (offset === 1) relative = localizedText("Tomorrow");
  else if (offset === -1) relative = localizedText("Yesterday");
  else if (offset > 1) relative = localizedText(`In ${offset} days`);
  else relative = localizedText(`${Math.abs(offset)} days ago`);
  const calendar = calendarDayLabel(index);
  return calendar ? `${relative} · ${calendar}` : relative;
}

export function dayShortLabel(dayIndex, current = null) {
  const today = current ?? store.settingNum("current_day_index", 1);
  const offset = Number(dayIndex) - today;
  if (offset === 0) return localizedText("today");
  if (offset === 1) return localizedText("tomorrow");
  if (offset === -1) return localizedText("yesterday");
  const num = formatNumber(Math.abs(offset));
  return offset > 1 ? (store.setting("language", "en") === "fa" ? `${num}+ روز` : `+${num}d`) : (store.setting("language", "en") === "fa" ? `${num} روز قبل` : `${num}d`);
}

export function relativeTime(isoString) {
  if (!isoString) return "";
  const when = new Date(isoString);
  if (Number.isNaN(when.getTime())) return "";
  const seconds = Math.round((Date.now() - when.getTime()) / 1000);
  const fa = store.setting("language", "en") === "fa";
  if (seconds < 45) return localizedText("just now");
  if (seconds < 3600) return fa ? `${formatNumber(Math.max(1, Math.round(seconds / 60)))} دقیقه پیش` : `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return fa ? `${formatNumber(Math.round(seconds / 3600))} ساعت پیش` : `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 604800) return fa ? `${formatNumber(Math.round(seconds / 86400))} روز پیش` : `${Math.round(seconds / 86400)}d ago`;
  return formatCalendarDate(when.toISOString().slice(0, 10));
}

export function clockNow() {
  const locale = store.setting("language", "en") === "fa" ? "fa-IR-u-nu-latn" : undefined;
  const timeZone = String(store.setting("timezone", "") || "").trim();
  const options = { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) };
  let value;
  try { value = new Date().toLocaleTimeString(locale, options); }
  catch { value = new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }); }
  return store.setting("language", "en") === "fa" && wantsPersianDigits() ? value.replace(/\d/g, (n) => "۰۱۲۳۴۵۶۷۸۹"[Number(n)]) : value;
}

/** Parse "1h30m", "90", "2p", "1.5h" into seconds (client-side mirror of the
 *  server parser so previews are instant). */
export function parseDurationText(text, pomodoroMinutes = 25) {
  const raw = normalizeCalendarDigits(text).trim().toLowerCase().replace(/\s+/g, "").replace(/٬/g, "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 60;

  const units = {
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
    d: 86400, day: 86400, days: 86400,
    p: pomodoroMinutes * 60, pom: pomodoroMinutes * 60, pomo: pomodoroMinutes * 60,
    "دقیقه": 60, "د": 60, "ساعت": 3600, "س": 3600, "ثانیه": 1, "ث": 1, "روز": 86400,
    "پوم": pomodoroMinutes * 60, "پومودورو": pomodoroMinutes * 60,
  };

  let total = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)([\p{L}]+|[\u2300-\u27bf]+)/gu;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const unit = units[match[2].replace(/s$/, "")] ?? units[match[2]];
    if (!unit) return null;
    total += Number(match[1]) * unit;
    matched = true;
  }
  return matched && total > 0 ? Math.round(total) : null;
}

/* --------------------------------------------------------------------------
   Local preferences (device-local, separate from server settings)
   -------------------------------------------------------------------------- */
const PREF_KEY = "taskarcade.prefs.v1";

const DEFAULT_PREFS = {
  theme: "lumen",
  scheme: "auto",
  density: "cozy",
  layoutOverride: "auto",
  accent: "",
  radius: null,
  fontScale: 1,
  motion: true,
  transparency: true,
  contrast: false,
  sortMode: null,
  toggleDone: null,
  focusMode: false,
  lastTab: "today",
  sound: true,
  volume: 0.5,
  idleSeconds: 180,
  notify: false,
  reminderWindow: 60,
  countMode: null,
  externalSession: null,
};

export const prefs = {
  data: { ...DEFAULT_PREFS },

  load() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw) this.data = { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    } catch (error) {
      console.warn("[prefs] could not read local preferences", error);
    }
    return this.data;
  },

  save() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(this.data));
    } catch (error) {
      console.warn("[prefs] could not persist preferences", error);
    }
    return this.data;
  },

  get(key, fallback = undefined) {
    const value = this.data[key];
    if (value === undefined || value === null) {
      return fallback !== undefined ? fallback : DEFAULT_PREFS[key];
    }
    return value;
  },

  set(key, value) {
    this.data[key] = value;
    this.save();
    emit("prefs", { key, value });
    return value;
  },

  reset() {
    this.data = { ...DEFAULT_PREFS };
    this.save();
    emit("prefs", { key: "*", value: null });
  },
};

/* --------------------------------------------------------------------------
   Small utilities
   -------------------------------------------------------------------------- */
export function sortTasks(tasks, mode = "manual") {
  const list = tasks.slice();
  const byManual = (a, b) => a.order_index - b.order_index;
  switch (mode) {
    case "priority":
      return list.sort((a, b) => b.priority - a.priority || byManual(a, b));
    case "duration":
      return list.sort((a, b) => a.remaining_seconds - b.remaining_seconds || byManual(a, b));
    case "duration_desc":
      return list.sort((a, b) => b.remaining_seconds - a.remaining_seconds || byManual(a, b));
    case "alpha":
      return list.sort((a, b) => a.title.localeCompare(b.title));
    case "created":
      return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    default:
      return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || byManual(a, b));
  }
}

export function groupTasks(tasks, mode = "day") {
  const groups = new Map();
  for (const task of tasks) {
    let key;
    if (mode === "tag") key = task.tag || "__untagged";
    else if (mode === "priority") key = String(task.priority || 0);
    else if (mode === "none") key = "all";
    else key = String(task.day_index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return groups;
}

export function tasksForDay(dayIndex) {
  return (store.get("tasks", []) || []).filter((task) => task.day_index === Number(dayIndex));
}

export function openTasksForDay(dayIndex, sortMode = null) {
  const mode = sortMode || store.setting("sort_mode", "manual");
  return sortTasks(
    tasksForDay(dayIndex).filter((task) => !task.done),
    mode,
  );
}

/** The task the Now card should surface: pinned first, then manual order. */
export function activeTask(dayIndex = null) {
  const day = dayIndex ?? store.settingNum("current_day_index", 1);
  const open = openTasksForDay(day);
  if (!open.length) return null;
  const pinned = open.filter((task) => task.pinned);
  return (pinned.length ? pinned : open)[0];
}

export function totalsForDay(dayIndex) {
  const tasks = tasksForDay(dayIndex);
  const planned = tasks.reduce((sum, task) => sum + Number(task.total_seconds || 0), 0);
  const remaining = tasks.reduce(
    (sum, task) => sum + (task.done ? 0 : Number(task.remaining_seconds || 0)),
    0,
  );
  const done = tasks.filter((task) => task.done).length;
  const completedSeconds = tasks.reduce((sum, task) => {
    const fallback = Number(task.total_seconds || 0) - (task.done ? 0 : Number(task.remaining_seconds || 0));
    return sum + Math.max(0, Number(task.elapsed_seconds ?? fallback));
  }, 0);
  const focus = tasks.reduce((sum, task) => sum + Number(task.focus_seconds || 0), 0);
  return {
    tasks: tasks.length,
    done,
    open: tasks.length - done,
    planned,
    remaining,
    completedSeconds,
    focus,
    progress: planned ? ((planned - remaining) / planned) * 100 : 0,
  };
}

export function totalsOverall() {
  const tasks = store.get("tasks", []) || [];
  const planned = tasks.reduce((sum, task) => sum + Number(task.total_seconds || 0), 0);
  const remaining = tasks.reduce(
    (sum, task) => sum + (task.done ? 0 : Number(task.remaining_seconds || 0)),
    0,
  );
  return {
    planned,
    remaining,
    done: tasks.filter((task) => task.done).length,
    total: tasks.length,
    progress: planned ? ((planned - remaining) / planned) * 100 : 0,
  };
}

export function viewRange() {
  const settings = store.get("settings", {}) || {};
  const current = Number(settings.current_day_index || 1);
  const mode = settings.view_mode || "today";
  let count = 1;
  let start = current;
  switch (mode) {
    case "tomorrow":
      start = current + 1;
      count = 1;
      break;
    case "3days":
      count = 3;
      break;
    case "week":
      count = 7;
      break;
    case "custom":
      count = clamp(Number(settings.view_days || 4), 1, 60);
      break;
    case "all": {
      const days = (store.get("tasks", []) || []).map((task) => task.day_index);
      const min = days.length ? Math.min(...days) : current;
      const max = days.length ? Math.max(...days) : current;
      start = Math.min(min, current);
      count = Math.max(1, Math.max(max, current) - start + 1);
      break;
    }
    default:
      count = 1;
  }
  const days = [];
  for (let index = 0; index < count; index += 1) days.push(start + index);
  return days;
}

export const PRIORITY_LABELS = { 0: "None", 1: "Low", 2: "Medium", 3: "High" };
export const PRIORITY_GLYPHS = { 0: "–", 1: "!", 2: "!!", 3: "!!!" };
export const MOOD_GLYPHS = { great: "🙌", good: "🙂", ok: "😐", rough: "😕", awful: "😩" };

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function isTouch() {
  return window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

export function download(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((key) => escape(row[key])).join(","))].join("\n");
}

export function storageNote() {
  try {
    const bytes = new Blob([JSON.stringify(store.state)]).size;
    return `State in memory: ${(bytes / 1024).toFixed(1)} KB · prefs stored locally`;
  } catch {
    return "";
  }
}
