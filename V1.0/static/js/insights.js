/* ==========================================================================
   TaskArcade — insights
   All charts are hand-rolled with DOM + CSS: no chart library, no canvas, so
   they inherit theme colours, densities and reduced-motion rules for free.
   ========================================================================== */

import {
  byId, h, icon, clear, store, on, emit, fmtDuration, fmtShort, fmtMinutes, fmtPercent,
  dayLabel, dayShortLabel, calendarDayLabel, calendarDateForDay, relativeTime, MOOD_GLYPHS, clamp, formatNumber,
} from "./core.js";
import { openHistoryDay, renderHistoricalDayList } from "./history-calendar.js";
import { api } from "./api.js";
import { toast, formDialog } from "./ui.js";

/* --------------------------------------------------------------------------
   Stat cards
   -------------------------------------------------------------------------- */
export function renderInsightCards() {
  const holder = byId("insightCards");
  if (!holder) return;
  const stats = store.meta?.stats || {};
  if (!stats.total_tasks && !stats.sessions && !stats.focus_seconds) {
    clear(holder);
    holder.appendChild(
      h("div", { class: "panel" }, [
        h("h3", {}, "No data yet"),
        h("p", { class: "panel-note" }, "Finish a couple of tasks and the analytics will start to fill in."),
      ]),
    );
    return;
  }

  const comparison = stats.comparison || {};
  const changed = (key, render = (value) => formatNumber(Math.round(value))) => {
    const item = comparison[key];
    if (!item) return "";
    const prefix = item.change > 0 ? "+" : "";
    const percent = `${prefix}${formatNumber(item.change_percent ?? 0)}%`;
    return `${t("Compared with previous period")}: ${percent} · ${render(item.previous ?? 0)} → ${render(item.current ?? 0)}`;
  };
  const rangeCount = Number(stats.range?.count || stats.period_days || 0);
  const averageFocus = Number(stats.avg_focus_seconds_per_day || stats.focus_seconds / Math.max(1, rangeCount));
  const cards = [
    {
      label: "Focused time",
      value: fmtDuration(stats.focus_seconds || 0),
      foot: changed("focus_seconds", fmtDuration) || `${fmtDuration(averageFocus)} ${t("per day")}`,
    },
    {
      label: "Completion rate",
      value: fmtPercent(stats.completion || 0),
      foot: changed("done_tasks", (value) => `${formatNumber(value)} ${t("Tasks")}`) || `${formatNumber(stats.done_tasks || 0)} / ${formatNumber(stats.total_tasks || 0)} ${t("Tasks")}`,
    },
    {
      label: "Estimate accuracy",
      value: stats.estimate_sample ? fmtPercent(stats.estimate_accuracy || 0) : "—",
      foot: stats.estimate_sample
        ? `${formatNumber(stats.estimate_sample)} ${t("Estimate sample")}`
        : t("No estimate data in this period"),
    },
    {
      label: "Focus goal days",
      value: `${formatNumber(stats.focus_goal_days || 0)} / ${formatNumber(rangeCount)}`,
      foot: `${formatNumber(stats.daily_goal_minutes || 0)} ${t("minutes")} ${t("Focus goal").toLowerCase()}`,
    },
    {
      label: "Average focus per day",
      value: fmtDuration(averageFocus),
      foot: `${formatNumber(rangeCount)} ${t("days")} · ${fmtDuration(stats.task_focus_seconds || 0)} ${t("Task estimate")}`,
    },
    {
      label: "Sessions completed",
      value: `${formatNumber(stats.sessions_completed || 0)} / ${formatNumber(stats.sessions || 0)}`,
      foot: `${fmtPercent(stats.session_completion || 0)} ${t("Focus sessions").toLowerCase()}`,
    },
    {
      label: "Planned vs remaining",
      value: fmtDuration(stats.planned_seconds || 0),
      foot: `${fmtDuration(stats.remaining_seconds || 0)} ${t("remaining")} · ${fmtDuration(stats.elapsed_seconds || 0)} ${t("Elapsed time").toLowerCase()}`,
    },
    {
      label: "Current streak",
      value: `${formatNumber(stats.streaks?.current ?? 0)} ${t("days")}`,
      foot: `${t("best streak")} ${formatNumber(stats.streaks?.best ?? 0)} · ${formatNumber(stats.streaks?.perfect_days ?? 0)} ${t("perfect days")}`,
    },
  ];

  clear(holder);
  cards.forEach((card) => {
    holder.appendChild(
      h("article", { class: "stat-card" }, [
        h("span", { class: "stat-label" }, card.label),
        h("span", { class: "stat-value" }, card.value),
        h("span", { class: "stat-foot" }, card.foot),
      ]),
    );
  });
}

