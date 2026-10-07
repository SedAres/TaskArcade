/* ==========================================================================
   TaskArcade — task rendering & actions
   Renders the Now list and the five timeline layouts, owns the task editor
   sheet, and exposes every task mutation the rest of the app triggers.
   ========================================================================== */

import {
  $, $$, byId, h, icon, clear, store, emit, on, prefs,
  sortTasks, groupTasks, tasksForDay, openTasksForDay, activeTask, totalsForDay,
  dayLabel, dayShortLabel, calendarDayLabel, fmtDuration, fmtShort, fmtPercent, fmtClock, formatNumber, parseDurationText,
  PRIORITY_LABELS, PRIORITY_GLYPHS, clamp,
} from "./core.js";
import { api } from "./api.js";
import { openSheet, closeSheet, confirmAction, actionSheet, formDialog, toast, celebrate } from "./ui.js";
import { attachSwipe, attachLongPress } from "./gestures.js";
import { initDragAndDrop } from "./dnd.js";
import { normalizeDigits } from "./calendar-utils.js";

const t = (value) => window.TaskArcadeI18n?.t?.(value) ?? value;

let editingTaskId = null;
let pendingSubtasks = [];
let activeDragDay = null;

/* --------------------------------------------------------------------------
   Small building blocks
   -------------------------------------------------------------------------- */
export function tagChip(name) {
  if (!name) return null;
  const tag = store.tag(name);
  const color = tag?.color || "#8D99AE";
  return h("span", {
    class: "tag-pill",
    style: { "--tag-color": color, "--tag-soft": `${color}24` },
  }, [
    tag?.icon ? icon(tag.icon) : null,
    `#${tag?.label || name}`,
  ]);
}

function projectChip(projectId) {
  const project = (store.get("projects", []) || []).find((item) => Number(item.id) === Number(projectId));
  if (!project) return null;
  return h("span", {
    class: "task-project-pill",
    style: { "--project-color": project.color || "var(--accent)" },
    title: `${t("Project")}: ${project.name}`,
  }, [icon("briefcase"), h("span", { class: "task-project-name" }, project.name)]);
}

export function priorityMark(priority) {
  if (!priority) return null;
  return h("span", {
    class: "priority-mark",
    dataset: { priority: String(priority) },
    title: `${PRIORITY_LABELS[priority] || ""} priority`,
  }, PRIORITY_GLYPHS[priority] || "!");
}

export function subtaskDots(task) {
  if (!task.subtasks?.length) return null;
  return h("span", { class: "task-sub-dots", title: `${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length} steps` },
    task.subtasks.map((sub) => h("i", { class: sub.done ? "is-done" : "" })),
  );
}

function scheduleChip(task) {
  if (!task.scheduled_at) return null;
  let value = task.scheduled_at;
  if (task.scheduled_at.includes("T")) {
    const timeZone = String(store.setting("timezone", "") || "").trim();
    const locale = store.setting("language", "en") === "fa" ? "fa-IR-u-nu-latn" : undefined;
    try {
      value = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(task.scheduled_at));
    } catch {
      value = new Date(task.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (store.setting("language", "en") === "fa" && store.setting("digit_style", "auto") !== "latin") value = value.replace(/\\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
  }
  return h("span", { class: "meta-schedule" }, [icon("clock"), value]);
}

/* --------------------------------------------------------------------------
   Now view — the primary task list
   -------------------------------------------------------------------------- */
export function renderTaskList() {
  const container = byId("taskList");
  if (!container) return;
  const current = store.settingNum("current_day_index", 1);
  const showDone = prefs.get("toggleDone", store.setting("show_done", 1) === 1);
  const sortMode = prefs.get("sortMode", store.setting("sort_mode", "manual"));
  const dayTasks = sortTasks(tasksForDay(current), sortMode);
  const visible = showDone ? dayTasks : dayTasks.filter((task) => !task.done);
  const currentTask = activeTask(current);

  clear(container);
  const empty = byId("emptyState");
  if (empty) empty.hidden = visible.length > 0;

  const title = byId("taskListTitle");
  if (title) {
    title.textContent = `${dayLabel(current, current)} · ${formatNumber(dayTasks.filter((t) => !t.done).length)} ${t("open")}`;
  }
  const sortLabel = byId("sortLabel");
  if (sortLabel) sortLabel.textContent = t(sortMode);
  const toggleLabel = byId("toggleDoneLabel");
  if (toggleLabel) toggleLabel.textContent = t(showDone ? "hide done" : "show done");

  visible.forEach((task) => container.appendChild(buildTaskRow(task, currentTask)));

  if (container.dataset.dndBound !== "true") {
    initDragAndDrop(container, { selector: ".task-row", onDrop: handleRowDrop, getDay: () => current });
    container.dataset.dndBound = "true";
  }
}

function buildTaskRow(task, currentTask) {
  const isActive = currentTask && currentTask.id === task.id;
  const overdue = !task.done && task.skipped_count >= 3;
  const row = h("div", {
    class: [
      "task-row",
      task.done ? "is-done" : "",
      isActive ? "is-active" : "",
      task.pinned ? "is-pinned" : "",
      overdue ? "is-overdue" : "",
    ].filter(Boolean).join(" "),
    dataset: { id: String(task.id), day: String(task.day_index) },
    style: { "--tag-color": store.tagColor(task.tag) },
  });

  const check = h("button", {
    class: "task-check",
    type: "button",
    title: task.done ? "Reopen task" : "Mark done",
    "aria-label": `${t(task.done ? "Reopen" : "Complete")} ${task.title}`,
    onclick: (event) => {
      event.stopPropagation();
      toggleDone(task);
    },
  }, icon("check"));

  const drag = h("button", { class: "task-drag", type: "button", title: t("Drag to reorder"), "aria-label": t("Drag to reorder task"), "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown" }, icon("drag"));

  const meta = h("div", { class: "task-meta" }, [
    projectChip(task.project_id),
    tagChip(task.tag),
    priorityMark(task.priority),
    h("span", { class: "task-duration" }, fmtDuration(task.done ? 0 : task.remaining_seconds)),
    task.done ? h("span", {}, "done") : h("span", {}, `of ${fmtDuration(task.total_seconds)}`),
    scheduleChip(task),
    task.tomatoes_estimate ? h("span", {}, `~${task.tomatoes_estimate}🍅`) : null,
    subtaskDots(task),
    task.skipped_count ? h("span", {}, `deferred ×${task.skipped_count}`) : null,
    task.recurrence_id ? h("span", { class: "meta-repeat" }, [icon("repeat"), "repeats"]) : null,
    task.focus_seconds ? h("span", {}, [icon("target"), ` ${fmtDuration(task.focus_seconds)}`]) : null,
  ]);

  const main = h("div", { class: "task-main" }, [
    h("span", { class: "task-title" }, task.title),
    store.setting("compact_meta", 0) === 1 ? null : meta,
    store.setting("show_notes_inline", 0) === 1 && task.notes
      ? h("span", { class: "task-notes-inline" }, task.notes)
      : null,
    task.subtasks?.length
      ? h("div", { class: "task-sub-progress" }, [
          h("div", { class: "progress-track" }, [
            h("div", {
              class: "progress-fill",
              style: { width: `${(task.subtasks.filter((s) => s.done).length / task.subtasks.length) * 100}%` },
            }),
          ]),
          h("span", {}, `${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}`),
        ])
      : null,
  ]);

  const side = h("div", { class: "task-side" }, [
    h("button", {
      class: "icon-btn icon-btn-sm",
      type: "button",
      title: "Edit task",
      onclick: (event) => {
        event.stopPropagation();
        openTaskSheet(task.id);
      },
    }, icon("pen")),
    h("button", {
      class: "icon-btn icon-btn-sm",
      type: "button",
      title: "More actions",
      onclick: (event) => {
        event.stopPropagation();
        taskActions(task);
      },
    }, icon("more")),
  ]);

  row.append(check, drag, main, side);

  // Touch gestures
  attachSwipe(row, {
    onRight: () => toggleDone(task, true),
    onLeft: () => skipTask(task),
  });
  attachLongPress(row, () => taskActions(task));

  row.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input")) return;
    openTaskSheet(task.id);
  });

  return row;
}

