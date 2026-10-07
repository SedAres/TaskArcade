/* ==========================================================================
   TaskArcade — command palette & keyboard layer
   One fuzzy-searchable list of commands, tasks, tags and themes, plus the
   global shortcut map. Everything the palette can do is also reachable with
   the keyboard alone.
   ========================================================================== */

import {
  byId, h, icon, clear, store, emit, on, prefs, activeTask, openTasksForDay,
  dayLabel, fmtDuration, clamp,
} from "./core.js";
import { api } from "./api.js";
import { openSheet, closeSheet, toggleSheet, toast, confirmAction, openSheet as openAny } from "./ui.js";
import { cycleTheme, toggleScheme, setTheme, currentThemeId } from "./theme.js";

let refresh = async () => {};
let selection = 0;
let currentResults = [];

export function provideRefresh(fn) {
  refresh = fn;
}

async function runHistoryAction(direction) {
  const isUndo = direction === "undo";
  try {
    const response = await api[isUndo ? "undo" : "redo"]();
    const result = response?.result;
    if (!result?.ok) {
      toast(result?.error || (isUndo ? "Nothing to undo" : "Nothing to redo"), { tone: "warn" });
      return;
    }
    toast(`${isUndo ? "Undid" : "Redid"}: ${result.label}`, {
      tone: "info",
      ...(isUndo ? { action: { label: "Redo", run: () => runHistoryAction("redo") } } : {}),
    });
    await refresh();
  } catch (error) {
    toast(error.message || (isUndo ? "Could not undo that change" : "Could not redo that change"), { tone: "warn" });
  }
}

/* --------------------------------------------------------------------------
   Command catalogue
   -------------------------------------------------------------------------- */