function t(value) {
  return window.TaskArcadeI18n?.t?.(value) ?? value;
}

function renderAnalyticsSummary() {
  const holder = byId("analyticsSummary");
  if (!holder) return;
  clear(holder);
  const stats = store.meta?.stats || {};
  const range = stats.range || {};
  const compare = stats.comparison || {};
  const count = Number(range.count || stats.period_days || 0);
  const values = [
    { label: "Reporting period", value: `${formatNumber(count)} ${t("days")}`, note: `${t("Virtual day")} ${formatNumber(range.start_day || 1)}–${formatNumber(range.end_day || currentDayIndex())}` },
    { label: "Estimate accuracy", value: stats.estimate_sample ? fmtPercent(stats.estimate_accuracy || 0) : "—", note: `${formatNumber(stats.estimate_sample || 0)} ${t("Estimate sample")}` },
    { label: "Focus goal days", value: `${formatNumber(stats.focus_goal_days || 0)} / ${formatNumber(count)}`, note: `${formatNumber(stats.daily_goal_minutes || 0)} ${t("minutes")} ${t("Focus goal").toLowerCase()}` },
    { label: "Actual focus", value: fmtDuration(stats.focus_seconds || 0), note: compare.focus_seconds ? `${t("Previous period")}: ${fmtDuration(compare.focus_seconds.previous || 0)}` : t("The comparison period has no records yet.") },
    { label: "Completed tasks", value: `${formatNumber(stats.done_tasks || 0)} / ${formatNumber(stats.total_tasks || 0)}`, note: compare.done_tasks ? `${t("Previous period")}: ${formatNumber(compare.done_tasks.previous || 0)}` : t("The comparison period has no records yet.") },
  ];
  values.forEach((item) => holder.appendChild(h("article", { class: "analytics-summary-card" }, [
    h("span", { class: "stat-label" }, item.label),
    h("strong", {}, item.value),
    h("small", {}, item.note),
  ])));
}

function currentDayIndex() {
  return store.settingNum("current_day_index", 1);
}

/* --------------------------------------------------------------------------
   Heatmap of virtual days
   -------------------------------------------------------------------------- */
export function renderHeatmap() {
  const holder = byId("heatmap");
  if (!holder) return;
  const heatmap = store.meta?.stats?.heatmap || [];
  clear(holder);

  const pill = byId("heatmapPill");
  if (pill) pill.textContent = `${formatNumber(heatmap.length)} ${t("days")}`;

  if (!heatmap.length) {
    holder.appendChild(h("span", { class: "form-hint" }, "No history yet."));
    return;
  }
  if (heatmap.length) {
    const first = heatmap[0];
    const iso = calendarDateForDay(first.day);
    if (iso) {
      const [year, month, day] = iso.split("-").map(Number);
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const weekStart = Number(store.setting("week_start", store.setting("language", "en") === "fa" ? 6 : 1));
      const blanks = (weekday - weekStart + 7) % 7;
      for (let index = 0; index < blanks; index += 1) holder.appendChild(h("i", { class: "heatmap-blank", "aria-hidden": "true" }));
    }
  }
  heatmap.forEach((entry) => {
    const cell = h("i", {
      role: "button",
      tabindex: "0",
      dataset: { level: String(entry.intensity), day: String(entry.day) },
      title: `${calendarDayLabel(entry.day)} · ${entry.done} ${t("Tasks")} · ${entry.planned_minutes}m ${t("Planned")} · ${entry.focus_minutes}m ${t("Focused time")}`,
      "aria-label": `${calendarDayLabel(entry.day)} · ${entry.done} ${t("Tasks")}`,
    });
    cell.addEventListener("click", () => openHistoryDay(entry.day));
    cell.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openHistoryDay(entry.day); } });
    holder.appendChild(cell);
  });
}

/* --------------------------------------------------------------------------
   Completed time per day (stacked bars)
   -------------------------------------------------------------------------- */
