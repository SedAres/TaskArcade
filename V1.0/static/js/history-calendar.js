/* TaskArcade — integrated Gregorian / Solar Hijri date picker and editable history. */
import {
  byId, h, icon, clear, store, on, dayLabel, calendarDateForDay, calendarAnchorDate,
  currentCalendarSystem, formatCalendarDate, formatNumber, fmtDuration, parseDurationText,
} from "./core.js";
import {
  addCalendarMonths, addIsoDays, datePartsForSystem, isoDayDifference, monthLength,
  monthParts, monthStartIso, normalizeDigits, parseCalendarDate,
} from "./calendar-utils.js";
import { api } from "./api.js";
import { openSheet, closeSheet, formDialog, confirmAction, toast } from "./ui.js";
import { openTaskSheet } from "./tasks.js";

const MONTHS_JALALI = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
let refreshApp = async () => {};
let visibleMonth = null;
let selectedDay = null;
let activeHistoryDay = null;
let historyDetail = null;

function t(value) {
  return window.TaskArcadeI18n?.t?.(value) ?? value;
}

function currentDay() {
  return store.settingNum("current_day_index", 1);
}

function virtualDayForDate(isoDate) {
  return isoDayDifference(isoDate, calendarAnchorDate()) + 1;
}

function isoForVirtualDay(dayIndex) {
  return calendarDateForDay(Math.max(1, Number(dayIndex) || 1));
}

function dateForNow() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function weekdayStart() {
  const value = Number(store.setting("week_start", store.setting("language", "en") === "fa" ? 6 : 1));
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : (store.setting("language", "en") === "fa" ? 6 : 1);
}

