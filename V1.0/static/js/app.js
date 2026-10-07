/* ==========================================================================
   TaskArcade — application shell
   Boots the app: preferences → theme → data → views, then owns tab
   navigation, global refresh, undo/redo and connectivity feedback.
   ========================================================================== */

import {
  $, $$, byId, store, prefs, emit, on, activeTask, clamp, dayLabel,
  fmtDuration, isTouch, prefersReducedMotion, storageNote,
} from "./core.js";
import { api, initConnectivity, flushQueue, queueSize, isOnline } from "./api.js";
import { initSheets, openSheet, closeSheet, closeAllSheets, toast, confirmAction, initPullToRefresh, scrollToTop } from "./ui.js";
import { applyTheme, initThemeStudio, renderThemeGallery, renderAppearanceControls, cycleTheme, toggleScheme, setTheme } from "./theme.js";
import {
  renderTaskList, renderTimeline, initTaskSheet, openTaskSheet, toggleDone, skipTask,
  deleteTask, duplicateTask, pinTask, splitTask, provideRefresh as provideTaskRefresh,
} from "./tasks.js";
import { initQuickAdd, renderBulkDaySelect, submitQuickAdd } from "./quickadd.js";
import { initFocusEngine, renderFocusFacts, renderFocusQueue, renderSessionLog, renderTimerUI, selectTask, applyPreset, provideRefresh as provideFocusRefresh, timerValue } from "./focus.js";
import { initInsights, refreshInsights, renderUpNext } from "./insights.js";
import { initLibrary, renderLibrary } from "./library.js";
import { initSettings, fillSettingsForm, provideRefresh as provideSettingsRefresh, selectSettingsPane, openSettingsPane } from "./settings.js";
import { renderNow, renderDayMetrics, renderTopBar, initNowLiveUpdates, initDayControls, finishDayFlow, shiftDay, provideRefresh as provideNowRefresh } from "./now.js";
import { initPalette, initShortcuts, initFocusMode, openPalette } from "./palette.js";
import { initI18n } from "./i18n.js";
import { initHistoryCalendar, provideHistoryRefresh } from "./history-calendar.js";
import { initRoutineUI, renderRoutines } from "./routines-ui.js";

const TABS = ["today", "plan", "routines", "focus", "insights", "library"];
let refreshTimer = null;
let refreshing = false;

/* --------------------------------------------------------------------------
   Refresh pipeline
   -------------------------------------------------------------------------- */
export async function refresh({ silent = false } = {}) {
  if (refreshing) return store.state;
  refreshing = true;
  try {
    const data = await api.refresh({ silent: true });
    if (data) {
      // Keep the meta block (themes, palette, stats) fresh too.
      store.set(data);
      if (!silent) {
        renderAll();
        const historyOpen = byId("historyDaySheet") && !byId("historyDaySheet").hidden;
        if (document.getElementById("appRoot")?.dataset.tab === "insights" || historyOpen) refreshInsightsSafe();
      }
    }
    return store.state;
  } catch (error) {
    if (!silent) console.warn("[app] refresh failed", error);
    return store.state;
  } finally {
    refreshing = false;
  }
}

export function renderAll() {
  renderTopBar();
  renderDayMetrics();
  renderNow();
  renderTaskList();
  renderTimeline();
  renderUpNext();
  renderFocusFacts();
  renderFocusQueue();
  renderSessionLog();
  renderTimerUI();
  renderRoutines();
  renderBulbDaySelectSafe();
  renderLibrary();
  fillSettingsForm();
  renderAppearanceControls();
  renderThemeGallery();
  const note = byId("storageNote");
  if (note) note.textContent = storageNote();
}

function renderBulbDaySelectSafe() {
  try {
    renderBulkDaySelect();
  } catch (error) {
    console.warn("[app] bulk day select", error);
  }
}

async function refreshInsightsSafe() {
  try {
    await refreshInsights({ silent: true });
  } catch (error) {
    console.warn("[app] insights refresh failed", error);
  }
}

/* --------------------------------------------------------------------------
   Tabs
   -------------------------------------------------------------------------- */
