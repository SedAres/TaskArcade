/* ==========================================================================
   TaskArcade — settings sheet
   Two-way binding for every server-side preference, grouped into panes so the
   sheet stays scannable on a phone. Booleans save instantly, text fields save
   on blur/Enter, and every save creates an undo checkpoint server-side.
   ========================================================================== */

import {
  byId, h, icon, clear, store, emit, on, prefs, clamp, fmtDuration, fmtMinutes,
  currentCalendarSystem, formatCalendarDate, fmtPercent,
} from "./core.js";
import { parseCalendarDate, normalizeDigits } from "./calendar-utils.js";
import { api } from "./api.js";
import { toast, confirmAction } from "./ui.js";
import { requestNotificationPermission, timerValue } from "./focus.js";

const t = (value) => window.TaskArcadeI18n?.t?.(value) ?? value;

let refresh = async () => {};
export function provideRefresh(fn) {
  refresh = fn;
}

/* --------------------------------------------------------------------------
   Field map: settings key → input id + coercion
   -------------------------------------------------------------------------- */
const TEXT_FIELDS = {
  greeting: "greetingInput",
  workday_start: "workdayStartInput",
  workday_end: "workdayEndInput",
  server_url: "serverUrlInput",
  timezone: "timezoneInput",
  time_format: "timeFormatSelect",
  count_mode: "countModeSelect",
  week_start: "weekStartSelect",
};

const SELECT_FIELDS = {
  language: "languageSelect",
  calendar_system: "calendarSystemSelect",
  persian_font: "persianFontSelect",
  digit_style: "digitStyleSelect",
};

const BOOLEAN_FIELDS = {
  auto_done: "autoDoneSwitch",
  show_done: "showDoneSwitch",
  show_notes_inline: "notesInlineSwitch",
  compact_meta: "compactMetaSwitch",
  confirm_destructive: "confirmSwitch",
  pomodoro_auto_start: "pomoAutoSwitch",
  sound: "soundSwitch",
  notifications: "notifySwitch",
  routine_auto_advance: "routineAutoAdvanceSwitch",
  routine_sound: "routineSoundSwitch",
  routine_vibrate: "routineVibrateSwitch",
  routine_keep_awake: "routineKeepAwakeSwitch",
  routine_show_next: "routineShowNextSwitch",
};

const NUMBER_FIELDS = {
  default_duration: "defaultDurationInput",
  wip_limit: "wipInput",
  undo_limit: "undoLimitInput",
  day_start_hour: "dayStartInput",
  capacity_minutes: "capacityInput",
  daily_goal_minutes: "goalInput",
  pomodoro_focus: "pomoFocusInput",
  pomodoro_break: "pomoBreakInput",
  pomodoro_long_break: "pomoLongInput",
  pomodoro_cycles: "pomoCyclesInput",
  idle_seconds: "idleInput",
  reminder_lead: "reminderLeadInput",
};

/* --------------------------------------------------------------------------
   Loading state into the form
   -------------------------------------------------------------------------- */
export function fillSettingsForm() {
  const settings = store.get("settings", {}) || {};

  Object.entries(TEXT_FIELDS).forEach(([key, id]) => {
    const input = byId(id);
    if (input && document.activeElement !== input) input.value = settings[key] ?? "";
  });

  Object.entries(SELECT_FIELDS).forEach(([key, id]) => {
    const input = byId(id);
    const fallback = key === "language" ? "en" : (key === "calendar_system" || key === "digit_style" ? "auto" : "vazirmatn");
    if (input && document.activeElement !== input) input.value = String(settings[key] ?? fallback);
  });
  const anchorInput = byId("calendarStartDateInput");
  if (anchorInput && document.activeElement !== anchorInput) {
    const anchor = String(settings.calendar_start_date || "").slice(0, 10);
    anchorInput.value = anchor ? formatCalendarDate(anchor, currentCalendarSystem()) : "";
  }

  Object.entries(NUMBER_FIELDS).forEach(([key, id]) => {
    const input = byId(id);
    if (input && document.activeElement !== input) input.value = settings[key] ?? "";
  });

  Object.entries(BOOLEAN_FIELDS).forEach(([key, id]) => {
    const button = byId(id);
    if (button) button.setAttribute("aria-checked", Number(settings[key]) === 1 ? "true" : "false");
  });

  const volumeRange = byId("volumeRange");
  const volumeOut = byId("volumeOut");
  if (volumeRange && document.activeElement !== volumeRange) {
    const volume = Math.round((Number(prefs.get("volume", settings.sound_volume ?? 0.5)) || 0.5) * 100);
    volumeRange.value = String(volume);
    if (volumeOut) volumeOut.textContent = fmtPercent(volume);
  }

  const reminderWindow = byId("reminderWindowInput");
  if (reminderWindow && document.activeElement !== reminderWindow) {
    reminderWindow.value = String(prefs.get("reminderWindow", 60));
  }

  renderShortcutList();
  renderSyncStatus();
}