/* --------------------------------------------------------------------------
   Timeline renderers
   -------------------------------------------------------------------------- */
export function renderTimeline() {
  const inner = byId("timelineInner");
  if (!inner) return;
  const layout = document.documentElement.dataset.layout || "agenda";
  const days = store.get("viewDays") || viewDaysFromSettings();
  const current = store.settingNum("current_day_index", 1);
  const sortMode = store.setting("sort_mode", "manual");
  clear(inner);

  const layoutPill = byId("layoutPill");
  if (layoutPill) layoutPill.textContent = `${t("layout:")} ${t(layout)}`;

  const groupMode = store.setting("group_mode", "day");

  if (layout === "calendar") {
    inner.appendChild(buildCalendarLayout(current, sortMode));
  } else if (layout === "flow") {
    inner.appendChild(buildFlowLayout(days, current, sortMode));
  } else if (layout === "focus") {
    inner.appendChild(buildFocusLayout(current, sortMode));
  } else if (groupMode === "none") {
    inner.appendChild(buildFlatTimeline(layout, current, sortMode));
  } else if (groupMode === "tag" || groupMode === "priority") {
    inner.appendChild(buildGroupedTimeline(groupMode, current, sortMode));
  } else {
    days.forEach((day) => inner.appendChild(buildDayColumn(day, current, layout, sortMode)));
  }

  if (layout === "flow") {
    initDragAndDrop(inner, { selector: ".flow-item", onDrop: handleFlowDrop });
  } else {
    initDragAndDrop(inner, { selector: ".task-card-block", onDrop: handleTimelineDrop });
  }
}

function buildCalendarLayout(current, sortMode) {
  const grid = h("div", { class: "layout-calendar-grid", role: "list", "aria-label": t("Seven-day task map") });
  for (let offset = 0; offset < 7; offset += 1) {
    const dayIndex = current + offset;
    const tasks = sortTasks(tasksForDay(dayIndex), sortMode);
    const open = tasks.filter((task) => !task.done);
    const totals = totalsForDay(dayIndex);
    const cell = h("section", {
      class: `week-day-card${dayIndex === current ? " is-current" : ""}`,
      dataset: { day: String(dayIndex) },
      role: "listitem",
    }, [
      h("header", { class: "week-day-card-head" }, [
        h("button", {
          class: "week-day-heading",
          type: "button",
          onclick: () => emit("select-day", { day: dayIndex }),
          title: t("Open this day"),
        }, [
          h("span", { class: "week-day-label" }, dayLabel(dayIndex, current)),
          h("small", {}, calendarDayLabel(dayIndex)),
        ]),
        h("span", { class: "week-day-count" }, `${open.length} ${t("open")}`),
      ]),
      h("div", { class: "week-day-progress", "aria-label": `${totals.done} ${t("completed")}` }, [
        h("span", { style: { width: `${totals.planned ? clamp((totals.completedSeconds / totals.planned) * 100, 0, 100) : 0}%` } }),
      ]),
    ]);
    const list = h("div", { class: "week-day-tasks" });
    if (!tasks.length) {
      list.appendChild(h("p", { class: "week-day-empty" }, t("No tasks planned")));
    } else {
      tasks.slice(0, 5).forEach((task) => {
        list.appendChild(h("button", {
          class: `week-task${task.done ? " is-done" : ""}`,
          type: "button",
          onclick: () => openTaskSheet(task.id),
          title: task.title,
        }, [
          h("span", { class: "week-task-state", "aria-hidden": "true" }, task.done ? "✓" : "•"),
          h("span", { class: "week-task-title" }, task.title),
          h("small", {}, fmtShort(task.remaining_seconds)),
        ]));
      });
      if (tasks.length > 5) list.appendChild(h("small", { class: "week-day-more" }, `+${tasks.length - 5} ${t("more")}`));
    }
    cell.appendChild(list);
    grid.appendChild(cell);
  }
  return h("section", { class: "calendar-layout" }, [
    h("header", { class: "calendar-layout-head" }, [
      h("div", {}, [h("span", { class: "eyebrow" }, t("Week map")), h("h3", {}, t("The next seven days"))]),
      h("span", { class: "pill" }, t("Tap a day to open it")),
    ]),
    grid,
  ]);
}

