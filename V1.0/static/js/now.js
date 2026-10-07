/* ==========================================================================
   TaskArcade — the Now view
   The hero card: what to do next, how long is left, and how the virtual day is
   filling up. Everything that is visible updates live while the timer runs —
   `task-tick` events patch the DOM instead of re-rendering the whole list.
   ========================================================================== */

import {
  byId, h, icon, clear, store, emit, on, prefs, clamp, fmtDuration, fmtShort, fmtPercent,
  dayLabel, dayShortLabel, calendarDayLabel, calendarAnchorDate, formatCalendarDate, formatNumber, activeTask, tasksForDay, totalsForDay, totalsOverall,
  PRIORITY_LABELS,
} from "./core.js";
import { api } from "./api.js";
import { toast, confirmAction, formDialog, celebrate } from "./ui.js";
import { tagChip, priorityMark, renderTaskList, renderTimeline } from "./tasks.js";
import { timerValue } from "./focus.js";

const t = (value) => window.TaskArcadeI18n?.t?.(value) ?? value;

const RING_RADIUS_NOW = 86;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS_NOW;
const RING_SESSION_RADIUS = 72;
const RING_SESSION_CIRCUMFERENCE = 2 * Math.PI * RING_SESSION_RADIUS;

/* --------------------------------------------------------------------------
   Hero card
   -------------------------------------------------------------------------- */