export function renderBarChart() {
  const holder = byId("barChart");
  if (!holder) return;
  const days = (store.meta?.stats?.days || []).slice(-30);
  clear(holder);

  const pill = byId("velocityPill");
  if (pill) {
    const velocity = store.meta?.stats?.velocity || {};
    pill.textContent = `≈ ${fmtMinutes(velocity.avg_done_minutes || 0)} ${t("per day")}`;
  }

  if (!days.length) {
    holder.appendChild(h("span", { class: "form-hint" }, "Nothing to plot yet."));
    return;
  }
  const peak = Math.max(...days.map((day) => day.planned_seconds || day.done_seconds || day.focus_seconds), 1);
  days.forEach((day) => {
    const doneHeight = (day.done_seconds / peak) * 100;
    const leftHeight = (day.remaining_seconds / peak) * 100;
    const iso = calendarDayLabel(day.day_index);
    const col = h("div", {
      class: "bar-col",
      role: "button",
      tabindex: "0",
      dataset: { day: String(day.day_index) },
      title: `${iso} · ${formatNumber(day.done || 0)}/${formatNumber(day.tasks || 0)} ${t("Tasks")} · ${fmtDuration(day.focus_seconds || 0)} ${t("Focused time")}`,
      "aria-label": `${iso} · ${formatNumber(day.done || 0)} ${t("Tasks")}`,
      onclick: () => openHistoryDay(day.day_index),
      onkeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openHistoryDay(day.day_index); } },
    }, [
      h("div", { class: "bar-stack" }, [
        h("span", {
          class: "bar-seg bar-seg-left",
          style: { height: `${Math.max(0, leftHeight)}%` },
          dataset: { tip: `${fmtShort(day.remaining_seconds)} ${t("left")}` },
        }),
        h("span", {
          class: "bar-seg bar-seg-done",
          style: { height: `${Math.max(0, doneHeight)}%` },
          dataset: { tip: `${fmtShort(day.done_seconds)} ${t("done")}` },
        }),
      ]),
      h("span", { class: "bar-label" }, compactCalendarLabel(day.day_index)),
    ]);
    holder.appendChild(col);
  });
}

function compactCalendarLabel(dayIndex) {
  const value = calendarDayLabel(dayIndex);
  const parts = value.split(/[\\/.-]/);
  return parts.length >= 3 ? `${parts.at(-2)}/${parts.at(-1)}` : value;
}

/* --------------------------------------------------------------------------
   Tag split
   -------------------------------------------------------------------------- */
export function renderTagSplit() {
  const holder = byId("tagSplit");
  if (!holder) return;
  const tags = (store.meta?.stats?.tags || []).filter((tag) => tag.planned_seconds > 0).slice(0, 8);
  clear(holder);
  if (!tags.length) {
    holder.appendChild(h("span", { class: "form-hint" }, "Tag some tasks and their weight will appear here."));
    return;
  }
  const total = tags.reduce((sum, tag) => sum + tag.planned_seconds, 0) || 1;

  holder.appendChild(
    h("div", { class: "tag-split-bar" },
      tags.map((tag) => h("span", {
        style: { width: `${(tag.planned_seconds / total) * 100}%`, background: tag.color },
        title: `#${tag.label}: ${fmtShort(tag.planned_seconds)} planned · ${fmtShort(tag.focus_seconds || 0)} focused`,
      })),
    ),
  );

  tags.forEach((tag) => {
    holder.appendChild(
      h("div", { class: "tag-split-row" }, [
        h("div", { class: "tag-split-head" }, [
          h("span", { class: "row" }, [
            h("i", { class: "tag-dot", style: { background: tag.color } }),
            h("span", { class: "user-content" }, `#${tag.label}`),
            h("small", { class: "form-hint" }, `${formatNumber(tag.tasks)} ${t("Tasks")} · ${fmtPercent(tag.planned_seconds / total * 100)} ${t("of planned time")}`),
          ]),
          h("span", { class: "tag-split-values" }, [
            h("strong", {}, fmtShort(tag.planned_seconds)),
            h("span", {}, `${fmtPercent(tag.completion)} ${t("complete")}`),
            h("small", {}, `${fmtShort(tag.focus_seconds || 0)} ${t("Focused time")}`),
          ]),
        ]),
        h("div", { class: "progress-track progress-track-slim" }, [
          h("div", { class: "progress-fill", style: { width: `${clamp(tag.completion, 0, 100)}%`, background: tag.color } }),
        ]),
      ]),
    );
  });
}