function buildFlowLayout(days, current, sortMode) {
  const wrapper = h("section", { class: "flow-layout" }, [
    h("header", { class: "flow-layout-head" }, [
      h("div", {}, [h("span", { class: "eyebrow" }, t("One step at a time")), h("h3", {}, t("Your task flow"))]),
      h("span", { class: "pill" }, `${days.length} ${t(days.length === 1 ? "day" : "days")}`),
    ]),
  ]);
  const dayGroups = days.map((dayIndex) => ({
    dayIndex,
    tasks: sortForLayout(tasksForDay(dayIndex), sortMode, "flow"),
  }));
  if (!dayGroups.some((group) => group.tasks.length)) {
    wrapper.appendChild(h("div", { class: "day-empty" }, [
      h("p", {}, t("There are no tasks in this view yet.")),
      h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => emit("focus-quick-add", { day: current }) }, t("Add a task")),
    ]));
    return wrapper;
  }

  let flowIndex = 0;
  for (const { dayIndex, tasks } of dayGroups) {
    wrapper.appendChild(h("div", { class: "flow-day-heading", dataset: { day: String(dayIndex) } }, [
      h("span", { class: "flow-day-line" }),
      h("strong", {}, dayLabel(dayIndex, current)),
      h("small", {}, calendarDayLabel(dayIndex)),
    ]));
    const lane = h("div", { class: "flow-day-items day-tasks", dataset: { day: String(dayIndex), dndContainer: "1" } });
    tasks.forEach((task) => {
      flowIndex += 1;
      const marker = h("span", { class: `flow-marker${task.done ? " is-done" : ""}` }, task.done ? "✓" : String(flowIndex).padStart(2, "0"));
      lane.appendChild(h("div", { class: `flow-item${task.done ? " is-done" : ""}` }, [
        marker,
        buildTaskCard(task, { current, layout: "flow", showDay: false }),
      ]));
    });
    if (!tasks.length) lane.appendChild(h("p", { class: "flow-day-empty" }, t("No tasks planned")));
    wrapper.appendChild(lane);
  }
  return wrapper;
}

function buildFocusLayout(current, sortMode) {
  const open = sortTasks(tasksForDay(current), sortMode).filter((task) => !task.done);
  const primary = activeTask(current);
  const panel = h("section", { class: "focus-layout" });
  const hero = h("article", { class: "focus-primary-card" });
  if (primary) {
    const elapsed = Number(primary.elapsed_seconds ?? Math.max(0, primary.total_seconds - primary.remaining_seconds));
    const progress = primary.total_seconds ? clamp((elapsed / primary.total_seconds) * 100, 0, 100) : 0;
    hero.append(
      h("div", { class: "focus-primary-top" }, [
        h("div", {}, [h("span", { class: "eyebrow" }, t("Your next focus")), h("h2", {}, primary.title)]),
        h("span", { class: "focus-primary-time" }, fmtDuration(primary.remaining_seconds)),
      ]),
      h("div", { class: "focus-primary-meta" }, [tagChip(primary.tag), scheduleChip(primary), h("span", {}, dayLabel(current, current))]),
      h("div", { class: "focus-primary-progress", "aria-label": `${Math.round(progress)}% ${t("complete")}` }, [
        h("span", { style: { width: `${progress}%` } }),
      ]),
      h("div", { class: "focus-primary-actions" }, [
        h("button", { class: "btn btn-primary", type: "button", onclick: () => emit("task-command", { action: "focus", taskId: primary.id }) }, [icon("play"), t("Focus on this")]),
        h("button", { class: "btn btn-quiet", type: "button", onclick: () => toggleDone(primary, true) }, [icon("check"), t("Complete")]),
        h("button", { class: "icon-btn", type: "button", title: t("Edit task"), onclick: () => openTaskSheet(primary.id) }, icon("pen")),
      ]),
    );
  } else {
    hero.append(h("div", { class: "focus-empty" }, [
      h("span", { class: "focus-empty-icon", "aria-hidden": "true" }, "✓"),
      h("h2", {}, t("This day is clear")),
      h("p", {}, t("Add a task when you are ready for the next one.")),
      h("button", { class: "btn btn-primary", type: "button", onclick: () => emit("focus-quick-add", { day: current }) }, t("Add a task")),
    ]));
  }

  const queue = h("aside", { class: "focus-queue" }, [
    h("header", { class: "focus-queue-head" }, [
      h("div", {}, [h("span", { class: "eyebrow" }, t("Keep nearby")), h("h3", {}, t("Up next"))]),
      h("span", { class: "pill" }, `${Math.max(0, open.length - (primary ? 1 : 0))} ${t("tasks")}`),
    ]),
  ]);
  const remainder = open.filter((task) => task.id !== primary?.id);
  if (!remainder.length) queue.appendChild(h("p", { class: "focus-queue-empty" }, t(primary ? "Nothing else is queued for today." : "Your next task will appear here.")));
  remainder.forEach((task, index) => queue.appendChild(h("button", {
    class: "focus-queue-item",
    type: "button",
    onclick: () => openTaskSheet(task.id),
  }, [
    h("span", { class: "focus-queue-index" }, String(index + 1).padStart(2, "0")),
    h("span", { class: "focus-queue-copy" }, [h("strong", {}, task.title), h("small", {}, [tagChip(task.tag), fmtDuration(task.remaining_seconds)])]),
    icon("arrow-right"),
  ])));

  panel.append(hero, queue);
  return panel;
}