export function renderNow() {
  const current = store.settingNum("current_day_index", 1);
  const task = activeTask(current);
  const timer = timerValue();

  const title = byId("nowTitle");
  const sub = byId("nowSub");
  const notes = byId("nowNotes");
  const chips = byId("nowChips");
  const kicker = byId("nowKicker");
  const live = byId("liveDot");
  const startLabel = byId("startTimerLabel");
  const moreBtn = byId("moreNowBtn");
  const ring = byId("ringProgress");
  const ringTime = byId("ringTime");
  const ringSub = byId("ringSub");
  const ringPhase = byId("ringPhase");
  const ringSession = byId("ringSession");
  const taskProgress = byId("nowTaskProgress");
  const taskFill = byId("nowTaskFill");

  const queue = rankedQueue(current);
  const queueCount = byId("queueCount");
  if (queueCount) queueCount.textContent = `${formatNumber(queue.length)} ${t("in queue")}`;

  if (ring) {
    ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  }
  if (ringSession) {
    ringSession.style.strokeDasharray = String(RING_SESSION_CIRCUMFERENCE);
    ringSession.style.strokeDashoffset = "0";
    ringSession.style.opacity = timer.running ? ".9" : ".35";
  }

  if (!task) {
    if (kicker) kicker.textContent = t("Nothing open");
    if (title) title.textContent = t("All clear for today");
    if (sub) sub.textContent = t("Add a task, apply a template, or finish the day to move the timeline forward.");
    if (notes) notes.hidden = true;
    if (chips) {
      clear(chips);
      chips.appendChild(h("span", { class: "chip" }, [icon("check"), "day cleared"]));
    }
    if (live) live.classList.remove("is-live");
    if (ringTime) ringTime.textContent = "--";
    if (ringSub) ringSub.textContent = t("nothing queued");
    if (ringPhase) ringPhase.hidden = true;
    if (ring) ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    if (taskProgress) taskProgress.textContent = fmtPercent(0);
    if (taskFill) taskFill.style.width = "0%";
    toggleNowButtons(false);
    return;
  }

  toggleNowButtons(true);

  const remaining = task.remaining_seconds;
  const fraction = task.total_seconds > 0 ? clamp(remaining / task.total_seconds, 0, 1) : 0;
  if (ring) ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));

  if (kicker) {
    kicker.textContent = t(timer.running
      ? (timer.phase === "break" || timer.phase === "longbreak" ? "On a break" : "Focusing now")
      : "Up next");
  }
  if (live) live.classList.toggle("is-live", timer.running);
  if (title) title.textContent = task.title;
  if (notes) {
    notes.hidden = !task.notes;
    notes.textContent = task.notes || "";
  }
  if (sub) {
    sub.textContent = [
      `${fmtDuration(remaining)} ${t("left of")} ${fmtDuration(task.total_seconds)}`,
      task.tag ? `#${store.tag(task.tag)?.label || task.tag}` : null,
      task.scheduled_at ? `${t("scheduled")} ${String(task.scheduled_at).replace("T", " ")}` : null,
      task.pinned ? t("pinned") : null,
      task.skipped_count ? `${t("deferred")} ${formatNumber(task.skipped_count)}×` : null,
    ].filter(Boolean).join(" · ");
  }

  if (chips) {
    clear(chips);
    chips.appendChild(h("span", { class: "chip" }, [icon("calendar"), dayLabel(task.day_index, current)]));
    const tag = tagChip(task.tag);
    if (tag) chips.appendChild(tag);
    const priority = priorityMark(task.priority);
    if (priority) chips.appendChild(h("span", { class: "chip" }, [icon("bolt"), PRIORITY_LABELS[task.priority]]));
    if (task.subtasks?.length) {
      const done = task.subtasks.filter((step) => step.done).length;
      chips.appendChild(h("span", { class: "chip" }, [icon("list"), `${formatNumber(done)}/${formatNumber(task.subtasks.length)} ${t("steps")}`]));
    }
    if (task.tomatoes_estimate) {
      chips.appendChild(h("span", { class: "chip" }, `~${formatNumber(task.tomatoes_estimate)}🍅`));
    }
    void priority;
  }

  if (ringTime) ringTime.textContent = fmtDuration(remaining);
  if (ringSub) {
    ringSub.textContent = t(timer.running
      ? (timer.phase === "break" || timer.phase === "longbreak" ? "break running" : "counting down")
      : "remaining");
  }
  if (ringPhase) {
    const show = timer.running && timer.phase !== "idle";
    ringPhase.hidden = !show;
    if (show) {
      const set = Math.floor(timer.cyclesDone / Math.max(1, store.settingNum("pomodoro_cycles", 4))) + 1;
      ringPhase.textContent = timer.phase === "focus" ? `${t("focus")} · ${t("set")} ${formatNumber(set)}` : t("break");
    }
  }

  const progress = task.total_seconds ? (Number(task.elapsed_seconds ?? (task.total_seconds - remaining)) / task.total_seconds) * 100 : 0;
  if (taskProgress) taskProgress.textContent = fmtPercent(progress);
  if (taskFill) taskFill.style.width = `${clamp(progress, 0, 100)}%`;

  if (startLabel) {
    startLabel.textContent = t(timer.running
      ? "Pause"
      : timer.phase === "idle"
        ? "Start focus"
        : "Resume");
  }

  if (moreBtn) moreBtn.dataset.taskId = String(task.id);
}

function toggleNowButtons(enabled) {
  ["doneBtn", "skipBtn", "editNowBtn"].forEach((id) => {
    const button = byId(id);
    if (button) button.disabled = !enabled;
  });
}

/* --------------------------------------------------------------------------
   Day metrics
   -------------------------------------------------------------------------- */