export function switchTab(tab, { scroll = true } = {}) {
  const target = TABS.includes(tab) ? tab : "today";
  document.getElementById("appRoot").dataset.tab = target;
  prefs.set("lastTab", target);

  TABS.forEach((name) => {
    const view = byId(`view${name.charAt(0).toUpperCase()}${name.slice(1)}`);
    if (view) view.hidden = name !== target;
  });

  $$(".tab").forEach((button) => {
    const active = button.dataset.tab === target;
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$(".mobile-tab[data-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === target);
  });

  if (target === "insights") refreshInsightsSafe();
  if (target === "library") renderLibrary();
  if (target === "routines") renderRoutines();
  if (target === "plan") renderTimeline();
  if (target === "today") renderTaskList();
  if (scroll) scrollToTop("auto");
  emit("tab", { tab: target });
}

export function initTabs() {
  byId("tabbar")?.addEventListener("click", (event) => {
    const button = event.target.closest(".tab");
    if (button) switchTab(button.dataset.tab);
  });
  byId("mobileNav")?.addEventListener("click", (event) => {
    const button = event.target.closest(".mobile-tab");
    if (!button) return;
    if (button.dataset.action === "quick-add") {
      openPalette("new ");
      return;
    }
    switchTab(button.dataset.tab);
  });
  on("switch-tab", ({ tab, scroll } = {}) => switchTab(tab, { scroll }));
  on("theme", () => {
    renderNow();
    renderTaskList();
    renderTimeline();
  });
  on("scroll-to-day", ({ day }) => {
    const column = document.querySelector(`.day-column[data-day="${day}"]`);
    if (column) column.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    else toast(`Day ${day} is outside the current range — widen it in Plan → Range`, { tone: "warn" });
  });
  on("select-day", ({ day }) => {
    const current = store.settingNum("current_day_index", 1);
    if (Number(day) !== current) shiftDay(Number(day) - current);
  });
}

/* --------------------------------------------------------------------------
   Global buttons
   -------------------------------------------------------------------------- */
function initGlobalButtons() {
  byId("schemeBtn")?.addEventListener("click", () => toggleScheme());
  byId("paletteBtn")?.addEventListener("click", () => openPalette());
  byId("themeStudioBtn")?.addEventListener("click", () => openSheet("themeSheet"));
  byId("settingsBtn")?.addEventListener("click", () => openSheet("settingsSheet"));

  byId("sortBtn")?.addEventListener("click", cycleSortMode);
  byId("toggleDoneBtn")?.addEventListener("click", () => {
    const next = !prefs.get("toggleDone", store.setting("show_done", 1) === 1);
    prefs.set("toggleDone", next);
    api.settings({ show_done: next ? 1 : 0 }, { silent: true }).catch(() => null);
    renderTaskList();
  });
  byId("purgeDoneBtn")?.addEventListener("click", async () => {
    const current = store.settingNum("current_day_index", 1);
    const done = (store.get("tasks", []) || []).filter((task) => task.day_index === current && task.done);
    if (!done.length) {
      toast("Nothing finished to clean up on this day", { tone: "info" });
      return;
    }
    const ok = await confirmAction({
      title: `Archive ${done.length} finished task(s)?`,
      text: "They leave the timeline but stay in the backup and can be restored.",
      okLabel: "Archive",
      danger: false,
    });
    if (!ok) return;
    await api.purge(current);
    toast(`${done.length} task(s) archived`, { tone: "good" });
    await refresh();
  });

  byId("nowQueueBtn")?.addEventListener("click", () => switchTab("focus"));
  byId("expandQueueBtn")?.addEventListener("click", () => switchTab("focus"));
  byId("moreNowBtn")?.addEventListener("click", () => {
    const task = activeTask();
    if (!task) return;
    import("./tasks.js").then(({ taskActions }) => taskActions(task));
  });

  byId("ringTap")?.addEventListener("click", () => emit("timer-command", { action: "toggle" }));
  byId("startTimerBtn")?.addEventListener("click", () => {
    const timer = timerValue();
    if (timer.running) {
      emit("timer-command", { action: "toggle" });
      return;
    }
    emit("switch-tab", { tab: "focus", scroll: false });
    emit("timer-command", { action: "toggle" });
  });
  byId("doneBtn")?.addEventListener("click", () => {
    const task = activeTask();
    if (task) emissionTask("done", task.id);
  });
  byId("skipBtn")?.addEventListener("click", () => {
    const task = activeTask();
    if (task) emissionTask("skip", task.id);
  });
  byId("editNowBtn")?.addEventListener("click", () => {
    const task = activeTask();
    if (task) openTaskSheet(task.id);
  });

  // View mode / grouping selects
  byId("viewModeSelect")?.addEventListener("change", async (event) => {
    const mode = event.target.value;
    const customField = byId("customDaysField");
    if (customField) customField.hidden = mode !== "custom";
    const patch = { view_mode: mode };
    if (mode === "custom") patch.view_days = Number(byId("customDaysInput").value) || 4;
    await api.settings(patch);
    await refresh();
  });

  byId("customDaysInput")?.addEventListener("change", async () => {
    if (store.setting("view_mode") !== "custom") return;
    await api.settings({ view_days: Number(byId("customDaysInput").value) || 4 });
    await refresh();
  });

  byId("sortModeSelect")?.addEventListener("change", async (event) => {
    prefs.set("sortMode", event.target.value);
    await api.settings({ sort_mode: event.target.value });
    renderTaskList();
    renderTimeline();
  });

  byId("groupModeSelect")?.addEventListener("change", async (event) => {
    await api.settings({ group_mode: event.target.value });
    await refresh();
  });

  byId("carrySelect")?.addEventListener("change", async (event) => {
    await api.settings({ carry_over: event.target.value });
    toast(`Finish day will ${event.target.value === "never" ? "leave open tasks behind" : "carry open tasks forward"}`, { tone: "info" });
  });
}

function emissionTask(action, taskId) {
  emit("task-command", { action, taskId });
}

function cycleSortMode() {
  const modes = ["manual", "priority", "duration", "duration_desc", "alpha", "created"];
  const current = prefs.get("sortMode", store.setting("sort_mode", "manual"));
  const next = modes[(modes.indexOf(current) + 1) % modes.length];
  prefs.set("sortMode", next);
  api.settings({ sort_mode: next }, { silent: true }).catch(() => null);
  renderTaskList();
  renderTimeline();
  toast(`Sorted by ${next.replace("_", " ")}`, { tone: "info", timeout: 1600 });
}

/* --------------------------------------------------------------------------
   Task commands (from shortcuts, palette, buttons)
   -------------------------------------------------------------------------- */
function initTaskCommands() {
  on("task-command", async ({ action, taskId }) => {
    const task = (store.get("tasks", []) || []).find((item) => item.id === Number(taskId));
    if (!task) return;
    switch (action) {
      case "done":
        await toggleDone(task, true);
        break;
      case "reopen":
        await toggleDone(task, false);
        break;
      case "skip":
        await skipTask(task);
        break;
      case "edit":
        openTaskSheet(task.id);
        break;
      case "focus":
        selectTask(task.id, { start: true });
        emit("switch-tab", { tab: "focus" });
        break;
      case "duplicate":
        await duplicateTask(task);
        break;
      case "pin":
        await pinTask(task);
        break;
      case "split":
        await splitTask(task);
        break;
      case "delete":
        await deleteTask(task);
        break;
      default:
        break;
    }
  });

  on("apply-preset-internal", ({ preset }) => applyPreset(preset));
  on("reset-settings", () => import("./settings.js").then(({ resetSettings }) => resetSettings()));

  on("dnd-drop", ({ ids, day }) => {
    if (!day || !ids.length) return;
  });
}

/* --------------------------------------------------------------------------
   Connectivity feedback
   -------------------------------------------------------------------------- */
function initConnectivityUI() {
  const banner = byId("offlineBanner");
  on("connectivity", ({ online }) => {
    if (banner) banner.hidden = online;
    if (online) {
      const size = queueSize();
      if (size) toast(`Back online — syncing ${size} change(s)`, { tone: "info" });
    } else {
      toast("Offline — changes are queued and will sync automatically", { tone: "warn", timeout: 4200 });
    }
  });
  on("api-queued", () => {
    const size = queueSize();
    if (size === 1) toast("Saved locally — will sync when the server is reachable", { tone: "warn" });
  });
  on("flushed", ({ flushed }) => toast(`Synced ${flushed} queued change(s)`, { tone: "good" }));
  on("api-error", ({ path, error }) => {
    console.warn("[api]", path, error);
  });
  on("pull-refresh", async () => {
    await refresh();
    await refreshInsightsSafe();
    toast("Refreshed", { tone: "good", timeout: 1500 });
  });
  on("toast", ({ message, tone }) => toast(message, { tone: tone || "info" }));
  on("reminder", () => null);

  window.addEventListener("online", () => flushQueue());
}

/* --------------------------------------------------------------------------
   Housekeeping
   -------------------------------------------------------------------------- */
function startBackgroundSync() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    refresh({ silent: true });
  }, 45000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh({ silent: true });
  });
}