function viewDaysFromSettings() {
  const settings = store.get("settings", {}) || {};
  const current = Number(settings.current_day_index || 1);
  const mode = settings.view_mode || "today";
  let count = 1;
  let start = current;
  if (mode === "tomorrow") start = current + 1;
  else if (mode === "3days") count = 3;
  else if (mode === "week") count = 7;
  else if (mode === "custom") count = clamp(Number(settings.view_days || 4), 1, 60);
  else if (mode === "all") {
    const dayIndexes = (store.get("tasks", []) || []).map((task) => task.day_index);
    const min = dayIndexes.length ? Math.min(...dayIndexes) : current;
    const max = dayIndexes.length ? Math.max(...dayIndexes) : current;
    start = Math.min(min, current);
    count = Math.max(max, current) - start + 1;
  }
  const list = [];
  for (let index = 0; index < count; index += 1) list.push(start + index);
  return list;
}

function sortForLayout(tasks, sortMode, layout) {
  const sorted = sortTasks(tasks, sortMode);
  if (layout !== "agenda") return sorted;
  return sorted.sort((a, b) => {
    const aScheduled = a.scheduled_at ? Date.parse(a.scheduled_at) : Number.POSITIVE_INFINITY;
    const bScheduled = b.scheduled_at ? Date.parse(b.scheduled_at) : Number.POSITIVE_INFINITY;
    const aValid = Number.isFinite(aScheduled) ? aScheduled : Number.POSITIVE_INFINITY;
    const bValid = Number.isFinite(bScheduled) ? bScheduled : Number.POSITIVE_INFINITY;
    return aValid - bValid || Number(a.order_index || 0) - Number(b.order_index || 0);
  });
}

function buildDayColumn(dayIndex, current, layout, sortMode) {
  const tasks = sortForLayout(tasksForDay(dayIndex), sortMode, layout);
  const totals = totalsForDay(dayIndex);
  const capacity = store.settingNum("capacity_minutes", 480) * 60;
  const ratio = capacity > 0 ? totals.planned / capacity : 0;
  const budgetState = ratio > 1.4 ? "critical" : ratio > 1 ? "over" : ratio > 0.85 ? "full" : "ok";

  const column = h("section", {
    class: `day-column${dayIndex === current ? " is-current" : ""}`,
    dataset: { day: String(dayIndex), dndDay: String(dayIndex) },
  });

  column.appendChild(
    h("header", { class: "day-column-head" }, [
      h("div", { class: "day-title-row" }, [
        h("div", {}, [
          h("h4", {}, dayLabel(dayIndex, current)),
          h("span", { class: "day-stats" }, [
            h("span", {}, `${tasks.filter((t) => !t.done).length} open`),
            h("span", {}, `${fmtShort(totals.remaining)} left`),
            h("span", {}, `${fmtShort(totals.planned)} planned`),
          ]),
        ]),
        dayIndex === current ? h("span", { class: "pill pill-accent" }, "now") : null,
      ]),
      h("div", { class: "progress-track progress-track-slim" }, [
        h("div", { class: "progress-fill", style: { width: `${clamp(totals.progress, 0, 100)}%` } }),
      ]),
      capacity > 0
        ? h("div", {
            class: `day-budget is-${budgetState}`,
          }, [
            icon(budgetState === "ok" ? "check" : "bell"),
            `${fmtShort(totals.planned)} of ${fmtShort(capacity)} capacity`,
            budgetState === "ok" ? null : ` · ${fmtPercent(ratio * 100)}`,
          ])
        : null,
    ]),
  );

  if (layout === "compact") {
    column.appendChild(
      h("div", { class: "table-head-row compact-head-row" }, [
        h("span", {}, "status"), h("span", {}, "task"), h("span", {}, "left"), h("span", {}, "progress"), h("span", {}, "tag"),
      ]),
    );
  }

  const container = h("div", { class: "day-tasks", dataset: { day: String(dayIndex), dndContainer: "1" } });
  if (!tasks.length) {
    container.appendChild(
      h("div", { class: "day-empty" }, [
        h("div", {}, "No tasks yet"),
        h("button", {
          class: "link-btn",
          type: "button",
          onclick: () => emit("focus-quick-add", { day: dayIndex }),
        }, "Add one"),
      ]),
    );
  }
  tasks.forEach((task) => container.appendChild(buildTaskCard(task, { current, layout, columnTotal: totals.planned })));
  column.appendChild(container);

  column.appendChild(
    h("div", { class: "day-add-row" }, [
      h("input", {
        type: "text",
        placeholder: "Add to this day…",
        "aria-label": `Add a task to ${dayLabel(dayIndex, current)}`,
        onkeydown: (event) => {
          if (event.key !== "Enter") return;
          const title = event.target.value.trim();
          if (!title) return;
          event.target.value = "";
          quickAddToDay(title, dayIndex);
        },
      }),
      h("button", {
        class: "icon-btn icon-btn-sm",
        type: "button",
        title: "Open the bulk composer for this day",
        onclick: () => emit("open-bulk", { day: dayIndex }),
      }, icon("list")),
    ]),
  );

  return column;
}

function buildFlatTimeline(layout, current, sortMode) {
  const tasks = sortForLayout(store.get("tasks", []) || [], sortMode, layout);
  const container = h("section", { class: "day-column", dataset: { dndContainer: "1" } }, [
    h("header", { class: "day-column-head" }, [
      h("h4", {}, "All tasks"),
      h("span", { class: "day-stats" }, `${tasks.length} total`),
    ]),
  ]);
  const list = h("div", { class: "day-tasks" });
  tasks.forEach((task) => list.appendChild(buildTaskCard(task, { current, layout, showDay: true })));
  container.appendChild(list);
  return container;
}