function renderSyncStatus() {
  const pill = byId("syncPill");
  const detail = byId("syncDetail");
  if (!pill || !detail) return;
  const base = (store.setting("server_url", "") || "").trim();
  if (!base) {
    pill.textContent = t("not configured");
    pill.className = "pill";
    detail.textContent = t("Countdowns follow your local timer rules.");
  }
}

/* --------------------------------------------------------------------------
   Shortcut list
   -------------------------------------------------------------------------- */
export function renderShortcutList() {
  const holder = byId("shortcutList");
  const helpHolder = byId("helpShortcutList");
  const shortcuts = store.meta?.shortcuts || [];
  if (holder) {
    clear(holder);
    shortcuts.forEach((item) => {
      holder.appendChild(h("li", {}, [h("kbd", {}, item.keys), h("span", {}, item.action)]));
    });
  }
  if (helpHolder) {
    clear(helpHolder);
    shortcuts.forEach((item) => {
      helpHolder.appendChild(h("li", {}, [h("kbd", {}, item.keys), h("span", {}, item.action)]));
    });
  }

  const syntax = byId("syntaxList");
  if (!syntax) return;
  clear(syntax);
  const examples = [
    ["#tag or #alias", "Attach a tag — aliases resolve, e.g. #t → #tracked"],
    ["@09:30 · @now · @+25m", "Schedule a task on the clock"],
    ["! !! !!!", "Low, medium and high priority"],
    ["~90m · ~1h30m · ~2p", "Explicit estimate (p = one pomodoro)"],
    ["*daily · *weekdays · *3d", "Repeat rule, materialised by the Library"],
    ["+step", "Attach a subtask to the task on this line"],
    [">note", "Everything after > becomes the task note"],
    ["^", "Pin the task to the top of its day"],
    ["indented line or -item", "In the bulk composer, adds a subtask to the line above"],
  ];
  examples.forEach(([keys, description]) => {
    syntax.appendChild(h("li", {}, [h("code", {}, keys), h("span", {}, description)]));
  });
}

/* --------------------------------------------------------------------------
   Saving
   -------------------------------------------------------------------------- */
async function saveSettings(patch, { silent = false } = {}) {
  try {
    await api.settings(patch);
    if (!silent) await refresh();
    return true;
  } catch (error) {
    toast(error.message || "Could not save that setting", { tone: "error" });
    return false;
  }
}