function monthName(year, month, system) {
  if (system === "jalali") return MONTHS_JALALI[month - 1];
  const locale = store.setting("language", "en") === "fa" ? "fa-IR-u-ca-gregory" : "en-US";
  return new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function dateWeekday(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function renderCalendar() {
  const settings = store.get("settings", {}) || {};
  const system = currentCalendarSystem();
  const baseIso = isoForVirtualDay(currentDay()) || dateForNow();
  if (!visibleMonth) visibleMonth = monthParts(baseIso, system);
  const { year, month } = visibleMonth;
  const daysInMonth = monthLength(year, month, system);
  const startIso = monthStartIso(year, month, system);
  const startOffset = (dateWeekday(startIso) - weekdayStart() + 7) % 7;
  const monthLabel = `${monthName(year, month, system)} ${formatNumber(year)}`;
  const title = byId("calendarVisibleMonth");
  const heading = byId("calendarMonthTitle");
  if (title) title.textContent = monthLabel;
  if (heading) heading.textContent = t("Select a day");

  const weekdays = byId("calendarWeekdays");
  if (weekdays) {
    clear(weekdays);
    for (let offset = 0; offset < 7; offset += 1) {
      const weekday = (weekdayStart() + offset) % 7;
      const label = WEEKDAYS[weekday];
      weekdays.appendChild(h("span", { title: t(WEEKDAY_FULL[weekday]) }, t(label)));
    }
  }

  const grid = byId("calendarGrid");
  if (grid) {
    clear(grid);
    for (let blank = 0; blank < startOffset; blank += 1) {
      grid.appendChild(h("span", { class: "calendar-day calendar-day-blank", "aria-hidden": "true" }));
    }
    const currentIso = isoForVirtualDay(currentDay());
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = addIsoDays(startIso, day - 1);
      const virtualIndex = virtualDayForDate(iso);
      const available = virtualIndex >= 1;
      const isCurrent = iso === currentIso;
      const isSelected = iso === isoForVirtualDay(selectedDay ?? currentDay());
      const dateValue = formatCalendarDate(iso);
      const button = h("button", {
        class: `calendar-day${isCurrent ? " is-current" : ""}${isSelected ? " is-selected" : ""}${!available ? " is-unavailable" : ""}`,
        type: "button",
        role: "gridcell",
        disabled: !available,
        "aria-current": isCurrent ? "date" : null,
        "aria-label": `${dateValue}, ${t("Virtual day")} ${formatNumber(virtualIndex)}`,
        title: `${dateValue} · ${t("Virtual day")} ${formatNumber(virtualIndex)}`,
        onclick: () => {
          if (available) goToDay(virtualIndex);
        },
      }, formatNumber(day));
      grid.appendChild(button);
    }
  }

  const input = byId("calendarDateInput");
  if (input && document.activeElement !== input) input.value = formatCalendarDate(isoForVirtualDay(selectedDay ?? currentDay()));
  const note = byId("calendarAnchorNote");
  if (note) {
    const anchor = settings.calendar_start_date;
    note.textContent = anchor
      ? `${t("Virtual day")} 1 · ${formatCalendarDate(anchor)}`
      : t("Set date for virtual day 1 in Settings → Language & calendar.");
  }
}

async function goToDay(dayIndex) {
  const day = Math.max(1, Number(dayIndex) || 1);
  try {
    const patch = { current_day_index: day };
    if (!store.setting("calendar_start_date", "")) patch.calendar_start_date = formatCalendarDate(calendarAnchorDate());
    await api.settings(patch);
    selectedDay = day;
    await refreshApp();
    closeSheet("calendarSheet");
    toast(`${t("Virtual day")} ${formatNumber(day)} · ${formatCalendarDate(isoForVirtualDay(day))}`, { tone: "info", timeout: 2200 });
  } catch (error) {
    toast(error.message || t("Could not change the day"), { tone: "error" });
  }
}

function openCalendar() {
  selectedDay = currentDay();
  visibleMonth = monthParts(isoForVirtualDay(selectedDay) || dateForNow(), currentCalendarSystem());
  renderCalendar();
  openSheet("calendarSheet");
}

function commitCalendarInput() {
  const input = byId("calendarDateInput");
  const value = normalizeDigits(input?.value || "").trim();
  if (!value) return;
  let iso;
  try { iso = parseCalendarDate(value, currentCalendarSystem()); }
  catch {
    toast(t("Enter a valid date for the selected calendar"), { tone: "warn" });
    input?.focus();
    return;
  }
  const day = virtualDayForDate(iso);
  if (day < 1) {
    toast(t("The selected date is before virtual day 1."), { tone: "warn" });
    return;
  }
  goToDay(day);
}

function moveCalendarMonth(delta) {
  const system = currentCalendarSystem();
  const base = visibleMonth || monthParts(isoForVirtualDay(currentDay()), system);
  visibleMonth = addCalendarMonths(base.year, base.month, delta, system);
  renderCalendar();
}

function elapsedSeconds(task) {
  const fallback = Number(task.total_seconds || 0) - (task.done ? 0 : Number(task.remaining_seconds || 0));
  return Math.max(0, Number(task.elapsed_seconds ?? fallback));
}

function renderHistorySummary(detail) {
  const summary = byId("historicalSummary");
  if (!summary) return;
  clear(summary);
  const data = detail.summary || {};
  const metrics = [
    ["Tasks", `${formatNumber(data.done || 0)} / ${formatNumber(data.tasks || 0)}`],
    ["Planned time", formatDurationForHistory(data.planned_seconds)],
    ["Elapsed time", formatDurationForHistory(data.done_seconds)],
    ["Focused time", formatDurationForHistory(data.focus_seconds)],
    ["Capacity", `${formatNumber(data.capacity_minutes || 0)} ${t("minutes")}`],
  ];
  metrics.forEach(([label, value]) => summary.appendChild(h("article", { class: "history-metric" }, [h("span", {}, t(label)), h("strong", {}, value)])));
}

function formatDurationForHistory(seconds) {
  return fmtDuration(seconds);
}

function renderHistoryTasks(detail) {
  const holder = byId("historyTaskList");
  if (!holder) return;
  clear(holder);
  const tasks = detail.tasks || [];
  if (!tasks.length) {
    holder.appendChild(h("div", { class: "history-empty" }, t("No tasks recorded for this day.")));
    return;
  }
  tasks.forEach((task) => {
    const row = h("article", { class: `history-record${task.done ? " is-done" : ""}${task.archived ? " is-archived" : ""}` });
    const main = h("div", { class: "history-record-main" }, [
      h("strong", { class: "task-title" }, task.title),
      h("span", { class: "history-record-meta" }, [
        h("span", {}, task.done ? t("Completed") : t("Open")),
        h("span", {}, `${t("Planned")}: ${formatDurationForHistory(task.total_seconds)}`),
        h("span", {}, `${t("Elapsed time")}: ${formatDurationForHistory(elapsedSeconds(task))}`),
        task.tag ? h("span", { class: "user-content" }, `#${task.tag}`) : null,
        task.archived ? h("span", { class: "pill" }, t("Archived")) : null,
      ]),
    ]);
    const actions = h("div", { class: "history-record-actions" });
    const edit = h("button", { class: "btn btn-sm", type: "button", onclick: () => openTaskSheet(task.id) }, t("Edit"));
    actions.appendChild(edit);
    if (task.archived) {
      actions.appendChild(h("button", { class: "btn btn-sm", type: "button", onclick: async () => {
        try { await api.restoreTask(task.id); await refreshApp(); await loadHistoryDay(activeHistoryDay, false); }
        catch (error) { toast(error.message || t("Could not restore task"), { tone: "error" }); }
      } }, t("Restore")));
    }
    row.append(main, actions);
    holder.appendChild(row);
  });
}

function dateTimePartsInZone(date) {
  const timeZone = String(store.setting("timezone", "") || "").trim();
  const options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) };
  try {
    return Object.fromEntries(new Intl.DateTimeFormat("en-CA-u-nu-latn", options).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  } catch {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString();
    const match = local.match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/);
    return match ? { year: match[1], month: match[2], day: match[3], hour: match[4], minute: match[5] } : null;
  }
}

function localDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = dateTimePartsInZone(date);
  return parts ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` : "";
}

function localDateTimeToIso(value) {
  const match = normalizeDigits(String(value || "")).match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/);
  if (!match) return "";
  const [, year, month, day, hour, minute] = match.map(Number);
  const zone = String(store.setting("timezone", "") || "").trim();
  if (!zone) return new Date(year, month - 1, day, hour, minute).toISOString();
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = dateTimePartsInZone(new Date(guess));
    if (!parts) break;
    const rendered = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const correction = target - rendered;
    if (!correction) break;
    guess += correction;
  }
  return new Date(guess).toISOString();
}

function formatSessionTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = dateTimePartsInZone(date);
  if (!parts) return "—";
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  return `${formatCalendarDate(iso)} · ${formatNumber(parts.hour)}:${formatNumber(parts.minute)}`;
}

function taskTitleForSession(session, detail) {
  const task = (detail.tasks || []).find((item) => Number(item.id) === Number(session.task_id));
  return task?.title || t("No linked task");
}

function renderHistorySessions(detail) {
  const holder = byId("historySessionList");
  const count = byId("historySessionCount");
  if (!holder) return;
  const sessions = detail.sessions || [];
  if (count) count.textContent = formatNumber(sessions.length);
  clear(holder);
  if (!sessions.length) {
    holder.appendChild(h("div", { class: "history-empty" }, t("No sessions recorded for this day.")));
    return;
  }
  sessions.forEach((session) => {
    const taskTitle = taskTitleForSession(session, detail);
    const kind = session.kind === "break" ? "Break session" : "Focus session";
    const row = h("article", { class: "history-record" }, [
      h("div", { class: "history-record-main" }, [
        h("strong", {}, t(kind)),
        h("span", { class: "task-title" }, taskTitle),
        h("span", { class: "history-record-meta" }, [
          h("span", {}, `${formatDurationForHistory(session.seconds)} ${session.completed ? `· ${t("Completed normally")}` : ""}`),
          h("span", {}, `${t("Planned")}: ${formatDurationForHistory(session.planned_seconds)}`),
          h("span", {}, `${t("Started at")}: ${formatSessionTimestamp(session.started_at)}`),
        ]),
      ]),
      h("div", { class: "history-record-actions" }, [
        h("button", { class: "btn btn-sm", type: "button", onclick: () => editHistorySession(session, detail) }, t("Edit")),
        h("button", { class: "btn btn-sm btn-danger", type: "button", onclick: () => deleteHistorySession(session) }, t("Delete")),
      ]),
    ]);
    holder.appendChild(row);
  });
}

function renderHistoryDay(detail) {
  const day = Number(detail.day_index) || activeHistoryDay;
  const log = detail.day_log || {};
  const label = dayLabel(day, currentDay());
  const title = byId("historyDayTitle");
  const subtitle = byId("historyDaySubtitle");
  if (title) title.textContent = label;
  if (subtitle) subtitle.textContent = `${t("Virtual day")} ${formatNumber(day)} · ${formatCalendarDate(isoForVirtualDay(day))}`;
  renderHistorySummary(detail);
  renderHistoryTasks(detail);
  renderHistorySessions(detail);
  const mood = byId("historyMood"), capacity = byId("historyCapacity"), note = byId("historyNote");
  if (mood && document.activeElement !== mood) mood.value = log.mood || "";
  if (capacity && document.activeElement !== capacity) capacity.value = String(log.capacity_minutes ?? detail.summary?.capacity_minutes ?? 0);
  if (note && document.activeElement !== note) note.value = log.note || "";
}

async function loadHistoryDay(dayIndex, open = true) {
  const day = Math.max(1, Number(dayIndex) || 1);
  activeHistoryDay = day;
  try {
    const detail = await api.dayDetail(day);
    historyDetail = detail;
    renderHistoryDay(detail);
    if (open) openSheet("historyDaySheet");
    return detail;
  } catch (error) {
    toast(error.message || t("Could not load this day"), { tone: "error" });
    return null;
  }
}

async function addHistoricalTask() {
  const tags = [{ value: "", label: t("None") }, ...(store.get("tags", []) || []).map((tag) => ({ value: tag.name, label: `#${tag.label || tag.name}` }))];
  const data = await formDialog({
    title: t("Add task"),
    eyebrow: `${t("Virtual day")} ${formatNumber(activeHistoryDay)} · ${formatCalendarDate(isoForVirtualDay(activeHistoryDay))}`,
    fields: [
      { name: "title", label: t("Title"), type: "text", required: true },
      { name: "duration", label: t("Duration"), type: "text", value: `${store.settingNum("default_duration", 30)}m`, placeholder: "25m / ۹۰ دقیقه" },
      { name: "tag", label: t("Tag"), type: "select", value: "", options: tags },
    ],
  });
  if (!data || !data.title?.trim()) return;
  const task = { title: data.title.trim(), day_index: activeHistoryDay };
  if (data.duration?.trim()) task.duration_text = data.duration.trim();
  if (data.tag) task.tag = data.tag;
  try {
    await api.createTask(task);
    await refreshApp();
    await loadHistoryDay(activeHistoryDay, false);
    toast(t("Task added to this day"), { tone: "good" });
  } catch (error) {
    toast(error.message || t("Could not add task"), { tone: "error" });
  }
}