function commands() {
  const theme = currentThemeId();
  const current = store.settingNum("current_day_index", 1);
  const task = activeTask(current);
  const list = [
    { group: "Create", label: "New task (quick add)", icon: "plus", keywords: "add create new", run: () => emit("focus-quick-add", {}) },
    { group: "Create", label: "Paste many lines (bulk composer)", icon: "list", keywords: "bulk paste many lines import", run: () => emit("open-bulk", {}) },
    { group: "Create", label: "Save today as a template", icon: "template", keywords: "template save reuse", run: () => byId("saveDayTemplateBtn")?.click() },
    { group: "Create", label: "New recurring rule", icon: "repeat", keywords: "repeat recurrence recurring rule", run: () => byId("addRecurrenceBtn")?.click() },
    { group: "Create", label: "New tag with aliases", icon: "tag", keywords: "tag alias vocabulary", run: () => byId("addTagBtn")?.click() },

    { group: "Timer", label: "Start / pause the focus timer", icon: "play", keywords: "timer start pause focus pomodoro", run: () => emit("timer-command", { action: "toggle" }) },
    { group: "Timer", label: "Take a break now", icon: "coffee", keywords: "break rest pause", run: () => emit("timer-command", { action: "break" }) },
    { group: "Timer", label: "Log and stop the session", icon: "stop", keywords: "stop log end session", run: () => emit("timer-command", { action: "stop" }) },
    { group: "Timer", label: "Skip to the next phase", icon: "skip", keywords: "skip next phase", run: () => emit("timer-command", { action: "skip" }) },
    { group: "Timer", label: "Preset: 25 / 5", icon: "clock", keywords: "pomodoro classic 25", run: () => emit("apply-preset", { preset: "classic" }) },
    { group: "Timer", label: "Preset: 50 / 10 (deep work)", icon: "clock", keywords: "deep work 50", run: () => emit("apply-preset", { preset: "deep" }) },
    { group: "Timer", label: "Preset: 15 / 3 (sprint)", icon: "clock", keywords: "sprint 15", run: () => emit("apply-preset", { preset: "sprint" }) },

    { group: "Day", label: `Finish day ${current}`, icon: "arrow-right", keywords: "finish close end day next", run: () => byId("finishDayBtn")?.click() },
    { group: "Day", label: "Reopen the previous day", icon: "undo", keywords: "reopen back previous day", run: () => byId("reopenDayBtn")?.click() },
    { group: "Day", label: "Insert an empty day", icon: "calendar", keywords: "insert empty shift", run: () => byId("addDayBtn")?.click() },
    { group: "Day", label: "Go to today's counter", icon: "target", keywords: "today jump", run: () => emit("switch-tab", { tab: "today" }) },

    { group: "View", label: "Show the Now view", icon: "bolt", keywords: "now today home", run: () => emit("switch-tab", { tab: "today" }) },
    { group: "View", label: "Show the timeline", icon: "calendar", keywords: "plan timeline schedule", run: () => emit("switch-tab", { tab: "plan" }) },
    { group: "View", label: "Show the focus engine", icon: "clock", keywords: "focus timer", run: () => emit("switch-tab", { tab: "focus" }) },
    { group: "View", label: "Show insights", icon: "chart", keywords: "stats insights analytics charts", run: () => emit("switch-tab", { tab: "insights" }) },
    { group: "View", label: "Show the library", icon: "layers", keywords: "library templates tags backup", run: () => emit("switch-tab", { tab: "library" }) },
    { group: "View", label: "Toggle focus mode", icon: "target", keywords: "focus mode zen hide", run: () => emit("focus-mode-toggle", {}) },
    {
      group: "View",
      label: `Toggle light / dark (now ${document.documentElement.dataset.scheme})`,
      icon: "moon",
      keywords: "dark light scheme theme night",
      run: () => toggleScheme(),
    },
    { group: "View", label: "Cycle interface theme", icon: "layers", keywords: "theme cycle next style", run: () => cycleTheme(1) },
    { group: "View", label: "Open theme studio", icon: "sparkles", keywords: "theme studio appearance colours", run: () => openSheet("themeSheet") },

    { group: "Data", label: "Export a backup", icon: "download", keywords: "backup export save json", run: () => byId("exportBtn")?.click() },
    { group: "Data", label: "Export CSV", icon: "download", keywords: "csv export spreadsheet", run: () => byId("exportCsvBtn")?.click() },
    { group: "Data", label: "Import a backup", icon: "upload", keywords: "import restore backup", run: () => byId("importFile")?.click() },
    { group: "Data", label: "Undo the last change", icon: "undo", keywords: "undo revert back", run: () => runHistoryAction("undo") },
    { group: "Data", label: "Redo", icon: "redo", keywords: "redo again", run: () => runHistoryAction("redo") },
    { group: "Data", label: "Trim the activity log", icon: "inbox", keywords: "clean cleanup trim events", run: () => byId("cleanupEventsBtn")?.click() },

    { group: "Settings", label: "Open settings", icon: "settings", keywords: "settings preferences options", run: () => openSheet("settingsSheet") },
    { group: "Settings", label: "Behaviour settings", icon: "settings", keywords: "behaviour defaults", run: () => emit("open-settings", { pane: "behaviour" }) },
    { group: "Settings", label: "Time & day settings", icon: "calendar", keywords: "capacity goal rollover", run: () => emit("open-settings", { pane: "time" }) },
    { group: "Settings", label: "Timer settings", icon: "clock", keywords: "pomodoro idle chime volume", run: () => emit("open-settings", { pane: "focus" }) },
    { group: "Settings", label: "Alert settings", icon: "bell", keywords: "notifications reminders alerts", run: () => emit("open-settings", { pane: "notify" }) },
    { group: "Settings", label: "Keyboard shortcuts", icon: "help", keywords: "help keys shortcuts cheat", run: () => openSheet("helpSheet") },
    { group: "Settings", label: "Reset my preferences", icon: "undo", keywords: "reset settings defaults", run: () => emit("reset-settings", {}) },
  ];

  if (task) {
    list.push(
      { group: "Active task", label: `Complete “${task.title}”`, icon: "check", keywords: "done complete finish", run: () => emit("task-command", { action: "done", taskId: task.id }) },
      { group: "Active task", label: `Move “${task.title}” to the end`, icon: "skip", keywords: "skip defer later", run: () => emit("task-command", { action: "skip", taskId: task.id }) },
      { group: "Active task", label: `Edit “${task.title}”`, icon: "pen", keywords: "edit change", run: () => emit("task-command", { action: "edit", taskId: task.id }) },
      { group: "Active task", label: `Focus on “${task.title}”`, icon: "play", keywords: "focus start work", run: () => emit("task-command", { action: "focus", taskId: task.id }) },
    );
  }

  (store.get("tags", []) || []).forEach((tag) => {
    list.push({
      group: "Tags",
      label: `Filter by #${tag.label}`,
      icon: tag.icon || "tag",
      keywords: `tag ${tag.name} ${(tag.aliases || []).join(" ")}`,
      run: () => {
        emit("switch-tab", { tab: "plan" });
        toast(`#${tag.label}: ${(store.get("tasks", []) || []).filter((item) => item.tag === tag.name).length} task(s)`, { tone: "info" });
      },
    });
  });

  const activeThemeId = currentThemeId();
  (store.meta?.themes || []).forEach((theme) => {
    if (theme.id === activeThemeId) return;
    list.push({
      group: "Themes",
      label: `Use ${theme.label} — ${theme.tagline || "palette"}`,
      icon: "sparkles",
      keywords: `theme ${theme.id} ${theme.tagline || ""}`,
      run: () => {
        setTheme(theme.id);
        toast(`${theme.label} applied`, { tone: "good" });
      },
    });
  });

  return list;
}