/* --------------------------------------------------------------------------
   When you focus (hour of day)
   -------------------------------------------------------------------------- */
export function renderHourChart() {
  const holder = byId("hourChart");
  if (!holder) return;
  const hours = store.meta?.stats?.hours || [];
  clear(holder);
  const peak = Math.max(...hours.map((hour) => hour.minutes), 1);
  hours.forEach((hour) => {
    holder.appendChild(
      h("i", {
        style: { height: `${Math.max(2, (hour.minutes / peak) * 100)}%` },
        title: `${formatNumber(hour.hour)}:00 — ${fmtMinutes(hour.minutes)} ${t("Focused time")}`,
      }),
    );
  });
  const oldAxis = holder.parentElement?.querySelector(".hour-axis");
  oldAxis?.remove();
  const axis = h("div", { class: "hour-axis" }, ["00", "06", "12", "18", "23"].map((label) => h("span", {}, formatNumber(label))));
  holder.parentElement?.appendChild(axis);
}

export function renderWeekdayChart() {
  const holder = byId("weekdayChart");
  if (!holder) return;
  const source = store.meta?.stats?.weekday_focus || [];
  const byWeekday = new Map(source.map((item) => [Number(item.weekday), Number(item.seconds || 0)]));
  const persian = store.setting("language", "en") === "fa";
  const order = persian ? [5, 6, 0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6];
  const labels = persian
    ? ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const data = order.map((weekday, index) => ({ weekday, label: labels[index], seconds: byWeekday.get(weekday) || 0 }));
  const peak = Math.max(...data.map((item) => item.seconds), 1);
  clear(holder);
  data.forEach((item) => holder.appendChild(h("div", { class: "weekday-col", title: `${t(item.label)} · ${fmtDuration(item.seconds)}` }, [
    h("span", { class: "weekday-bar-track" }, [h("i", { style: { height: `${Math.max(2, item.seconds / peak * 100)}%` } })]),
    h("small", {}, t(item.label).slice(0, 2)),
  ])));
}

/* --------------------------------------------------------------------------
   Streaks & level
   -------------------------------------------------------------------------- */
export function renderStreaks() {
  const holder = byId("streakGrid");
  if (!holder) return;
  const streaks = store.meta?.stats?.streaks || { current: 0, best: 0, perfect_days: 0, active_days: 0 };
  clear(holder);
  const cells = [
    { value: formatNumber(streaks.current ?? 0), label: "current streak" },
    { value: formatNumber(streaks.best ?? 0), label: "best streak" },
    { value: formatNumber(streaks.perfect_days ?? 0), label: "perfect days" },
    { value: formatNumber(streaks.active_days ?? 0), label: "active days" },
  ];
  cells.forEach((cell) => {
    holder.appendChild(
      h("div", { class: "streak-cell" }, [h("strong", {}, cell.value), h("span", {}, cell.label)]),
    );
  });
}

export function renderLevel() {
  const holder = byId("levelCard");
  if (!holder) return;
  const level = store.meta?.stats?.level || { level: 1, title: "Wanderer", xp: 0, into_level: 0, next_level: 200, progress: 0 };
  clear(holder);

  const pill = byId("levelPill");
  if (pill) pill.textContent = `${formatNumber(level.xp)} ${t("xp")}`;

  const badge = h("div", { class: "level-badge", style: { "--level-pct": String(clamp(level.progress, 0, 100)) } }, [
    h("span", {}, formatNumber(level.level)),
  ]);

  holder.append(
    h("div", { class: "level-head" }, [
      badge,
      h("div", {}, [
        h("div", { class: "level-title" }, t(level.title)),
        h("div", { class: "level-xp" }, `${formatNumber(level.into_level)} / ${formatNumber(level.next_level)} ${t("xp to the next level")}`),
      ]),
    ]),
    h("div", { class: "progress-track" }, [h("div", { class: "progress-fill", style: { width: `${clamp(level.progress, 0, 100)}%` } })]),
    h("p", { class: "panel-note" }, t("Earn xp for finishing tasks and for every two minutes spent in a focus session.")),
    h("div", { class: "row" }, [
      h("button", {
        class: "btn btn-sm btn-quiet",
        type: "button",
        onclick: () => emit("switch-tab", { tab: "focus" }),
      }, [icon("play"), "Focus more"]),
      h("button", {
        class: "link-btn",
        type: "button",
        onclick: () => toast(`${t("Level")} ${formatNumber(level.level)} · ${t(level.title)} · ${formatNumber(level.xp)} ${t("xp")}`, { tone: "info" }),
      }, "How does this work?"),
    ]),
  );
}