function buildGroupedTimeline(mode, current, sortMode) {
  const tasks = sortTasks(store.get("tasks", []) || [], sortMode);
  const groups = groupTasks(tasks, mode);
  const wrapper = h("div", { class: "timeline-inner" });
  const entries = [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  entries.forEach(([key, items]) => {
    const heading = mode === "tag"
      ? (key === "__untagged" ? "Untagged" : `#${store.tag(key)?.label || key}`)
      : `${PRIORITY_LABELS[Number(key)] || "None"} priority`;
    const column = h("section", { class: "day-column", dataset: { dndContainer: "1" } }, [
      h("header", { class: "day-column-head" }, [
        h("div", { class: "day-title-row" }, [
          h("h4", {}, heading),
          h("span", { class: "day-stats" }, `${items.filter((t) => !t.done).length} open · ${fmtShort(items.reduce((sum, t) => sum + t.total_seconds, 0))}`),
        ]),
      ]),
    ]);
    const list = h("div", { class: "day-tasks" });
    items.forEach((task) => list.appendChild(buildTaskCard(task, { current, layout: document.documentElement.dataset.layout, showDay: true })));
    column.appendChild(list);
    wrapper.appendChild(column);
  });
  return wrapper;
}

function buildTaskCard(task, context = {}) {
  const layout = context.layout || "agenda";
  const card = h("article", {
    class: `task-card-block${task.done ? " is-done" : ""}${task.done ? "" : ""}`,
    dataset: { id: String(task.id), day: String(task.day_index), priority: String(task.priority) },
    style: { "--tag-color": store.tagColor(task.tag) },
    tabindex: "0",
  });

  const elapsed = Number(task.elapsed_seconds ?? Math.max(0, task.total_seconds - task.remaining_seconds));
  const progress = task.total_seconds
    ? clamp((elapsed / task.total_seconds) * 100, 0, 100)
    : 0;

  const title = h("span", { class: "task-title" }, task.title);
  const drag = h("button", {
    class: "task-drag",
    type: "button",
    title: t("Drag to reorder"),
    "aria-label": t("Drag to reorder task"),
    "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
  }, icon("drag"));
  const metaLine = h("div", { class: "task-meta-line" }, [
    context.showDay ? h("span", {}, dayShortLabel(task.day_index, context.current)) : null,
    projectChip(task.project_id),
    tagChip(task.tag),
    task.pinned ? h("span", { class: "pin-mark" }, [icon("pin")]) : null,
    scheduleChip(task),
    task.subtasks?.length ? subtaskDots(task) : null,
  ]);

  const actions = h("div", { class: "task-block-actions" }, [
    h("button", {
      type: "button", title: "Complete", onclick: (event) => { event.stopPropagation(); toggleDone(task, true); },
    }, icon("check")),
    h("button", {
      type: "button", title: "Edit", onclick: (event) => { event.stopPropagation(); openTaskSheet(task.id); },
    }, icon("pen")),
    h("button", {
      type: "button", title: "More", onclick: (event) => { event.stopPropagation(); taskActions(task); },
    }, icon("more")),
  ]);

  const durationEl = h("span", { class: "task-block-duration" }, task.done ? "done" : fmtDuration(task.remaining_seconds));

  const miniProgress = h("div", { class: "task-mini-progress" }, [
    h("div", { class: "fill", style: { width: `${progress}%` } }),
  ]);

  if (layout === "compact") {
    card.append(
      h("div", { class: "task-table-status" }, [drag, h("span", { class: "task-meta-line" }, task.done ? t("done") : (task.pinned ? t("pinned") : t("open")))]),
      h("span", { class: "task-title" }, [priorityMark(task.priority), " ", task.title]),
      durationEl,
      miniProgress,
      h("span", { class: "task-meta-line" }, [projectChip(task.project_id), task.tag ? `#${store.tag(task.tag)?.label || task.tag}` : "—"]),
    );
  } else if (layout === "stream") {
    card.append(
      h("div", { class: "task-top" }, [drag, h("div", { class: "task-main" }, [title, metaLine])]),
      durationEl,
      miniProgress,
    );
  } else if (layout === "cards") {
    const ring = tileRing(progress);
    card.append(ring, h("div", { class: "task-top" }, [drag, title, actions]), metaLine, durationEl, miniProgress);
  } else {
    card.append(
      h("div", { class: "task-top" }, [drag, title, actions]),
      metaLine,
      h("div", { class: "row-between" }, [durationEl, h("span", { class: "task-meta-line" }, h("span", {}, `${fmtPercent(progress)}`))]),
      miniProgress,
    );
  }

  card.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input, textarea, select")) return;
    openTaskSheet(task.id);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target !== card || event.key !== "Enter") return;
    openTaskSheet(task.id);
  });
  attachSwipe(card, { onRight: () => toggleDone(task, true), onLeft: () => skipTask(task) });
  attachLongPress(card, () => taskActions(task));
  return card;
}

function tileRing(progress) {
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - progress / 100);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tile-ring");
  svg.setAttribute("viewBox", "0 0 76 76");
  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  track.setAttribute("class", "track");
  track.setAttribute("cx", "38");
  track.setAttribute("cy", "38");
  track.setAttribute("r", String(radius));
  const value = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  value.setAttribute("class", "val");
  value.setAttribute("cx", "38");
  value.setAttribute("cy", "38");
  value.setAttribute("r", String(radius));
  value.setAttribute("stroke-dasharray", String(circumference));
  value.setAttribute("stroke-dashoffset", String(offset));
  svg.append(track, value);
  return svg;
}

/* --------------------------------------------------------------------------
   Actions
   -------------------------------------------------------------------------- */
export async function toggleDone(task, done = null) {
  const next = done === null ? !task.done : done;
  try {
    await api.doneTask(task.id, next);
    if (next) {
      const totals = totalsForDay(task.day_index);
      if (totals.open === 0) {
        celebrate(26);
        toast(`${dayLabel(task.day_index)} cleared — every task done 🎉`, { tone: "good", timeout: 5200 });
      } else {
        toast(`“${truncate(task.title)}” done`, {
          tone: "good",
          action: { label: "Undo", run: () => api.doneTask(task.id, false).then(refresh) },
        });
      }
    }
    await refresh();
  } catch (error) {
    toast(error.message || "Could not update the task", { tone: "error" });
  }
}

export async function skipTask(task) {
  try {
    await api.skipTask(task.id);
    toast(`“${truncate(task.title)}” moved to the end`, { tone: "warn" });
    await refresh();
  } catch (error) {
    toast(error.message || "Could not skip the task", { tone: "error" });
  }
}