async function materializeRecurrences() {
  try {
    const rules = store.get("recurrences", []) || [];
    if (!rules.length) return;
    const current = store.settingNum("current_day_index", 1);
    await api.materialize(current + 7);
  } catch (error) {
    console.warn("[app] could not materialise recurrences", error);
  }
}

/* --------------------------------------------------------------------------
   Service worker (offline shell)
   -------------------------------------------------------------------------- */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* offline shell is a bonus, never a requirement */
  });
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */
export async function boot() {
  initI18n();
  document.addEventListener("taskarcade:locale", () => {
    renderAll();
    if (document.getElementById("appRoot")?.dataset.tab === "insights") refreshInsightsSafe();
  });
  prefs.load();
  applyTheme({ silent: true });

  // The boot payload carries themes/palette/shortcuts so the theme gallery can
  // render before the first API round trip finishes.
  const bootData = byId("bootData");
  if (bootData) {
    try {
      const parsed = JSON.parse(bootData.textContent || "{}");
      store.meta = { ...(store.meta || {}), ...parsed, stats: store.meta?.stats || {} };
      store.meta.legacy = parsed.legacy || {};
    } catch (error) {
      console.warn("[app] could not read boot payload", error);
    }
  }

  initSheets();
  initTabs();
  initThemeStudio();
  initTaskSheet();
  initQuickAdd();
  initDayControls();
  initNowLiveUpdates();
  initRoutineUI();
  initInsights();
  initLibrary();
  initSettings();
  initHistoryCalendar();
  initPalette();
  initShortcuts();
  initFocusMode();
  initGlobalButtons();
  initTaskCommands();
  initConnectivityUI();
  initPullToRefresh();
  initConnectivity();

  // refresh hooks (avoids circular imports)
  provideTaskRefresh(() => refresh());
  provideFocusRefresh(() => refresh());
  provideSettingsRefresh(() => refresh());
  provideNowRefresh(() => refresh());
  provideHistoryRefresh(() => refresh());

  initFocusEngine();

  // First load: render everything, then keep the app warm.
  await refresh({ silent: true });
  renderAll();
  switchTab(prefs.get("lastTab", "today"), { scroll: false });

  const select = byId("viewModeSelect");
  if (select) select.value = store.setting("view_mode", "today");
  const sortSelect = byId("sortModeSelect");
  if (sortSelect) sortSelect.value = prefs.get("sortMode", store.setting("sort_mode", "manual"));
  const groupSelect = byId("groupModeSelect");
  if (groupSelect) groupSelect.value = store.setting("group_mode", "day");
  const carrySelect = byId("carrySelect");
  if (carrySelect) carrySelect.value = store.setting("carry_over", "always");
  const customField = byId("customDaysField");
  if (customField) customField.hidden = store.setting("view_mode", "today") !== "custom";

  document.body.classList.remove("booting");
  startBackgroundSync();
  registerServiceWorker();
  window.setTimeout(materializeRecurrences, 2500);

  if (store.setting("seen_welcome", 0) !== 1) {
    api.settings({ seen_welcome: 1 }, { silent: true }).catch(() => null);
    window.setTimeout(() => {
      toast("Press ? for shortcuts, or Ctrl/⌘ K for the command palette", {
        tone: "info",
        timeout: 7000,
        action: { label: "Shortcuts", run: () => openSheet("helpSheet") },
      });
    }, 900);
  }

  emit("booted", { at: Date.now(), touch: isTouch() });
}