/* --------------------------------------------------------------------------
   Day journal
   -------------------------------------------------------------------------- */
export function renderJournal() {
  const holder = byId("journalList");
  const mood = byId("journalMood");
  const note = byId("journalNote");
  if (!holder) return;
  const logs = store.get("day_logs", []) || [];
  const current = store.settingNum("current_day_index", 1);
  const todayLog = logs.find((log) => log.day_index === current);
  if (todayLog && mood && note && document.activeElement !== mood && document.activeElement !== note) {
    mood.value = todayLog.mood || "";
    note.value = todayLog.note || "";
  }

  clear(holder);
  if (!logs.length) {
    holder.appendChild(h("li", { class: "form-hint" }, "No day notes yet. Finish a day or write a line above."));
    return;
  }
  logs.slice(0, 12).forEach((log) => {
    holder.appendChild(
      h("li", { class: "journal-item" }, [
        h("span", { class: "row" }, [
          h("strong", {}, `${log.mood ? MOOD_GLYPHS[log.mood] || "" : ""} ${dayLabel(log.day_index, current)}`),
          h("small", {}, log.finished_at ? relativeTime(log.finished_at) : ""),
        ]),
        log.note ? h("span", { class: "user-content" }, log.note) : null,
        h("small", {}, [
          `${formatNumber(log.completed)} ${t("done")} · ${fmtShort(log.focus_seconds)} ${t("Focused time")}`,
          log.carried ? ` · ${formatNumber(log.carried)} ${t("carried over")}` : "",
        ]),
      ]),
    );
  });
}

/* --------------------------------------------------------------------------
   Activity feed
   -------------------------------------------------------------------------- */
const ACTIVITY_LABELS = {
  "task.create": "created",
  "task.done": "completed",
  "task.undone": "reopened",
  "task.skip": "deferred",
  "task.delete": "deleted",
  "task.update": "edited",
  "task.move": "moved",
  "task.reorder": "reordered",
  "task.split": "split",
  "task.duplicate": "duplicated",
  "day.finish": "finished a day",
  "day.reopen": "reopened a day",
  "focus.start": "started focus",
  "focus.complete": "focus completed",
  "focus.abandon": "focus stopped early",
  "break.start": "started a break",
  "break.complete": "break finished",
  "subtask.add": "added a step",
  "subtask.toggle": "ticked a step",
  "settings.update": "changed settings",
  "tag.add": "created a tag",
  "alias.add": "added an alias",
  "template.apply": "applied a template",
  "recurrence.materialize": "materialised repeats",
  "backup.import": "imported data",
  undo: "undid a change",
  redo: "redid a change",
  cleanup: "cleaned up",
};

export function renderActivity() {
  const holder = byId("activityList");
  if (!holder) return;
  const events = store.get("events", []) || [];
  clear(holder);
  if (!events.length) {
    holder.appendChild(h("li", { class: "form-hint" }, "No activity recorded yet."));
    return;
  }
  events.slice(0, 40).forEach((event) => {
    holder.appendChild(
      h("li", { class: "activity-item" }, [
        h("span", { class: "activity-kind" }, t(ACTIVITY_LABELS[event.kind] || event.kind)),
        h("span", { class: "activity-title" }, [
          t(ACTIVITY_LABELS[event.kind] || event.kind),
          event.title ? " — " : "",
          event.title ? h("span", { class: "user-content" }, event.title) : null,
          event.seconds ? ` (${fmtShort(event.seconds)})` : "",
        ]),
        h("span", { class: "activity-at" }, relativeTime(event.at)),
      ]),
    );
  });
}

/* --------------------------------------------------------------------------
   Up next list (Now view) and ranked queue
   -------------------------------------------------------------------------- */