export async function moveTaskToDay(task, dayIndex) {
  try {
    await api.moveTask(task.id, dayIndex);
    toast(`Moved to ${dayLabel(dayIndex)}`, { tone: "good" });
    await refresh();
  } catch (error) {
    toast(error.message || "Could not move the task", { tone: "error" });
  }
}

export async function duplicateTask(task) {
  try {
    await api.duplicateTask(task.id);
    toast("Duplicated", { tone: "good" });
    await refresh();
  } catch (error) {
    toast(error.message || "Could not duplicate", { tone: "error" });
  }
}

export async function pinTask(task) {
  try {
    await api.pinTask(task.id);
    await refresh();
  } catch (error) {
    toast(error.message || "Could not pin", { tone: "error" });
  }
}

export async function deleteTask(task) {
  if (store.setting("confirm_destructive", 1) === 1) {
    const ok = await confirmAction({
      title: "Delete task?",
      text: `“${task.title}” will be removed. You can still undo this.`,
      okLabel: "Delete",
    });
    if (!ok) return;
  }
  try {
    await api.deleteTask(task.id);
    toast("Task deleted", {
      tone: "warn",
      action: { label: "Undo", run: () => api.undo().then(refresh) },
    });
    await refresh();
  } catch (error) {
    toast(error.message || "Could not delete", { tone: "error" });
  }
}

export async function splitTask(task) {
  const data = await formDialog({
    title: "Split into parts",
    eyebrow: task.title,
    eyebrowIsUserContent: true,
    fields: [
      { name: "pieces", label: "Number of parts", type: "number", value: 2, min: 2, max: 12 },
      { name: "prefix", label: "Label parts as", type: "text", value: `${task.title} · part`, note: "Leave as-is to keep the title with a numbered suffix." },
    ],
    submitLabel: "Split",
  });
  if (!data) return;
  try {
    await api.splitTask(task.id, data.pieces, null);
    toast(`Split into ${data.pieces} parts`, { tone: "good" });
    await refresh();
  } catch (error) {
    toast(error.message || "Could not split", { tone: "error" });
  }
}

export async function quickAddToDay(text, dayIndex) {
  try {
    const result = await api.bulkAdd(text, dayIndex);
    const created = result?.result?.created ?? 0;
    if (created) {
      toast(`Added ${created} task${created === 1 ? "" : "s"} to ${dayLabel(dayIndex)}`, { tone: "good" });
    } else {
      toast(result?.result?.error || "Could not parse that line", { tone: "warn" });
    }
    await refresh();
  } catch (error) {
    toast(error.message || "Could not add the task", { tone: "error" });
  }
}

export function taskActions(task) {
  const current = store.settingNum("current_day_index", 1);
  actionSheet(task.title, [
    { label: task.done ? "Reopen task" : "Mark complete", icon: "check", run: () => toggleDone(task, !task.done) },
    { label: "Start focus on this", icon: "play", run: () => emit("focus-task", { taskId: task.id }) },
    { label: "Edit…", icon: "pen", run: () => openTaskSheet(task.id) },
    { label: task.pinned ? "Unpin" : "Pin to top", icon: "pin", run: () => pinTask(task) },
    { label: "Move to end of day", icon: "skip", run: () => skipTask(task) },
    {
      label: "Move to another day…",
      icon: "calendar",
      run: async () => {
        const data = await formDialog({
          title: "Move task",
          eyebrow: task.title,
          eyebrowIsUserContent: true,
          fields: [{ name: "day", label: "Virtual day index", type: "number", value: current, min: 1, max: 9999 }],
          submitLabel: "Move",
        });
        if (data) moveTaskToDay(task, data.day);
      },
    },
    { label: "Duplicate", icon: "copy", run: () => duplicateTask(task) },
    { label: "Split into parts…", icon: "split", run: () => splitTask(task) },
    { label: "Add a subtask…", icon: "plus", run: () => addSubtaskPrompt(task) },
    {
      label: "Repeat…",
      icon: "repeat",
      run: async () => {
        const data = await formDialog({
          title: "Make it repeat",
          eyebrow: task.title,
          eyebrowIsUserContent: true,
          fields: [
            {
              name: "freq", label: "Frequency", type: "select", value: "daily",
              options: [
                { value: "daily", label: "Every day" },
                { value: "weekly", label: "Every week (Mon–Fri)" },
                { value: "weekends", label: "Weekends" },
                { value: "every_n_days", label: "Every N days" },
                { value: "monthly", label: "Every 30 days" },
              ],
            },
            { name: "interval", label: "Interval (for every N days)", type: "number", value: 2, min: 1, max: 60 },
            { name: "time", label: "Preferred time (optional)", type: "time" },
          ],
          submitLabel: "Create rule",
        });
        if (!data) return;
        const rule = { freq: data.freq, interval: data.interval || 1, weekdays: [0, 1, 2, 3, 4], time: data.time || "" };
        if (data.freq === "weekends") { rule.freq = "weekly"; rule.weekdays = [5, 6]; }
        await api.saveRecurrence({
          title: task.title,
          tag: task.tag,
          priority: task.priority,
          duration_seconds: task.total_seconds,
          rule,
          anchor_day_index: task.day_index,
          notes: task.notes,
        });
        toast("Recurring rule created — materialise it from the Library", { tone: "good" });
        await refresh();
      },
    },
    task.tag ? {
      label: `Set duration for every #${task.tag} task…`,
      icon: "clock",
      run: () => tagDurationPrompt(task),
    } : null,
    { label: "Delete", icon: "trash", danger: true, run: () => deleteTask(task) },
  ], { userTitle: true });
}

async function addSubtaskPrompt(task) {
  const data = await formDialog({
    title: "Add a subtask",
    eyebrow: task.title,
    eyebrowIsUserContent: true,
    fields: [{ name: "title", label: "Step", type: "text", placeholder: "What is the next action?", required: true }],
    submitLabel: "Add step",
  });
  if (!data) return;
  await api.addSubtask(task.id, data.title);
  await refresh();
}

