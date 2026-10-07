/* ==========================================================================
   TaskArcade — API client
   Thin wrapper over fetch with:
     * JSON in / JSON out
     * a mutation queue that survives offline moments (localStorage backed)
     * automatic state merge (most endpoints answer with the changed slice,
       the app then calls refresh() to resync)
   ========================================================================== */

import { store, emit, prefs, uid } from "./core.js";

const QUEUE_KEY = "taskarcade.queue.v1";
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

let online = true;
let flushing = false;
let queue = [];

function loadQueue() {
  try {
    queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    queue = [];
  }
  return queue;
}

function saveQueue() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-60)));
  } catch (error) {
    console.warn("[api] could not persist queue", error);
  }
}

export function setOnline(value) {
  if (online === value) return;
  online = value;
  emit("connectivity", { online });
  if (online) flushQueue();
}

export function isOnline() {
  return online && navigator.onLine !== false;
}

export function queueSize() {
  return queue.length;
}

async function request(method, path, body, { silent = false, retry = true } = {}) {
  const options = {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  };
  if (body !== undefined && body !== null) options.body = JSON.stringify(body);

  try {
    const response = await fetch(path, options);
    setOnline(true);
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      if (response.status >= 500 && retry && MUTATING.has(method)) {
        enqueue(method, path, body);
      }
      if (!silent) emit("api-error", { path, method, error });
      throw error;
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      // Merge any full-state payload so every view stays consistent.
      if (data.settings || data.tasks) store.set(data);
      delete data.bad_lines;
    }
    return data;
  } catch (error) {
    if (error instanceof TypeError) {
      // Network level failure: keep the mutation for later.
      setOnline(false);
      if (MUTATING.has(method)) {
        enqueue(method, path, body);
        if (!silent) emit("api-queued", { path, method, body });
        return { queued: true, offline: true };
      }
    }
    throw error;
  }
}

function enqueue(method, path, body) {
  queue.push({ id: uid(), method, path, body, at: Date.now() });
  saveQueue();
  emit("queue", { size: queue.length });
}

export async function flushQueue() {
  if (flushing || !isOnline()) return { flushed: 0, failed: 0 };
  flushing = true;
  const pending = queue.slice();
  let flushed = 0;
  let failed = 0;
  queue = [];
  for (const item of pending) {
    try {
      const response = await fetch(item.path, {
        method: item.method,
        headers: { "Content-Type": "application/json" },
        body: item.body === undefined ? undefined : JSON.stringify(item.body),
      });
      if (response.ok) {
        flushed += 1;
        const text = await response.text();
        if (text) {
          try {
            const data = JSON.parse(text);
            if (data && typeof data === "object" && (data.settings || data.tasks)) store.set(data);
          } catch {
            /* ignore */
          }
        }
      } else if (response.status >= 500) {
        failed += 1;
        queue.push(item);
      }
    } catch {
      failed += 1;
      queue.push(item);
      setOnline(false);
      break;
    }
  }
  saveQueue();
  flushing = false;
  emit("queue", { size: queue.length, flushed, failed });
  if (flushed) emit("flushed", { flushed });
  return { flushed, failed };
}