export function initSettings() {
  // --- text & select fields -------------------------------------------
  Object.entries(TEXT_FIELDS).forEach(([key, id]) => {
    const input = byId(id);
    if (!input) return;
    const commit = () => {
      const value = input.value;
      if (String(store.setting(key, "")) === String(value)) return;
      saveSettings({ [key]: value }, { silent: key === "server_url" });
      if (key === "server_url") {
        toast("Server URL saved", { tone: "good" });
      }
    };
    input.addEventListener("change", commit);
    if (input.tagName === "INPUT") input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
    });
  });

  // --- locale and calendar fields --------------------------------------
  Object.entries(SELECT_FIELDS).forEach(([key, id]) => {
    const input = byId(id);
    if (!input) return;
    input.addEventListener("change", async () => {
      const value = input.value;
      if (String(store.setting(key, key === "language" ? "en" : "auto")) === value) return;
      await saveSettings({ [key]: value });
    });
  });

  const anchorInput = byId("calendarStartDateInput");
  const saveAnchor = async () => {
    const value = normalizeDigits(anchorInput?.value || "").trim();
    if (value === String(store.setting("calendar_start_date", "") || "")) return;
    if (value) {
      try { parseCalendarDate(value, currentCalendarSystem()); }
      catch {
        toast("Enter a valid date for the selected calendar", { tone: "warn" });
        anchorInput?.focus();
        return;
      }
    }
    await saveSettings({ calendar_start_date: value });
  };
  anchorInput?.addEventListener("change", saveAnchor);
  anchorInput?.addEventListener("blur", saveAnchor);
  anchorInput?.addEventListener("keydown", (event) => { if (event.key === "Enter") saveAnchor(); });

  // --- numeric fields --------------------------------------------------
  Object.entries(NUMBER_FIELDS).forEach(([key, id]) => {
    const input = byId(id);
    if (!input) return;
    const commit = () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      if (Number(store.setting(key, 0)) === value) return;
      saveSettings({ [key]: value });
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
    });
  });

  // --- booleans --------------------------------------------------------
  Object.entries(BOOLEAN_FIELDS).forEach(([key, id]) => {
    const button = byId(id);
    if (!button) return;
    button.addEventListener("click", async () => {
      const next = button.getAttribute("aria-checked") !== "true";
      if (key === "notifications" && next) {
        const granted = await requestNotificationPermission();
        if (!granted) return;
      }
      button.setAttribute("aria-checked", next ? "true" : "false");
      if (key === "show_done") prefs.set("toggleDone", next);
      await saveSettings({ [key]: next ? 1 : 0 });
      if (key === "show_done") emit("state", store.state);
    });
  });

  byId("saveServerUrlBtn")?.addEventListener("click", async () => {
    const input = byId("serverUrlInput");
    if (!input) return;
    await saveSettings({ server_url: input.value.trim() }, { silent: true });
    toast("Server URL saved — polling will restart on the next tick", { tone: "good" });
  });

  // --- volume & reminder window (device-local) -------------------------
  const volumeRange = byId("volumeRange");
  const volumeOut = byId("volumeOut");
  volumeRange?.addEventListener("input", (event) => {
    const value = Number(event.target.value);
    if (volumeOut) volumeOut.textContent = fmtPercent(value);
    prefs.set("volume", value / 100);
  });
  volumeRange?.addEventListener("change", (event) => {
    saveSettings({ sound_volume: Number(event.target.value) / 100 }, { silent: true });
  });

  byId("reminderWindowInput")?.addEventListener("change", (event) => {
    prefs.set("reminderWindow", clamp(Number(event.target.value) || 60, 5, 1440));
    toast("Reminder window updated", { tone: "info" });
  });

  byId("settingsHelpBtn")?.addEventListener("click", () => emit("open-sheet", { id: "guideSheet" }));

  // --- sheet tabs -------------------------------------------------------
  const tabs = byId("settingsTabs");
  tabs?.addEventListener("click", (event) => {
    const button = event.target.closest(".sheet-tab");
    if (!button) return;
    selectSettingsPane(button.dataset.pane);
  });

  on("open-settings", ({ pane } = {}) => {
    emit("open-sheet", { id: "settingsSheet" });
    if (pane) selectSettingsPane(pane);
  });

  on("state", () => fillSettingsForm());
}

export function selectSettingsPane(pane) {
  const tabs = byId("settingsTabs");
  const body = byId("settingsBody");
  if (!tabs || !body) return;
  tabs.querySelectorAll(".sheet-tab").forEach((button) => {
    const active = button.dataset.pane === pane;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  body.querySelectorAll(".pane").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.pane === pane);
  });
  body.scrollTop = 0;
}

export function openSettingsPane(pane = "behaviour") {
  emit("open-sheet", { id: "settingsSheet" });
  selectSettingsPane(pane);
}

/* --------------------------------------------------------------------------
   Reset
   -------------------------------------------------------------------------- */
export async function resetSettings() {
  const ok = await confirmAction({
    title: "Reset preferences?",
    text: "Every setting returns to its default value. Tasks and tags are untouched.",
    okLabel: "Reset settings",
    danger: false,
  });
  if (!ok) return;
  await api.resetSettings();
  toast("Preferences reset", { tone: "good" });
  await refresh();
}

/* --------------------------------------------------------------------------
   Compact summary used by the command palette
   -------------------------------------------------------------------------- */
export function settingsSummary() {
  const settings = store.get("settings", {}) || {};
  const timer = timerValue();
  return [
    { label: "Theme", value: prefs.get("theme", "lumen") },
    { label: "Scheme", value: prefs.get("scheme", "auto") },
    { label: "Density", value: prefs.get("density", "cozy") },
    { label: "Day length", value: `${settings.capacity_minutes ?? 480}m capacity` },
    { label: "Focus goal", value: fmtMinutes(settings.daily_goal_minutes ?? 240) },
    { label: "Pomodoro", value: `${settings.pomodoro_focus}/${settings.pomodoro_break} min` },
    { label: "Timer", value: `${timer.phase}${timer.running ? " running" : ""}` },
    { label: "Time format", value: settings.time_format || "hm" },
  ].map((row) => h("div", { class: "row-between" }, [h("span", {}, row.label), h("strong", {}, String(row.value))]));
}

export function goalProgress() {
  const goal = store.settingNum("daily_goal_minutes", 240) * 60;
  const day = store.meta?.stats?.days?.slice(-1)[0];
  const focus = day?.focus_seconds || 0;
  return { goal, focus, ratio: goal ? clamp(focus / goal, 0, 1) : 0, text: `${fmtDuration(focus)} / ${fmtDuration(goal)}` };
}