export function renderDayMetrics() {
  const current = store.settingNum("current_day_index", 1);
  const totals = totalsForDay(current);
  const capacity = store.settingNum("capacity_minutes", 480) * 60;
  const goal = store.settingNum("daily_goal_minutes", 240) * 60;
  const stats = store.meta?.stats || {};

  const sessions = (store.get("sessions", []) || []).filter(
    (session) => session.day_index === current && session.kind === "focus",
  );
  const focusToday = sessions.reduce((sum, session) => sum + (session.seconds || 0), 0)
    || tasksForDay(current).reduce((sum, task) => sum + (task.focus_seconds || 0), 0);
  const breakToday = (store.get("sessions", []) || [])
    .filter((session) => session.day_index === current && session.kind === "break")
    .reduce((sum, session) => sum + (session.seconds || 0), 0);

  setText("metricDone", String(totals.done));
  setText("metricOpen", String(totals.open));
  setText("metricFocus", fmtShort(focusToday));
  setText("metricStretch", fmtShort(breakToday));

  const pill = byId("capacityPill");
  if (pill) {
    if (!capacity) {
      pill.textContent = t("no capacity set");
      pill.className = "pill";
    } else {
      const ratio = totals.planned / capacity;
      pill.textContent = fmtPercent(ratio * 100);
      pill.className = `pill ${ratio > 1.4 ? "pill-danger" : ratio > 1 ? "pill-warn" : "pill-good"}`;
    }
  }

  const note = byId("capacityNote");
  if (note) {
    if (!capacity) {
      note.textContent = t("Set a daily capacity in Settings → Time to get overload warnings.");
    } else {
      const ratio = totals.planned / capacity;
      const verdict = t(ratio <= 0.75
        ? "Room to spare."
        : ratio <= 1
          ? "The day is full."
          : ratio <= 1.4
            ? "Slightly over capacity — consider moving something."
            : "Way over capacity. Split the day or defer tasks.");
      note.textContent = `${fmtShort(totals.planned)} ${t("planned against")} ${fmtShort(capacity)} ${t("of capacity")}. ${verdict}`;
      note.className = `panel-note${ratio > 1 ? " form-error" : ""}`;
    }
  }

  const doneWidth = totals.planned ? (totals.completedSeconds / Math.max(capacity || totals.planned, 1)) * 100 : 0;
  const leftWidth = totals.planned ? (totals.remaining / Math.max(capacity || totals.planned, 1)) * 100 : 0;
  const overWidth = capacity && totals.planned > capacity
    ? clamp(((totals.planned - capacity) / capacity) * 100, 0, 100)
    : 0;

  const stackDone = byId("stackDone");
  const stackLeft = byId("stackLeft");
  const stackOver = byId("stackOver");
  const base = capacity || totals.planned || 1;
  if (stackDone) stackDone.style.width = `${clamp((totals.completedSeconds / base) * 100, 0, 100)}%`;
  if (stackLeft) stackLeft.style.width = `${clamp((totals.remaining / base) * 100, 0, 100)}%`;
  if (stackOver) stackOver.style.width = `${overWidth}%`;
  void doneWidth;
  void leftWidth;

  const goalFill = byId("goalFill");
  const goalText = byId("goalText");
  if (goalFill) goalFill.style.width = `${clamp(goal ? (focusToday / goal) * 100 : 0, 0, 100)}%`;
  if (goalText) goalText.textContent = `${fmtDuration(focusToday)} / ${goal ? fmtDuration(goal) : "—"}`;

  setText("brandSub", store.setting("greeting", "Make time visible."));

  const wip = store.settingNum("wip_limit", 3);
  if (totals.open > wip && !sessionStorage.getItem(`wip-warned-${current}`)) {
    sessionStorage.setItem(`wip-warned-${current}`, "1");
    toast(`${totals.open} open tasks — your WIP limit is ${wip}`, {
      tone: "warn",
      action: { label: "Review queue", run: () => emit("switch-tab", { tab: "focus" }) },
    });
  }

  const streak = stats.streaks?.current || 0;
  const pillEl = byId("queuePill");
  if (pillEl && streak > 1) pillEl.title = `${streak}-day streak`;
}

function setText(id, value) {
  const node = byId(id);
  if (node) node.textContent = t(String(value));
}

async function ensureCalendarAnchor() {
  if (store.setting("calendar_start_date", "")) return;
  await api.settings({ calendar_start_date: formatCalendarDate(calendarAnchorDate()) });
}

/* --------------------------------------------------------------------------
   Top bar
   -------------------------------------------------------------------------- */
export function renderTopBar() {
  const current = store.settingNum("current_day_index", 1);
  const totals = totalsOverall();
  const localizedDay = window.TaskArcadeI18n?.t?.(`Day ${current}`) || `Day ${current}`;
  setText("dayLabel", localizedDay);
  setText("daySub", `${dayShortLabel(current, current)} · ${calendarDayLabel(current)}`);
  const fill = byId("topProgressFill");
  const text = byId("topProgressText");
  const progress = clamp(totals.progress, 0, 100);
  if (fill) fill.style.width = `${progress}%`;
  if (text) text.textContent = `${fmtPercent(progress)} · ${fmtShort(totals.remaining)} ${t("left")}`;

  const brandSub = byId("brandSub");
  if (brandSub) brandSub.textContent = store.setting("greeting", "Make time visible.");

  const prev = byId("dayPrev");
  if (prev) prev.disabled = current <= 1;
}