function parseNonnegativeDuration(value) {
  const normalized = normalizeDigits(String(value ?? "")).trim();
  if (/^0(?:\\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|د|دقیقه|ث|ثانیه))?$/iu.test(normalized)) return 0;
  return parseDurationText(normalized, store.settingNum("pomodoro_focus", 25));
}

async function editHistorySession(session, detail) {
  const tasks = [{ value: "0", label: t("No linked task") }, ...(detail.tasks || []).map((task) => ({ value: String(task.id), label: task.title }))];
  const data = await formDialog({
    title: t("Edit session"),
    eyebrow: `${t(session.kind === "break" ? "Break session" : "Focus session")} · #${formatNumber(session.id)}`,
    fields: [
      { name: "kind", label: t("Session type"), type: "select", value: session.kind, options: [{ value: "focus", label: t("Focus session") }, { value: "break", label: t("Break session") }] },
      { name: "seconds", label: t("Actual duration"), type: "text", value: formatDurationForHistory(session.seconds), placeholder: "25m" },
      { name: "planned_seconds", label: t("Planned duration"), type: "text", value: session.planned_seconds ? formatDurationForHistory(session.planned_seconds) : "", placeholder: "25m" },
      { name: "completed", label: t("Completed normally"), type: "checkbox", value: session.completed },
      { name: "day_index", label: t("Move to virtual day"), type: "number", value: session.day_index, min: 1, max: 999999, step: 1 },
      { name: "task_id", label: t("Linked task"), type: "select", value: String(session.task_id || 0), options: tasks },
      { name: "started_at", label: t("Started at"), type: "datetime-local", value: localDateTime(session.started_at) },
      { name: "ended_at", label: t("Ended at"), type: "datetime-local", value: localDateTime(session.ended_at) },
    ],
  });
  if (!data) return;
  const seconds = parseNonnegativeDuration(data.seconds);
  const planned = data.planned_seconds.trim() ? parseNonnegativeDuration(data.planned_seconds) : 0;
  if (seconds === null || (data.planned_seconds.trim() && planned === null)) {
    toast(t("Enter a valid duration"), { tone: "warn" });
    return;
  }
  const patch = {
    kind: data.kind,
    seconds,
    planned_seconds: planned,
    completed: data.completed,
    day_index: Number(data.day_index) || session.day_index,
    task_id: Number(data.task_id) || 0,
    started_at: data.started_at ? localDateTimeToIso(data.started_at) : "",
    ended_at: data.ended_at ? localDateTimeToIso(data.ended_at) : "",
  };
  try {
    await api.updateSession(session.id, patch);
    await refreshApp();
    await loadHistoryDay(activeHistoryDay, false);
    toast(t("Session updated"), { tone: "good" });
  } catch (error) {
    toast(error.message || t("Could not update session"), { tone: "error" });
  }
}