function taskItems() {
  const current = store.settingNum("current_day_index", 1);
  return (store.get("tasks", []) || []).map((task) => ({
    group: "Tasks",
    label: task.title,
    sub: `${dayLabel(task.day_index, current)} · ${fmtDuration(task.remaining_seconds)}${task.tag ? ` · #${task.tag}` : ""}`,
    icon: task.done ? "check" : "bolt",
    keywords: `${task.title} ${task.tag} ${task.notes}`,
    run: () => emit("task-command", { action: "edit", taskId: task.id }),
  }));
}

/* --------------------------------------------------------------------------
   Fuzzy match
   -------------------------------------------------------------------------- */
function score(item, query) {
  if (!query) return 1;
  const haystack = `${item.label} ${item.group} ${item.keywords || ""} ${item.sub || ""}`.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;
  if (haystack.includes(needle)) return 100 - haystack.indexOf(needle);

  // subsequence match
  let index = 0;
  let hits = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, index);
    if (found === -1) return 0;
    hits += found === index ? 3 : 1;
    index = found + 1;
  }
  return hits;
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */
function renderResults(query) {
  const holder = byId("paletteResults");
  if (!holder) return;
  const pool = [...commands(), ...taskItems()];
  const scored = pool
    .map((item) => ({ item, value: score(item, query) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 40)
    .map((entry) => entry.item);

  currentResults = scored;
  selection = clamp(selection, 0, Math.max(0, scored.length - 1));
  clear(holder);

  if (!scored.length) {
    holder.appendChild(h("li", { class: "palette-empty" }, `Nothing matches “${query}”. Try “theme”, “timer” or a task name.`));
    return;
  }

  let lastGroup = null;
  scored.forEach((item, index) => {
    if (item.group !== lastGroup) {
      holder.appendChild(h("li", { class: "palette-group" }, item.group));
      lastGroup = item.group;
    }
    const node = h("li", {}, [
      h("button", {
        class: `palette-item${index === selection ? " is-active" : ""}`,
        type: "button",
        onclick: () => runItem(item),
        onmouseenter: () => {
          selection = index;
          markSelection();
        },
      }, [
        icon(item.icon || "sparkles"),
        h("span", { class: "grow" }, [
          h("span", { class: "palette-label" }, item.label),
          item.sub ? h("small", { class: "palette-sub" }, item.sub) : null,
        ]),
        index === selection ? h("kbd", {}, "↵") : null,
      ]),
    ]);
    holder.appendChild(node);
  });
}

function markSelection() {
  const items = [...document.querySelectorAll(".palette-item")];
  items.forEach((node, index) => node.classList.toggle("is-active", index === selection));
  items[selection]?.scrollIntoView({ block: "nearest" });
}

function runItem(item) {
  closeSheet("paletteSheet");
  window.setTimeout(() => {
    try {
      item.run();
    } catch (error) {
      console.error("[palette] command failed", error);
      toast("That command failed", { tone: "error" });
    }
  }, 90);
}

export function openPalette(initial = "") {
  const input = byId("paletteInput");
  if (!input) return;
  input.value = initial;
  selection = 0;
  renderResults(initial);
  openSheet("paletteSheet");
  window.setTimeout(() => input.focus({ preventScroll: true }), 60);
}

export function initPalette() {
  const input = byId("paletteInput");
  input?.addEventListener("input", () => {
    selection = 0;
    renderResults(input.value);
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selection = clamp(selection + 1, 0, currentResults.length - 1);
      markSelection();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selection = clamp(selection - 1, 0, currentResults.length - 1);
      markSelection();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = currentResults[selection];
      if (item) runItem(item);
    }
  });

  byId("paletteBtn")?.addEventListener("click", () => openPalette());
}

/* --------------------------------------------------------------------------
   Keyboard shortcuts
   -------------------------------------------------------------------------- */
function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function initShortcuts() {
  document.addEventListener("keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;
    const typing = isTyping(event.target);
    const anySheetOpen = document.querySelector(".sheet.is-open, .dialog:not([hidden])");

    // --- always available -------------------------------------------------
    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
      return;
    }
    if (meta && event.key === ",") {
      event.preventDefault();
      openSheet("settingsSheet");
      return;
    }
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void runHistoryAction(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (meta && event.key.toLowerCase() === "s") {
      event.preventDefault();
      byId("saveTaskBtn")?.click();
      return;
    }

    if (event.key === "Escape") {
      const openSheets = document.querySelectorAll(".sheet.is-open");
      if (openSheets.length) {
        closeSheet(openSheets[openSheets.length - 1]);
        return;
      }
      if (document.body.classList.contains("focus-mode")) {
        emit("focus-mode-toggle", { force: false });
      }
      return;
    }

    if (typing || anySheetOpen) {
      if (event.key === "?" && !typing) openSheet("helpSheet");
      return;
    }

    // --- single-key shortcuts --------------------------------------------
    switch (event.key) {
      case "?":
        event.preventDefault();
        toggleSheet("helpSheet");
        break;
      case "/":
        event.preventDefault();
        openPalette();
        break;
      case "n":
        event.preventDefault();
        emit("focus-quick-add", {});
        break;
      case "N":
        event.preventDefault();
        emit("open-bulk", {});
        break;
      case " ":
        event.preventDefault();
        emit("timer-command", { action: "toggle" });
        break;
      case "d": {
        const task = activeTask();
        if (task) emit("task-command", { action: "done", taskId: task.id });
        break;
      }
      case "s": {
        const task = activeTask();
        if (task) emit("task-command", { action: "skip", taskId: task.id });
        break;
      }
      case "e": {
        const task = activeTask();
        if (task) emit("task-command", { action: "edit", taskId: task.id });
        break;
      }
      case "f":
        emit("focus-mode-toggle", {});
        break;
      case "t":
        toggleSheet("themeSheet");
        break;
      case "i":
        emit("switch-tab", { tab: "insights" });
        break;
      case "l":
        toggleScheme();
        break;
      case "T":
        cycleTheme(1);
        break;
      case "j":
        byId("dayPrev")?.click();
        break;
      case "k":
        byId("dayNext")?.click();
        break;
      case "u":
        void runHistoryAction("undo");
        break;
      case "U":
        void runHistoryAction("redo");
        break;
      case "1": case "2": case "3": case "4": case "5": {
        const offset = Number(event.key) - 1;
        const current = store.settingNum("current_day_index", 1);
        emit("switch-tab", { tab: "plan" });
        emit("scroll-to-day", { day: current + offset });
        break;
      }
      default:
        break;
    }
  });

  byId("helpBtn")?.addEventListener("click", () => toggleSheet("helpSheet"));
  byId("aboutHelp")?.addEventListener("click", () => openSheet("helpSheet"));
  byId("themeStudioBtn")?.addEventListener("click", () => toggleSheet("themeSheet"));
  byId("aboutThemes")?.addEventListener("click", () => openSheet("themeSheet"));
  byId("aboutSettings")?.addEventListener("click", () => openSheet("settingsSheet"));

  on("open-sheet", ({ id }) => openSheet(id));
  on("apply-preset", ({ preset }) => emit("apply-preset-internal", { preset }));
}

/* --------------------------------------------------------------------------
   Focus mode
   -------------------------------------------------------------------------- */
export function initFocusMode() {
  const button = byId("focusModeBtn");
  const apply = (value) => {
    const on = !!value;
    document.body.classList.toggle("focus-mode", on);
    button?.classList.toggle("is-active", on);
    prefs.set("focusMode", on);
    toast(on ? "Focus mode on — press F to leave" : "Focus mode off", { tone: "info", timeout: 2000 });
  };
  button?.addEventListener("click", () => apply(!document.body.classList.contains("focus-mode")));
  on("focus-mode-toggle", ({ force } = {}) => {
    apply(force === undefined ? !document.body.classList.contains("focus-mode") : force);
  });
  if (prefs.get("focusMode", false)) apply(true);
}