/* --------------------------------------------------------------------------
   Start
   -------------------------------------------------------------------------- */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

/* Expose a tiny debug surface — handy in the browser console and for tests. */
/* --------------------------------------------------------------------------
   Debug surface
   Everything the UI can do is reachable from the browser console — handy for
   power users who want to script TaskArcade, and for support to inspect state.
   -------------------------------------------------------------------------- */
window.TaskArcade = {
  version: "1.0.0",
  store,
  prefs,
  refresh,
  renderAll,
  switchTab,
  openPalette,
  openSettingsPane,
  setTheme,
  cycleTheme,
  toggleScheme,
  api,
  timerValue,
  /* view + sheet helpers */
  openSheet,
  closeSheet,
  closeAllSheets,
  toast,
  openTaskSheet,
  /* task commands (same handlers the UI calls) */
  actions: {
    toggleDone,
    skipTask,
    deleteTask,
    duplicateTask,
    pinTask,
    splitTask,
    submitQuickAdd,
    finishDayFlow,
    shiftDay,
    selectTask,
    applyPreset,
  },
  /* renderers, for manual repaint after poking at store.state */
  render: {
    tasks: renderTaskList,
    timeline: renderTimeline,
    now: renderNow,
    metrics: renderDayMetrics,
    topBar: renderTopBar,
    focusQueue: renderFocusQueue,
    focusFacts: renderFocusFacts,
    sessionLog: renderSessionLog,
    timer: renderTimerUI,
    insights: refreshInsights,
    upNext: renderUpNext,
    library: renderLibrary,
    settings: fillSettingsForm,
    bulkDays: renderBulkDaySelect,
    themes: renderThemeGallery,
    appearance: renderAppearanceControls,
  },
};
console.info(`%cTaskArcade ${window.TaskArcade.version}`, "color:#ff6b4a;font-weight:600", "— window.TaskArcade exposes store/actions/render for scripting.");