export const api = {
  get: (path, options) => request("GET", path, null, options),
  post: (path, body, options) => request("POST", path, body ?? {}, options),
  patch: (path, body, options) => request("PATCH", path, body ?? {}, options),
  put: (path, body, options) => request("PUT", path, body ?? {}, options),
  del: (path, body, options) => request("DELETE", path, body ?? {}, options),

  state: () => request("GET", "/api/state"),

  async refresh(options = {}) {
    const data = await request("GET", "/api/state", null, { silent: true, ...options });
    if (data) store.set(data);
    return data;
  },

  /* --- task endpoints -------------------------------------------------- */
  createTask: (task) => request("POST", "/api/tasks", task),
  bulkAdd: (text, dayIndex) => request("POST", "/api/tasks/bulk", { text, day_index: dayIndex }),
  updateTask: (id, patch) => request("PATCH", `/api/tasks/${id}`, patch),
  deleteTask: (id) => request("DELETE", `/api/tasks/${id}`),
  doneTask: (id, done = true) => request("POST", `/api/tasks/${id}/done`, { done }),
  skipTask: (id, toEnd = true) => request("POST", `/api/tasks/${id}/skip`, { to_end: toEnd }),
  tickTask: (id, remaining, spent = 0, { silent = true } = {}) =>
    request("POST", `/api/tasks/${id}/tick`, { remaining_seconds: remaining, seconds_spent: spent }, { silent }),
  duplicateTask: (id) => request("POST", `/api/tasks/${id}/duplicate`),
  splitTask: (id, pieces, titles) => request("POST", `/api/tasks/${id}/split`, { pieces, titles }),
  pinTask: (id) => request("POST", `/api/tasks/${id}/pin`),
  moveTask: (id, dayIndex, orderIndex) =>
    request("POST", `/api/tasks/${id}/move`, { day_index: dayIndex, order_index: orderIndex }),
  reorder: (order, dayIndex) => request("POST", "/api/tasks/reorder", { order, day_index: dayIndex }),
  bulkAction: (action, ids, extra = {}) => request("POST", "/api/tasks/bulk-action", { action, ids, ...extra }),
  purge: (dayIndex, olderThanDays = 0) =>
    request("POST", "/api/tasks/purge", { day_index: dayIndex, older_than_days: olderThanDays }),
  archived: () => request("GET", "/api/tasks/archived"),
  restoreTask: (id) => request("POST", `/api/tasks/${id}/restore`),

  /* --- subtasks -------------------------------------------------------- */
  addSubtask: (taskId, title) => request("POST", `/api/tasks/${taskId}/subtasks`, { title }),
  toggleSubtask: (id, done = null) =>
    request(done === null ? "POST" : "PATCH", done === null ? `/api/subtasks/${id}/toggle` : `/api/subtasks/${id}`,
      done === null ? {} : { done }),
  updateSubtask: (id, patch) => request("PATCH", `/api/subtasks/${id}`, patch),
  deleteSubtask: (id) => request("DELETE", `/api/subtasks/${id}`),

  /* --- tags & aliases -------------------------------------------------- */
  saveTag: (tag) => request("POST", "/api/tags", tag),
  deleteTag: (name) => request("DELETE", `/api/tags/${encodeURIComponent(name)}`),
  mergeTags: (source, target) => request("POST", "/api/tags/merge", { source, target }),
  reorderTags: (order) => request("POST", "/api/tags/reorder", { order }),
  addAlias: (alias, tag) => request("POST", "/api/aliases", { alias, tag }),
  deleteAlias: (alias) => request("DELETE", `/api/aliases/${encodeURIComponent(alias)}`),
  setAliases: (tag, aliases) => request("POST", "/api/aliases/bulk", { tag, aliases }),

  /* --- parsing --------------------------------------------------------- */
  parse: (text, bulk = false) => request("POST", "/api/parse", { text, bulk }, { silent: true }),

  /* --- day ------------------------------------------------------------- */
  summary: (day) => request("GET", `/api/day/summary?day=${day ?? 0}`),
  queue: (day) => request("GET", `/api/day/queue?day=${day ?? 0}`),
  finishDay: (payload) => request("POST", "/api/day/finish", payload || {}),
  reopenDay: () => request("POST", "/api/day/reopen"),
  logDay: (dayIndex, payload) => request("POST", "/api/day/log", { day_index: dayIndex, ...payload }),
  dayDetail: (dayIndex) => request("GET", `/api/day/${Math.max(1, Number(dayIndex) || 1)}`),

  /* --- sessions -------------------------------------------------------- */
  startSession: (taskId, kind = "focus", planned = 0) =>
    request("POST", "/api/sessions", { task_id: taskId, kind, planned_seconds: planned }),
  endSession: (id, seconds, completed, taskId) =>
    request("POST", `/api/sessions/${id}/end`, { seconds, completed, task_id: taskId }),
  sessions: (limit = 30, day = null) => request("GET", `/api/sessions?limit=${limit}${day ? `&day=${encodeURIComponent(day)}` : ""}`),
  updateSession: (id, patch) => request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, patch),
  deleteSession: (id) => request("DELETE", `/api/sessions/${encodeURIComponent(id)}`),

  /* --- guided routines ------------------------------------------------- */
  routines: (includeArchived = false) => request("GET", `/api/routines${includeArchived ? "?archived=1" : ""}`),
  createRoutine: (routine) => request("POST", "/api/routines", routine),
  updateRoutine: (id, patch) => request("PATCH", `/api/routines/${encodeURIComponent(id)}`, patch),
  deleteRoutine: (id) => request("DELETE", `/api/routines/${encodeURIComponent(id)}`),
  startRoutine: (id) => request("POST", `/api/routines/${encodeURIComponent(id)}/start`, {}),
  routineRuns: (limit = 20) => request("GET", `/api/routine-runs?limit=${encodeURIComponent(limit)}`),
  commandRoutineRun: (id, action, remainingSeconds = undefined) => request("PATCH", `/api/routine-runs/${encodeURIComponent(id)}`, {
    action,
    ...(remainingSeconds === undefined ? {} : { remaining_seconds: remainingSeconds }),
  }),

  /* --- recurrences & templates ----------------------------------------- */
  saveRecurrence: (rule) => request("POST", "/api/recurrences", rule),
  updateRecurrence: (id, patch) => request("PATCH", `/api/recurrences/${id}`, patch),
  deleteRecurrence: (id) => request("DELETE", `/api/recurrences/${id}`),
  materialize: (horizon = 14) => request("POST", "/api/recurrences/materialize", { horizon }),
  applyTemplate: (id, dayIndex, shiftMinutes = 0) =>
    request("POST", `/api/templates/${id}/apply`, { day_index: dayIndex, shift_minutes: shiftMinutes }),
  saveTemplate: (template) => request("POST", "/api/templates", template),
  deleteTemplate: (id) => request("DELETE", `/api/templates/${id}`),
  templateFromDay: (dayIndex, name, description) =>
    request("POST", "/api/templates/from-day", { day_index: dayIndex, name, description }),

  /* --- insights -------------------------------------------------------- */
  stats: (days = 30) => request("GET", `/api/stats?days=${encodeURIComponent(days)}`),
  reminders: (within = 60) => request("GET", `/api/reminders?within=${within}`),

  /* --- history --------------------------------------------------------- */
  undo: () => request("POST", "/api/undo"),
  redo: () => request("POST", "/api/redo"),
  history: () => request("GET", "/api/history"),
  clearHistory: (kind) => request("POST", "/api/history/clear", { kind }),

  /* --- maintenance ----------------------------------------------------- */
  settings: (patch) => request("POST", "/api/settings", patch),
  resetSettings: () => request("POST", "/api/settings", { reset: true }),
  exportBackup: () => request("GET", "/api/backup/export"),
  importBackup: (backup, mode = "merge") => request("POST", "/api/backup/import", { backup, mode }),
  cleanup: (keepEvents = 800) => request("POST", "/api/maintenance/cleanup", { keep_events: keepEvents }),
  reset: (scope) => request("POST", "/api/maintenance/reset", { scope }),
  legacyImport: (path) => request("POST", "/api/maintenance/legacy-import", { path }),
  health: () => request("GET", "/api/health"),

  /* --- external work/free bridge --------------------------------------- */
  externalState: () => request("GET", "/api/external/state", null, { silent: true }),
  externalMode: (mode, sessionId) =>
    request("POST", `/api/external/mode?s=${encodeURIComponent(sessionId)}`, { mode }, { silent: true }),
};

/* --------------------------------------------------------------------------
   Connectivity wiring
   -------------------------------------------------------------------------- */
export function initConnectivity() {
  loadQueue();
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  window.addEventListener("beforeunload", () => {
    if (queue.length) saveQueue();
  });
  if (!navigator.onLine) online = false;
  window.setTimeout(() => flushQueue(), 1200);
}