async function tagDurationPrompt(task) {
  const data = await formDialog({
    title: `Duration for #${task.tag}`,
    eyebrow: "Applies to every open task with this tag",
    fields: [{ name: "duration", label: "Duration", type: "text", value: fmtDuration(task.total_seconds), required: true }],
    submitLabel: "Apply",
  });
  if (!data) return;
  const targets = (store.get("tasks", []) || []).filter((item) => item.tag === task.tag && !item.done);
  await api.bulkAction("duration", targets.map((item) => item.id), { duration_text: data.duration });
  toast(`Updated ${targets.length} task${targets.length === 1 ? "" : "s"}`, { tone: "good" });
  await refresh();
}

/* --------------------------------------------------------------------------
   Task editor sheet
   -------------------------------------------------------------------------- */
export function openTaskSheet(taskId) {
  const task = (store.get("tasks", []) || []).find((item) => item.id === Number(taskId));
  if (!task) return;
  editingTaskId = task.id;
  pendingSubtasks = (task.subtasks || []).map((sub) => ({ ...sub }));

  byId("taskSheetTitle").textContent = task.title;
  byId("taskSheetEyebrow").textContent = `${dayLabel(task.day_index)} · ${fmtDuration(task.total_seconds)} ${t("planned")}`;
  byId("editTitle").value = task.title;
  byId("editNotes").value = task.notes || "";
  byId("editTag").value = task.tag || "";
  renderProjectOptions(task.project_id);
  byId("editDay").value = task.day_index;
  if (byId("editDayDateHint")) byId("editDayDateHint").textContent = `${window.TaskArcadeI18n?.t?.("Calendar date") || "Calendar date"}: ${calendarDayLabel(task.day_index)}`;
  byId("editDuration").value = fmtDuration(task.total_seconds, "hm");
  byId("editElapsed").value = fmtDuration(Math.max(0, Number(task.elapsed_seconds ?? (task.total_seconds - (task.done ? 0 : task.remaining_seconds)))), "hm");
  byId("editSkippedCount").value = String(task.skipped_count || 0);
  byId("editDoneSwitch")?.setAttribute("aria-checked", task.done ? "true" : "false");
  byId("editScheduled").value = (task.scheduled_at || "").includes("T") ? "" : (task.scheduled_at || "");
  byId("editReminder").value = (task.reminder_at || "").slice(0, 16);
  byId("editPomos").value = task.tomatoes_estimate || 0;

  const hint = byId("editDurationHint");
  if (hint) {
    const spent = Math.max(0, Number(task.elapsed_seconds ?? (task.total_seconds - (task.done ? 0 : task.remaining_seconds))));
    const translate = (value) => window.TaskArcadeI18n?.t?.(value) || value;
    hint.textContent = `${translate("Elapsed so far:")} ${fmtDuration(spent)} · ${fmtDuration(task.remaining_seconds)} ${translate("left")}. ${translate("Changing the estimate preserves elapsed progress.")}`;
  }

  $$("#priorityControl button").forEach((button) => {
    const selected = Number(button.dataset.priority) === Number(task.priority);
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-checked", selected ? "true" : "false");
  });

  const pinBtn = byId("pinTaskBtn");
  if (pinBtn) pinBtn.classList.toggle("is-active", !!task.pinned);

  renderDurationChips();
  renderSubtaskList();
  renderTagOptions();
  openSheet("taskSheet");
}

function renderDurationChips() {
  const holder = byId("durationChips");
  if (!holder) return;
  clear(holder);
  const pomodoro = store.settingNum("pomodoro_focus", 25);
  const presets = [15, 25, 30, 45, 60, 90, 120].map((minutes) => `${minutes}m`);
  presets.push("2p");
  presets.forEach((preset) => {
    holder.appendChild(
      h("button", {
        type: "button",
        onclick: () => {
          const input = byId("editDuration");
          input.value = preset;
          input.focus();
        },
      }, preset),
    );
  });
}

function renderProjectOptions(selectedProjectId = 0) {
  const select = byId("editProject");
  if (!select) return;
  clear(select);
  select.appendChild(h("option", { value: "0" }, t("No project")));
  (store.get("projects", []) || []).filter((project) => project.status !== "archived" || Number(project.id) === Number(selectedProjectId)).forEach((project) => {
    select.appendChild(h("option", { value: String(project.id) }, project.name));
  });
  select.value = String(selectedProjectId || 0);
}

function renderTagOptions() {
  const list = byId("tagOptions");
  if (!list) return;
  clear(list);
  (store.get("tags", []) || []).forEach((tag) => {
    list.appendChild(h("option", { value: tag.name, "data-no-translate": true }, `${tag.label}${tag.aliases?.length ? ` (${tag.aliases.map((a) => `#${a}`).join(", ")})` : ""}`));
  });
}

function renderSubtaskList() {
  const list = byId("subtaskList");
  if (!list) return;
  clear(list);
  if (!pendingSubtasks.length) {
    list.appendChild(h("li", { class: "form-hint" }, "No steps yet."));
    return;
  }
  pendingSubtasks.forEach((sub, index) => {
    const item = h("li", { class: `subtask-item${sub.done ? " is-done" : ""}` }, [
      h("button", {
        class: `mini-check${sub.done ? " is-done" : ""}`,
        type: "button",
        "aria-label": sub.done ? "Mark step open" : "Mark step done",
        onclick: async () => {
          if (sub.id) {
            await api.toggleSubtask(sub.id, !sub.done);
            await refresh();
            pendingSubtasks = ((store.get("tasks", []) || []).find((t) => t.id === editingTaskId)?.subtasks || []).map((s) => ({ ...s }));
          } else {
            sub.done = !sub.done;
          }
          renderSubtaskList();
        },
      }, icon("check")),
      h("span", { class: "subtask-title" }, sub.title),
      h("button", {
        class: "icon-btn icon-btn-sm",
        type: "button",
        title: "Remove step",
        onclick: async () => {
          if (sub.id) await api.deleteSubtask(sub.id);
          pendingSubtasks.splice(index, 1);
          renderSubtaskList();
          if (sub.id) await refresh();
        },
      }, icon("x")),
    ]);
    list.appendChild(item);
  });
}