async function deleteHistorySession(session) {
  const ok = await confirmAction({ title: t("Delete session"), text: t("This session will be removed from historical analytics."), okLabel: t("Delete"), danger: true });
  if (!ok) return;
  try {
    await api.deleteSession(session.id);
    await refreshApp();
    await loadHistoryDay(activeHistoryDay, false);
    toast(t("Session deleted"), { tone: "good" });
  } catch (error) {
    toast(error.message || t("Could not delete session"), { tone: "error" });
  }
}

export function initHistoryCalendar() {
  byId("calendarPickBtn")?.addEventListener("click", openCalendar);
  byId("calendarPrevMonth")?.addEventListener("click", () => moveCalendarMonth(-1));
  byId("calendarNextMonth")?.addEventListener("click", () => moveCalendarMonth(1));
  byId("calendarTodayBtn")?.addEventListener("click", () => goToDay(currentDay()));
  byId("calendarGoBtn")?.addEventListener("click", commitCalendarInput);
  byId("calendarDateInput")?.addEventListener("keydown", (event) => { if (event.key === "Enter") commitCalendarInput(); });
  byId("historicalDayList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-day]");
    if (button) loadHistoryDay(Number(button.dataset.historyDay));
  });
  byId("historyAddTaskBtn")?.addEventListener("click", addHistoricalTask);
  byId("historyDayForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      note: byId("historyNote")?.value || "",
      mood: byId("historyMood")?.value || "",
      capacity_minutes: Number(byId("historyCapacity")?.value || 0),
    };
    try {
      await api.logDay(activeHistoryDay, payload);
      await refreshApp();
      await loadHistoryDay(activeHistoryDay, false);
      toast(t("Day details saved"), { tone: "good" });
    } catch (error) {
      toast(error.message || t("Could not save the day details"), { tone: "error" });
    }
  });
  on("state", () => {
    if (byId("calendarSheet") && !byId("calendarSheet").hidden) renderCalendar();
    if (activeHistoryDay && byId("historyDaySheet") && !byId("historyDaySheet").hidden) {
      loadHistoryDay(activeHistoryDay, false);
    }
  });
  document.addEventListener("taskarcade:locale", () => {
    visibleMonth = null;
    if (byId("calendarSheet") && !byId("calendarSheet").hidden) renderCalendar();
    if (activeHistoryDay && historyDetail && byId("historyDaySheet") && !byId("historyDaySheet").hidden) renderHistoryDay(historyDetail);
  });
  window.TaskArcadeHistory = {
    openDay: loadHistoryDay,
    openCalendar,
    goToDay,
    renderCalendar,
  };
}

export function provideHistoryRefresh(fn) {
  refreshApp = typeof fn === "function" ? fn : async () => {};
}

export function openHistoryDay(dayIndex) {
  return loadHistoryDay(dayIndex);
}

export function renderHistoricalDayList(series = null) {
  const holder = byId("historicalDayList");
  if (!holder) return;
  const days = (series || store.meta?.stats?.days || []).slice().reverse();
  const count = byId("historyDayCount");
  if (count) count.textContent = formatNumber(days.length);
  clear(holder);
  if (!days.length) {
    holder.appendChild(h("div", { class: "history-empty" }, t("No historical days yet.")));
    return;
  }
  days.slice(0, 60).forEach((day) => {
    const index = Number(day.day_index);
    const iso = isoForVirtualDay(index);
    const button = h("button", {
      class: `historical-day-row${index === currentDay() ? " is-current" : ""}`,
      type: "button",
      dataset: { historyDay: String(index) },
      title: `${t("Open historical day")} · ${formatCalendarDate(iso)}`,
    }, [
      h("span", { class: "historical-day-date" }, [
        h("strong", {}, formatCalendarDate(iso)),
        h("small", {}, `${t("Virtual day")} ${formatNumber(index)} · ${dayLabel(index, currentDay())}`),
      ]),
      h("span", { class: "historical-day-metrics-inline" }, [
        h("span", {}, `${formatNumber(day.done || 0)}/${formatNumber(day.tasks || 0)} ${t("Tasks")}`),
        h("span", {}, formatDurationForHistory(day.focus_seconds)),
        h("span", { class: "history-row-progress" }, `${formatNumber(Math.round(day.completion || 0))}٪`),
      ]),
      icon("arrow-right"),
    ]);
    holder.appendChild(button);
  });
}