/* --------------------------------------------------------------------------
   Ranked queue
   -------------------------------------------------------------------------- */
export function rankedQueue(dayIndex = null) {
  const day = dayIndex ?? store.settingNum("current_day_index", 1);
  const tasks = store.get("queue", null);
  if (Array.isArray(tasks) && tasks.length && tasks[0]?.day_index === day) {
    return tasks.slice().sort((a, b) => (b.focus_score || 0) - (a.focus_score || 0));
  }
  return tasksForDay(day)
    .filter((task) => !task.done)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.priority - a.priority || a.order_index - b.order_index);
}

/* --------------------------------------------------------------------------
   Live patching while the timer runs
   -------------------------------------------------------------------------- */
export function initNowLiveUpdates() {
  on("task-tick", ({ taskId, remaining, task }) => {
    const currentTask = activeTask();
    if (currentTask && currentTask.id === taskId) {
      const ring = byId("ringProgress");
      const ringTime = byId("ringTime");
      const fill = byId("nowTaskFill");
      const label = byId("nowTaskProgress");
      const fraction = task.total_seconds > 0 ? clamp(remaining / task.total_seconds, 0, 1) : 0;
      if (ring) ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
      if (ringTime) ringTime.textContent = fmtDuration(remaining);
      const progress = task.total_seconds ? ((task.total_seconds - remaining) / task.total_seconds) * 100 : 0;
      if (fill) fill.style.width = `${clamp(progress, 0, 100)}%`;
      if (label) label.textContent = fmtPercent(progress);
    }
    patchRow(taskId, remaining, task);
  });

  on("timer", () => renderNow());

  on("state", () => {
    renderTopBar();
    renderDayMetrics();
    renderNow();
  });
}

function patchRow(taskId, remaining, task) {
  const row = document.querySelector(`.task-row[data-id="${taskId}"]`);
  if (row) {
    const duration = row.querySelector(".task-duration");
    if (duration) duration.textContent = fmtDuration(remaining);
    const fill = row.querySelector(".progress-fill");
    if (fill && task.total_seconds) {
      fill.style.width = `${clamp(((task.total_seconds - remaining) / task.total_seconds) * 100, 0, 100)}%`;
    }
  }
  const card = document.querySelector(`.task-card-block[data-id="${taskId}"]`);
  if (card) {
    const duration = card.querySelector(".task-block-duration");
    if (duration) duration.textContent = fmtDuration(remaining);
    const fill = card.querySelector(".task-mini-progress .fill");
    if (fill && task.total_seconds) {
      fill.style.width = `${clamp(((task.total_seconds - remaining) / task.total_seconds) * 100, 0, 100)}%`;
    }
    const tile = card.querySelector(".tile-ring .val");
    if (tile && task.total_seconds) {
      // Read the dash array straight off the ring so the maths stays correct
      // even if the tile radius is restyled by a theme.
      const circumference = Number(tile.getAttribute("stroke-dasharray")) || 2 * Math.PI * 30;
      tile.setAttribute("stroke-dashoffset", String(circumference * (1 - (task.total_seconds - remaining) / task.total_seconds)));
    }
  }
}

/* --------------------------------------------------------------------------
   Day controls
   -------------------------------------------------------------------------- */