function parseEditableElapsed(value) {
  const text = normalizeDigits(String(value ?? "")).trim();
  if (!text || /^0(?:\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|د|دقیقه|ث|ثانیه))?$/iu.test(text)) return 0;
  return parseDurationText(text, store.settingNum("pomodoro_focus", 25));
}

export async function saveTaskSheet() {
  if (editingTaskId === null) return;
  const elapsed = parseEditableElapsed(byId("editElapsed")?.value);
  if (elapsed === null) {
    toast("Enter a valid elapsed duration", { tone: "warn" });
    byId("editElapsed")?.focus();
    return;
  }
  const payload = {
    title: byId("editTitle").value.trim(),
    notes: byId("editNotes").value,
    tag: byId("editTag").value.replace(/^#/, "").trim(),
    project_id: Number(byId("editProject")?.value || 0),
    day_index: Number(byId("editDay").value) || 1,
    priority: Number($("#priorityControl button.is-active")?.dataset.priority || 0),
    duration_text: byId("editDuration").value.trim(),
    elapsed_seconds: elapsed,
    done: byId("editDoneSwitch")?.getAttribute("aria-checked") === "true",
    skipped_count: Math.max(0, Number(byId("editSkippedCount")?.value) || 0),
    scheduled_at: byId("editScheduled").value || "",
    reminder_at: byId("editReminder").value || "",
    tomatoes_estimate: Number(byId("editPomos").value) || 0,
  };
  if (!payload.title) {
    toast("A task needs a title", { tone: "warn" });
    return;
  }
  try {
    await api.updateTask(editingTaskId, payload);
    closeSheet("taskSheet");
    toast("Saved", { tone: "good" });
    await refresh();
  } catch (error) {
    toast(error.message || "Could not save (check the duration format)", { tone: "error" });
  }
}

export function initTaskSheet() {
  byId("saveTaskBtn")?.addEventListener("click", saveTaskSheet);
  byId("editDay")?.addEventListener("input", (event) => {
    const day = Math.max(1, Number(event.currentTarget.value) || 1);
    const label = window.TaskArcadeI18n?.t?.("Calendar date") || "Calendar date";
    if (byId("editDayDateHint")) byId("editDayDateHint").textContent = `${label}: ${calendarDayLabel(day)}`;
  });
  byId("editDoneSwitch")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    button.setAttribute("aria-checked", button.getAttribute("aria-checked") === "true" ? "false" : "true");
  });
  byId("taskSheet")?.addEventListener("click", (event) => {
    const adjust = event.target.closest("[data-elapsed-adjust]");
    if (!adjust) return;
    const input = byId("editElapsed");
    const current = parseEditableElapsed(input?.value) ?? 0;
    const next = Math.max(0, current + Number(adjust.dataset.elapsedAdjust || 0));
    if (input) { input.value = fmtDuration(next, "hm"); input.focus(); }
  });
  byId("deleteTaskBtn")?.addEventListener("click", async () => {
    const task = (store.get("tasks", []) || []).find((item) => item.id === editingTaskId);
    closeSheet("taskSheet");
    if (task) deleteTask(task);
  });
  byId("duplicateTaskBtn")?.addEventListener("click", async () => {
    const task = (store.get("tasks", []) || []).find((item) => item.id === editingTaskId);
    closeSheet("taskSheet");
    if (task) duplicateTask(task);
  });
  byId("pinTaskBtn")?.addEventListener("click", async () => {
    const task = (store.get("tasks", []) || []).find((item) => item.id === editingTaskId);
    if (!task) return;
    await pinTask(task);
    const fresh = (store.get("tasks", []) || []).find((item) => item.id === editingTaskId);
    byId("pinTaskBtn").classList.toggle("is-active", !!fresh?.pinned);
  });
  byId("recurTaskBtn")?.addEventListener("click", () => {
    const task = (store.get("tasks", []) || []).find((item) => item.id === editingTaskId);
    if (task) taskActions(task);
  });
  byId("applyTagDurationBtn")?.addEventListener("click", () => {
    const task = (store.get("tasks", []) || []).find((item) => item.id === editingTaskId);
    if (task) tagDurationPrompt(task);
  });
  byId("addSubtaskBtn")?.addEventListener("click", addSubtaskFromInput);
  byId("newSubtask")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addSubtaskFromInput();
    }
  });

  const priorityControl = byId("priorityControl");
  priorityControl?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-priority]");
    if (!button) return;
    $$("button", priorityControl).forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-active", selected);
      item.setAttribute("aria-checked", selected ? "true" : "false");
    });
  });
}

async function addSubtaskFromInput() {
  const input = byId("newSubtask");
  const title = input?.value.trim();
  if (!title || editingTaskId === null) return;
  input.value = "";
  const result = await api.addSubtask(editingTaskId, title);
  pendingSubtasks.push({ id: result?.result?.id, title, done: false, order_index: pendingSubtasks.length });
  renderSubtaskList();
  await refresh();
}

/* --------------------------------------------------------------------------
   Drag & drop persistence
   -------------------------------------------------------------------------- */
async function handleRowDrop(orderedIds, context) {
  try {
    await api.reorder(orderedIds, context?.day ?? store.settingNum("current_day_index", 1));
    await refresh();
  } catch (error) {
    toast(error.message || "Could not reorder", { tone: "error" });
  }
}

async function handleFlowDrop(orderedIds, context) {
  try {
    await api.reorder(orderedIds, context?.day ?? null);
    await refresh();
  } catch (error) {
    toast(error.message || "Could not reorder the task flow", { tone: "error" });
  }
}

async function handleTimelineDrop(orderedIds, context) {
  try {
    await api.reorder(orderedIds, context?.day ?? null);
    await refresh();
  } catch (error) {
    toast(error.message || "Could not move the task", { tone: "error" });
  }
}

/* --------------------------------------------------------------------------
   Refresh hook — imported lazily to avoid a circular dependency
   -------------------------------------------------------------------------- */
let refreshImpl = async () => {};
export function provideRefresh(fn) {
  refreshImpl = fn;
}
async function refresh() {
  await refreshImpl();
}

function truncate(text, max = 46) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