export function renderUpNext() {
  const holder = byId("upNextList");
  if (!holder) return;
  const current = store.settingNum("current_day_index", 1);
  const tasks = (store.get("tasks", []) || [])
    .filter((task) => task.day_index === current && !task.done)
    .sort((a, b) => (b.focus_score || 0) - (a.focus_score || 0) || a.order_index - b.order_index)
    .slice(0, 6);

  clear(holder);
  if (!tasks.length) {
    holder.appendChild(h("li", { class: "form-hint" }, "Nothing queued. Add a task and it will appear here."));
    return;
  }
  tasks.forEach((task, index) => {
    const item = h("li", {}, [
      h("button", {
        class: `upnext-item${index === 0 ? " is-current" : ""}`,
        type: "button",
        onclick: () => emit("focus-task", { taskId: task.id }),
      }, [
        h("span", { class: "upnext-rank" }, String(index + 1)),
        h("span", { class: "upnext-title" }, task.title),
        h("span", { class: "upnext-meta" }, fmtShort(task.remaining_seconds)),
      ]),
    ]);
    holder.appendChild(item);
  });
}

/* --------------------------------------------------------------------------
   Load / refresh
   -------------------------------------------------------------------------- */
export async function refreshInsights({ silent = false, days = null } = {}) {
  try {
    const selectedDays = Number(days ?? byId("insightRangeSelect")?.value ?? 30);
    const data = await api.stats([0, 7, 30, 90, 365].includes(selectedDays) ? selectedDays : 30);
    if (data && typeof data === "object") {
      store.meta = store.meta || {};
      store.meta.stats = { ...data.overview, ...data, overview: data.overview, trend: data.trend };
      store.meta.stats.streaks = data.streaks;
      store.meta.stats.level = data.level;
      store.meta.stats.velocity = data.velocity;
      store.meta.stats.hours = data.hours;
      store.meta.stats.heatmap = data.heatmap;
      store.meta.stats.days = data.days;
      store.meta.stats.tags = data.tags;
      renderAllInsights();
    }
  } catch (error) {
    if (!silent) toast("Could not load insights", { tone: "warn" });
  }
}

export function renderAllInsights() {
  renderInsightCards();
  renderHeatmap();
  renderBarChart();
  renderTagSplit();
  renderHourChart();
  renderStreaks();
  renderLevel();
  renderJournal();
  renderActivity();
  renderAnalyticsSummary();
  renderWeekdayChart();
  renderHistoricalDayList(store.meta?.stats?.days || []);
}

/* --------------------------------------------------------------------------
   Wiring
   -------------------------------------------------------------------------- */
export function initInsights() {
  const rangeSelect = byId("insightRangeSelect");
  const savedRange = Number(localStorage.getItem("taskarcade.insight-range") || 30);
  if (rangeSelect && [0, 7, 30, 90, 365].includes(savedRange)) rangeSelect.value = String(savedRange);
  rangeSelect?.addEventListener("change", () => {
    localStorage.setItem("taskarcade.insight-range", String(rangeSelect.value));
    refreshInsights({ days: Number(rangeSelect.value) });
  });

  byId("journalForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mood = byId("journalMood")?.value || "";
    const note = byId("journalNote")?.value || "";
    try {
      await api.logDay(store.settingNum("current_day_index", 1), { mood, note });
      toast("Journal saved", { tone: "good" });
      const data = await api.state();
      store.set(data);
    } catch (error) {
      toast(error.message || "Could not save the note", { tone: "error" });
    }
  });

  on("state", () => {
    renderUpNext();
    renderAllInsights();
  });
  document.addEventListener("taskarcade:locale", () => renderAllInsights());
}

/* --------------------------------------------------------------------------
   Export helpers used by the library view
   -------------------------------------------------------------------------- */
export function statsCsv() {
  const days = store.meta?.stats?.days || [];
  return days.map((day) => ({
    day: day.day_index,
    tasks: day.tasks,
    done: day.done,
    planned_minutes: Math.round(day.planned_seconds / 60),
    completed_minutes: Math.round(day.done_seconds / 60),
    focus_minutes: Math.round(day.focus_seconds / 60),
  }));
}

export function insightSummaryText() {
  const stats = store.meta?.stats || {};
  return [
    `Focus time: ${fmtDuration(stats.focus_seconds || 0)}`,
    `Completion: ${fmtPercent(stats.completion || 0)}`,
    `Open tasks: ${stats.open_tasks || 0}`,
    `Streak: ${stats.streaks?.current || 0} days`,
  ].join(" · ");
}