export function initDayControls() {
  byId("dayPrev")?.addEventListener("click", () => shiftDay(-1));
  byId("dayNext")?.addEventListener("click", () => shiftDay(1));

  byId("finishDayBtn")?.addEventListener("click", finishDayFlow);
  byId("reopenDayBtn")?.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "Reopen the previous day?",
      text: "The current day counter goes back by one so you can finish what was left.",
      okLabel: "Reopen",
      danger: false,
    });
    if (!ok) return;
    await ensureCalendarAnchor();
    const result = await api.reopenDay();
    if (result?.result?.error) {
      toast(result.result.error, { tone: "warn" });
      return;
    }
    toast("Moved back a day", { tone: "good" });
    await refresh();
  });

  byId("addDayBtn")?.addEventListener("click", async () => {
    // "Insert day" nudges the current task set forward by one virtual day and
    // leaves the freed day empty — handy when a day gets disrupted.
    const current = store.settingNum("current_day_index", 1);
    const open = tasksForDay(current).filter((task) => !task.done);
    if (!open.length) {
      toast("Nothing open to shift", { tone: "info" });
      return;
    }
    const ok = await confirmAction({
      title: "Insert an empty day?",
      text: `All ${open.length} open task(s) from day ${current} move to day ${current + 1}, leaving today clear.`,
      okLabel: "Insert day",
      danger: false,
    });
    if (!ok) return;
    for (const task of open) {
      await api.moveTask(task.id, current + 1);
    }
    toast(`Day ${current} cleared — open work moved to day ${current + 1}`, { tone: "good" });
    await refresh();
  });

  byId("startFocusBtn")?.addEventListener("click", () => {
    emit("switch-tab", { tab: "focus" });
    emit("timer-command", { action: "toggle" });
  });
}

export async function shiftDay(delta) {
  const current = store.settingNum("current_day_index", 1);
  const next = Math.max(1, current + delta);
  try {
    // Jumping the counter without finishing the day keeps the data honest:
    // we only move tasks when the user explicitly finishes a day. Persist the
    // initial date anchor first so virtual-date mappings remain stable.
    const settings = { current_day_index: next };
    if (!store.setting("calendar_start_date", "")) settings.calendar_start_date = formatCalendarDate(calendarAnchorDate());
    await api.settings(settings);
    await refresh();
    emit("day-changed", { day: next });
    toast(`Day ${next} — ${dayLabel(next)}`, { tone: "info", timeout: 1800 });
  } catch (error) {
    toast(error.message || "Could not change the day", { tone: "error" });
  }
}

export async function finishDayFlow() {
  const current = store.settingNum("current_day_index", 1);
  const totals = totalsForDay(current);
  const carry = store.setting("carry_over", "always");

  const data = await formDialog({
    title: `Finish day ${current}`,
    eyebrow: totals.open ? `${totals.open} task(s) still open` : "Everything is done 🎉",
    fields: [
      {
        name: "carry",
        label: "Open tasks",
        type: "select",
        value: carry,
        options: [
          { value: "always", label: "Move them to the next day" },
          { value: "never", label: "Leave them behind on this day" },
        ],
      },
      {
        name: "mood",
        label: "How did the day feel?",
        type: "select",
        value: "ok",
        options: [
          { value: "great", label: "🙌 great" },
          { value: "good", label: "🙂 good" },
          { value: "ok", label: "😐 ok" },
          { value: "rough", label: "😕 rough" },
          { value: "awful", label: "😩 awful" },
        ],
      },
      { name: "note", label: "One line about today", type: "text", placeholder: "What worked, what to change…" },
    ],
    submitLabel: `Move to day ${current + 1}`,
  });
  if (!data) return;

  try {
    await ensureCalendarAnchor();
    const result = await api.finishDay({ carry: data.carry, mood: data.mood, note: data.note });
    const moved = result?.result?.carried ?? 0;
    toast(
      `Day ${current} closed · ${moved} task(s) carried to day ${result?.next_day ?? current + 1}`,
      { tone: "good", timeout: 5200 },
    );
    if (data.mood === "great" || totals.open === 0) celebrate(24);
    await refresh();
  } catch (error) {
    toast(error.message || "Could not finish the day", { tone: "error" });
  }
}

/* --------------------------------------------------------------------------
   Refresh hook
   -------------------------------------------------------------------------- */
let refresh = async () => {};
export function provideRefresh(fn) {
  refresh = fn;
}
