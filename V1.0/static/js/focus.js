/* ==========================================================================
   TaskArcade — focus engine
   A full pomodoro runner that is also the app's only clock. It owns:
     * phase sequencing  (focus → short break → … → long break)
     * the countdown that deducts time from the active task
     * idle detection and automatic pausing
     * gating on the external work/free mode
     * session persistence (resumes after a reload using wall-clock time)
     * chimes (generated with WebAudio — no asset files) and notifications
   ========================================================================== */

import {
  byId, h, icon, clear, store, emit, on, prefs, clamp, fmtClock, fmtDuration,
  activeTask, tasksForDay, openTasksForDay, dayLabel, relativeTime, formatNumber,
} from "./core.js";
import { api } from "./api.js";
import { toast, celebrate } from "./ui.js";

const t = (value) => window.TaskArcadeI18n?.t?.(value) ?? value;

const STORAGE_KEY = "taskarcade.timer.v1";
const TICK_MS = 500;
const PERSIST_EVERY_MS = 5000;

const PHASES = {
  idle: { label: "idle", ring: "idle" },
  focus: { label: "focus", ring: "focus" },
  break: { label: "short break", ring: "break" },
  longbreak: { label: "long break", ring: "break" },
};

/** Runtime timer state — single source of truth for every countdown. */
export const timer = {
  phase: "idle",
  running: false,
  remaining: 0,
  planned: 0,
  cyclesDone: 0,
  taskId: null,
  sessionId: null,
  endAt: null,
  pausedReason: "",
  spentInPhase: 0,
  lastPersisted: 0,
  notifiedKeys: new Set(),
};

let refresh = async () => {};
let externalMode = null;
let externalSessionId = null;
let idleSince = Date.now();
let tickHandle = null;
let reminderHandle = null;
let audioContext = null;

export function provideRefresh(fn) {
  refresh = fn;
}

/* --------------------------------------------------------------------------
   Preferences → seconds
   -------------------------------------------------------------------------- */
function focusSeconds() {
  return clamp(store.settingNum("pomodoro_focus", 25), 1, 180) * 60;
}
function breakSeconds() {
  return clamp(store.settingNum("pomodoro_break", 5), 1, 60) * 60;
}
function longBreakSeconds() {
  return clamp(store.settingNum("pomodoro_long_break", 15), 1, 120) * 60;
}
function cyclesBeforeLong() {
  return clamp(store.settingNum("pomodoro_cycles", 4), 1, 12);
}
function countMode() {
  return prefs.get("countMode", null) || store.setting("count_mode", "focus");
}
function idleLimit() {
  return clamp(prefs.get("idleSeconds", null) || store.settingNum("idle_seconds", 180), 30, 3600);
}

/* --------------------------------------------------------------------------
   Persistence
   -------------------------------------------------------------------------- */
function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        phase: timer.phase,
        running: timer.running,
        remaining: timer.remaining,
        planned: timer.planned,
        cyclesDone: timer.cyclesDone,
        taskId: timer.taskId,
        sessionId: timer.sessionId,
        endAt: timer.endAt,
        savedAt: Date.now(),
        spentInPhase: timer.spentInPhase,
      }),
    );
  } catch (error) {
    console.warn("[focus] could not persist timer", error);
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.phase) return false;
    Object.assign(timer, {
      phase: saved.phase,
      running: !!saved.running,
      remaining: Number(saved.remaining) || 0,
      planned: Number(saved.planned) || focusSeconds(),
      cyclesDone: Number(saved.cyclesDone) || 0,
      taskId: saved.taskId || null,
      sessionId: saved.sessionId || null,
      spentInPhase: Number(saved.spentInPhase) || 0,
    });
    if (saved.running && saved.endAt) {
      const drift = Math.round((Date.now() - saved.endAt) / 1000);
      timer.remaining = Math.max(0, Math.round((saved.endAt - Date.now()) / 1000));
      if (drift > 0) timer.remaining = 0;
      timer.endAt = saved.endAt;
    }
    return true;
  } catch (error) {
    console.warn("[focus] could not restore timer", error);
    return false;
  }
}

/* --------------------------------------------------------------------------
   Audio & notifications
   -------------------------------------------------------------------------- */
function chime(kind = "focus") {
  const enabled = prefs.get("sound", true) && store.setting("sound", 1) === 1;
  if (!enabled) return;
  const volume = clamp(Number(prefs.get("volume", 0.5)), 0, 1);
  if (volume <= 0) return;

  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    const now = audioContext.currentTime;
    const notes = kind === "break" ? [523.25, 659.25] : kind === "complete" ? [659.25, 783.99, 1046.5] : [880, 1174.66];
    notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const start = now + index * 0.16;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume * 0.5, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.45);
    });
  } catch (error) {
    console.warn("[focus] chime failed", error);
  }
}

function notify(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!prefs.get("notify", false) && store.setting("notifications", 0) !== 1) return;
  try {
    new Notification(title, { body, silent: true, tag: "taskarcade" });
  } catch (error) {
    console.warn("[focus] notification failed", error);
  }
}

export async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    toast("This browser has no notification support", { tone: "warn" });
    return false;
  }
  const permission = await Notification.requestPermission();
  const granted = permission === "granted";
  prefs.set("notify", granted);
  toast(granted ? "Notifications enabled" : "Notifications were blocked", { tone: granted ? "good" : "warn" });
  return granted;
}

/* --------------------------------------------------------------------------
   Phase control
   -------------------------------------------------------------------------- */
export function startPhase(phase, { taskId = null, planned = null, auto = false } = {}) {
  const duration = planned ?? (phase === "focus" ? focusSeconds() : phase === "break" ? breakSeconds() : longBreakSeconds());
  timer.phase = phase;
  timer.planned = duration;
  timer.remaining = duration;
  timer.spentInPhase = 0;
  timer.taskId = taskId ?? timer.taskId ?? activeTask()?.id ?? null;
  timer.endAt = Date.now() + duration * 1000;
  timer.running = true;
  timer.pausedReason = "";
  persist();
  emit("timer", { timer: snapshot(), event: auto ? "auto-start" : "start" });
  logSessionStart(phase);
  return timer;
}

async function logSessionStart(phase) {
  if (!timer.taskId && phase === "focus") {
    const task = activeTask();
    timer.taskId = task?.id ?? null;
  }
  const kind = phase === "focus" ? "focus" : "break";
  try {
    const result = await api.startSession(timer.taskId || 0, kind, timer.planned);
    timer.sessionId = result?.result?.id ?? null;
    persist();
  } catch (error) {
    console.warn("[focus] could not log session start", error);
  }
}

export function pause(reason = "manual") {
  if (!timer.running) return;
  timer.running = false;
  timer.pausedReason = reason;
  timer.remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
  timer.endAt = null;
  persist();
  emit("timer", { timer: snapshot(), event: "pause", reason });
  if (reason === "idle") {
    toast("Paused — you have been away for a while", { tone: "warn", timeout: 4200 });
  }
}

export function resume() {
  if (timer.running) return;
  if (timer.phase === "idle") {
    startPhase("focus");
    return;
  }
  if (timer.remaining <= 0) {
    timer.remaining = timer.planned;
  }
  timer.endAt = Date.now() + timer.remaining * 1000;
  timer.running = true;
  timer.pausedReason = "";
  persist();
  emit("timer", { timer: snapshot(), event: "resume" });
}

export function stop({ completed = false, silent = false } = {}) {
  const phase = timer.phase;
  const spent = Math.round(timer.spentInPhase);
  const sessionId = timer.sessionId;
  const taskId = timer.taskId;

  if (sessionId) {
    api.endSession(sessionId, spent, completed, taskId).catch((error) => {
      console.warn("[focus] could not close session", error);
    });
  }

  timer.running = false;
  timer.phase = "idle";
  timer.remaining = 0;
  timer.planned = 0;
  timer.endAt = null;
  timer.sessionId = null;
  timer.spentInPhase = 0;
  persist();
  emit("timer", { timer: snapshot(), event: "stop", phase, spent });
  if (!silent && spent > 0) {
    toast(`${phase === "focus" ? "Focus" : "Break"} logged: ${fmtDuration(spent)}`, { tone: "good" });
  }
  refresh();
}

export function skipPhase() {
  if (timer.phase === "focus") {
    finishPhase({ skipped: true });
  } else {
    startPhase("focus", { auto: true });
  }
}

/* --------------------------------------------------------------------------
   Phase completion
   -------------------------------------------------------------------------- */
async function finishPhase({ skipped = false } = {}) {
  const finished = timer.phase;
  const spent = Math.round(timer.spentInPhase);
  const sessionId = timer.sessionId;
  const taskId = timer.taskId;
  const autoStart = store.setting("pomodoro_auto_start", 1) === 1;

  if (finished === "focus") timer.cyclesDone += 1;

  if (sessionId) {
    api.endSession(sessionId, spent, !skipped, taskId).catch((error) => {
      console.warn("[focus] could not close session", error);
    });
  }

  if (finished === "focus" && taskId) {
    const task = (store.get("tasks", []) || []).find((item) => item.id === taskId);
    if (task) {
      const autoDone = store.setting("auto_done", 1) === 1;
      if (task.remaining_seconds <= 0 && autoDone) {
        await api.doneTask(taskId, true).catch(() => null);
        celebrate(22);
        chime("complete");
        notify("Task complete 🎉", task.title);
        toast(`“${task.title}” finished`, { tone: "good" });
      } else {
        const next = (store.get("tasks", []) || []).find((item) => item.id === taskId && !item.done);
        if (next) {
          notify("Focus block done", `Next up: ${next.title}`);
          toast("Focus block complete — take the break", {
            tone: "good",
            action: { label: "Skip break", run: () => startPhase("focus", { auto: true }) },
          });
        }
      }
    }
    await refresh();
  }

  if (finished !== "focus") {
    chime("focus");
    notify("Break over", "Time to focus again.");
    if (autoStart) startPhase("focus", { auto: true });
    else {
      timer.phase = "idle";
      timer.remaining = 0;
      emit("timer", { timer: snapshot(), event: "idle" });
    }
    return;
  }

  chime("break");
  const longDue = timer.cyclesDone % cyclesBeforeLong() === 0;
  const nextPhase = longDue ? "longbreak" : "break";
  if (autoStart) {
    startPhase(nextPhase, { auto: true, taskId: null });
  } else {
    timer.phase = "idle";
    timer.remaining = 0;
    timer.running = false;
    persist();
    emit("timer", { timer: snapshot(), event: "awaiting-break" });
  }
}

/* --------------------------------------------------------------------------
   The tick
   -------------------------------------------------------------------------- */
function tick() {
  if (!timer.running) {
    if (shouldRunFreely()) {
      timer.endAt = Date.now() + (timer.remaining || focusSeconds()) * 1000;
      timer.planned = timer.planned || focusSeconds();
      timer.phase = timer.phase === "idle" ? "focus" : timer.phase;
      timer.running = true;
      emit("timer", { timer: snapshot(), event: "free-run" });
    } else {
      return;
    }
  }

  const remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
  const delta = timer.remaining - remaining;
  timer.remaining = remaining;
  if (delta > 0) consume(delta);

  renderTimerUI();

  if (remaining <= 0) {
    finishPhase({});
  }
}

/** In "always" mode the clock runs by itself whenever the page is open. */
function shouldRunFreely() {
  return countMode() === "always" && (timer.phase === "idle" || timer.phase === "focus");
}

/** In focus mode the clock stops when the external service says "free". */
function gatedByExternalMode() {
  if (countMode() !== "focus") return false;
  return externalMode === "free";
}

/** Consume `delta` seconds from the active task and mirror it in the DOM. */
function consume(delta) {
  if (timer.phase !== "focus" && countMode() !== "always") return;
  const taskId = timer.taskId || activeTask()?.id;
  if (!taskId) return;
  const task = (store.get("tasks", []) || []).find((item) => item.id === taskId);
  if (!task || task.done) return;

  timer.spentInPhase += delta;
  const amount = countMode() === "always" ? delta : delta;
  task.remaining_seconds = Math.max(0, task.remaining_seconds - amount);
  task.elapsed_seconds = Math.max(0, Number(task.total_seconds || 0) - task.remaining_seconds);
  task.focus_seconds = (task.focus_seconds || 0) + delta;
  emit("task-tick", { taskId, remaining: task.remaining_seconds, focusSeconds: task.focus_seconds, task });

  const now = Date.now();
  if (now - timer.lastPersisted > PERSIST_EVERY_MS) {
    timer.lastPersisted = now;
    api.tickTask(taskId, task.remaining_seconds, delta).catch(() => null);
  }
}

/* --------------------------------------------------------------------------
   Idle handling
   -------------------------------------------------------------------------- */
function markActivity() {
  idleSince = Date.now();
  if (timer.pausedReason === "idle" && timer.running === false && countMode() !== "off") {
    // User is back: stay paused, but clear the banner so the UI invites a resume.
    timer.pausedReason = "";
    emit("timer", { timer: snapshot(), event: "back" });
  }
}

function checkIdle() {
  if (!timer.running) return;
  if (countMode() === "off") return;
  if (document.visibilityState === "hidden") return;
  const idleFor = (Date.now() - idleSince) / 1000;
  if (idleFor >= idleLimit()) pause("idle");
}

export function initIdleWatchers() {
  ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"].forEach((type) => {
    window.addEventListener(type, markActivity, { passive: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      markActivity();
      // Catch up after the tab was hidden — never count hidden time as focus.
      if (timer.running && timer.endAt) {
        timer.remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
      }
    }
  });
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */
export function snapshot() {
  return {
    phase: timer.phase,
    running: timer.running,
    remaining: timer.remaining,
    planned: timer.planned,
    cyclesDone: timer.cyclesDone,
    taskId: timer.taskId,
    pausedReason: timer.pausedReason,
  };
}

export function renderTimerUI() {
  const phase = timer.phase;
  const focusRadius = 104;
  const circumference = 2 * Math.PI * focusRadius;
  const ring = byId("focusRing");
  const timeLabel = byId("focusTime");
  const modeLabel = byId("focusMode");
  const phaseLabel = byId("focusPhaseLabel");
  const badge = byId("focusTabBadge");
  const dot = byId("focusDot");

  const fraction = timer.planned > 0 ? clamp(timer.remaining / timer.planned, 0, 1) : 0;
  const secondsLeft = timer.running || timer.phase !== "idle" ? timer.remaining : timer.remaining;

  if (ring) {
    ring.style.strokeDasharray = String(circumference);
    ring.style.strokeDashoffset = String(circumference * (1 - fraction));
    ring.style.stroke = phase === "break" || phase === "longbreak" ? "var(--good)" : phase === "idle" ? "var(--text-faint)" : "url(#ringGradient)";
  }
  if (dot && fraction > 0) {
    const angle = (1 - fraction) * 360;
    dot.style.transform = `rotate(${angle}deg)`;
  }
  if (timeLabel) {
    timeLabel.textContent = timer.phase === "idle" && !timer.running
      ? fmtClock(focusSeconds())
      : fmtClock(secondsLeft);
  }
  if (modeLabel) {
    if (timer.phase === "idle") modeLabel.textContent = timer.pausedReason === "idle" ? t("paused (idle)") : t("ready");
    else if (timer.running) modeLabel.textContent = t(PHASES[timer.phase]?.label || "running");
    else modeLabel.textContent = `${t("paused")} · ${t(PHASES[timer.phase]?.label || "")}`;
  }
  if (phaseLabel) {
    const set = Math.floor(timer.cyclesDone / cyclesBeforeLong()) + 1;
    phaseLabel.textContent = timer.phase === "idle"
      ? t("Focus session")
      : timer.phase === "focus"
        ? `${t("Focus block")} · ${t("set")} ${formatNumber(set)}`
        : t(PHASES[timer.phase].label);
  }
  if (badge) {
    if (timer.phase === "idle" && !timer.running) badge.hidden = true;
    else {
      badge.hidden = false;
      badge.textContent = fmtClock(timer.remaining);
    }
  }

  renderCycleDots();
  renderFocusButtons();
  renderFocusTaskCard();
}

function renderCycleDots() {
  const holder = byId("cycleDots");
  if (!holder) return;
  const total = cyclesBeforeLong();
  clear(holder);
  const doneInSet = timer.cyclesDone % total;
  for (let index = 0; index < total; index += 1) {
    const isDone = index < doneInSet || (timer.cyclesDone > 0 && doneInSet === 0 && timer.phase !== "idle" && false);
    const isCurrent = timer.phase === "focus" && index === doneInSet;
    holder.appendChild(h("i", { class: `${isDone ? "is-done " : ""}${isCurrent ? "is-current" : ""}`.trim() }));
  }
}

function renderFocusButtons() {
  const start = byId("focusStartBtn");
  const pauseBtn = byId("focusPauseBtn");
  const breakBtn = byId("focusBreakBtn");
  if (start) {
    start.hidden = timer.running;
    start.innerHTML = "";
    start.append(icon("play"), document.createTextNode(` ${t(timer.phase === "idle" ? "Start focus" : "Resume")}`));
  }
  if (pauseBtn) pauseBtn.hidden = !timer.running;
  if (breakBtn) {
    const onBreak = timer.phase === "break" || timer.phase === "longbreak";
    breakBtn.innerHTML = "";
    breakBtn.append(icon(onBreak ? "play" : "coffee"), document.createTextNode(` ${t(onBreak ? "Back to focus" : "Break")}`));
  }
}

function renderFocusTaskCard() {
  const title = byId("focusTaskTitle");
  const meta = byId("focusTaskMeta");
  const fill = byId("focusTaskFill");
  if (!title || !meta) return;
  const task = (store.get("tasks", []) || []).find((item) => item.id === timer.taskId) || activeTask();
  if (!task) {
    title.textContent = t("No task selected");
    meta.textContent = t("Pick something from the ranked queue to begin.");
    if (fill) fill.style.width = "0%";
    return;
  }
  title.textContent = task.title;
  meta.textContent = `${dayLabel(task.day_index)} · ${fmtDuration(task.remaining_seconds)} ${t("left of")} ${fmtDuration(task.total_seconds)}${task.tag ? ` · #${store.tag(task.tag)?.label || task.tag}` : ""}`;
  const progress = task.total_seconds ? (Number(task.elapsed_seconds ?? (task.total_seconds - task.remaining_seconds)) / task.total_seconds) * 100 : 0;
  if (fill) fill.style.width = `${clamp(progress, 0, 100)}%`;
}

export function renderFocusFacts() {
  const stats = store.meta?.stats || {};
  const current = store.settingNum("current_day_index", 1);
  const dayTasks = tasksForDay(current);
  const focused = dayTasks.reduce((sum, task) => sum + Number(task.focus_seconds || 0), 0);
  const sessions = (store.get("sessions", []) || []).filter((session) => session.kind === "focus");
  const longest = sessions.reduce((max, session) => Math.max(max, session.seconds || 0), 0);

  const set = (id, value) => {
    const node = byId(id);
    if (node) node.textContent = value;
  };
  set("focusFactToday", fmtDuration(focused));
  set("focusFactSessions", String(sessions.length));
  set("focusFactLongest", fmtDuration(longest));
  set("focusFactPomos", String(Math.round((stats.focus_seconds || focused) / (focusSeconds() || 1500))));
  set("focusFactIdle", countMode() === "off" ? "off" : `${idleLimit()}s`);
}

export function renderFocusQueue() {
  const holder = byId("focusQueue");
  if (!holder) return;
  const queue = store.get("focusQueue", null) || openTasksForDay(store.settingNum("current_day_index", 1));
  const sorted = (store.get("queue", null) || queue).slice().sort((a, b) => (b.focus_score || 0) - (a.focus_score || 0));
  clear(holder);
  const pill = byId("queuePill");
  if (pill) pill.textContent = `${formatNumber(sorted.length)} ${t("ready")}`;
  if (!sorted.length) {
    holder.appendChild(h("li", { class: "queue-title" }, t("Nothing open — enjoy the space.")));
    return;
  }
  sorted.slice(0, 12).forEach((task, index) => {
    const isCurrent = timer.taskId === task.id || (!timer.taskId && index === 0);
    holder.appendChild(
      h("li", { class: isCurrent ? "is-current" : "" }, [
        h("span", { class: "queue-rank" }, String(index + 1)),
        h("span", { class: "queue-title" }, [
          task.title,
          task.tag ? h("span", { class: "tag-pill", style: { "--tag-color": store.tagColor(task.tag) } }, `#${store.tag(task.tag)?.label || task.tag}`) : null,
        ]),
        h("span", { class: "queue-score" }, fmtDuration(task.remaining_seconds)),
      ]),
    );
    const node = holder.lastElementChild;
    node.style.cursor = "pointer";
    node.addEventListener("click", () => selectTask(task.id, { start: true }));
  });
}

export function renderSessionLog() {
  const holder = byId("sessionList");
  if (!holder) return;
  const sessions = (store.get("sessions", []) || []).slice(0, 20);
  clear(holder);
  if (!sessions.length) {
    holder.appendChild(h("li", { class: "session-item" }, "No sessions logged yet."));
    return;
  }
  sessions.forEach((session) => {
    const task = (store.get("tasks", []) || []).find((item) => item.id === session.task_id);
    holder.appendChild(
      h("li", { class: "session-item" }, [
        h("span", { class: `session-kind ${session.kind}` }, session.kind),
        h("span", { class: "session-title" }, task ? task.title : t(session.completed ? "completed" : "abandoned")),
        h("span", { class: "session-seconds" }, `${fmtDuration(session.seconds)} · ${relativeTime(session.started_at)}`),
      ]),
    );
  });
}

/* --------------------------------------------------------------------------
   Task selection
   -------------------------------------------------------------------------- */
export function selectTask(taskId, { start = false } = {}) {
  const task = (store.get("tasks", []) || []).find((item) => item.id === Number(taskId));
  if (!task) return;
  timer.taskId = task.id;
  persist();
  renderFocusTaskCard();
  renderFocusQueue();
  emit("timer", { timer: snapshot(), event: "select-task" });
  if (start && !timer.running) {
    startPhase(timer.phase === "idle" ? "focus" : timer.phase, { taskId: task.id, auto: false });
  } else if (start && timer.running) {
    toast(`Focusing “${task.title}”`, { tone: "info" });
  }
}

/* --------------------------------------------------------------------------
   Reminders
   -------------------------------------------------------------------------- */
async function pollReminders() {
  const window_ = clamp(Number(prefs.get("reminderWindow", 60)) || 60, 5, 1440);
  try {
    const data = await api.reminders(window_);
    const reminders = data?.reminders || [];
    (reminders || []).forEach((item) => {
      const key = `${item.id}:${item.reminder_at}`;
      if (timer.notifiedKeys.has(key)) return;
      timer.notifiedKeys.add(key);
      const when = item.due_in_seconds <= 0 ? t("due now") : t(`in ${fmtDuration(Math.max(0, item.due_in_seconds))}`);
      toast(`${item.title} — ${when}`, { tone: "warn", timeout: 6000 });
      notify("Task reminder", `${item.title} · ${when}`);
      emit("reminder", { task: item });
    });
    renderReminders(reminders);
  } catch (error) {
    /* reminders are best-effort */
  }
}

function renderReminders(reminders) {
  const panel = byId("remindersPanel");
  const list = byId("reminderList");
  if (!panel || !list) return;
  if (!reminders?.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  clear(list);
  reminders.forEach((item) => {
    list.appendChild(
      h("li", { class: "reminder-item" }, [
        icon("bell"),
        h("span", { class: "grow user-content" }, item.title),
        h("span", {}, item.due_in_seconds <= 0 ? t("now") : t(`in ${fmtDuration(Math.max(0, item.due_in_seconds))}`)),
        h("button", {
          class: "icon-btn icon-btn-sm",
          type: "button",
          title: "Start this task",
          onclick: () => selectTask(item.id, { start: true }),
        }, icon("play")),
      ]),
    );
  });
}

/* --------------------------------------------------------------------------
   External work/free bridge
   -------------------------------------------------------------------------- */
async function pollExternal() {
  const base = (store.setting("server_url", "") || "").trim();
  const pill = byId("syncPill");
  const detail = byId("syncDetail");
  if (!base) {
    externalMode = null;
    if (pill) {
      pill.textContent = t("not configured");
      pill.className = "pill";
    }
    if (detail) detail.textContent = t("Countdowns follow your local timer rules.");
    return;
  }
  try {
    const data = await api.externalState();
    const kind = data?.session?.current?.kind;
    if (kind === "work" || kind === "free") {
      externalMode = kind;
      if (pill) {
        pill.textContent = t(kind);
        pill.className = `pill ${kind === "work" ? "pill-good" : "pill-accent"}`;
      }
      if (detail) detail.textContent = t(kind === "work" ? "External service says: working" : "External service says: free time — countdown paused");
      if (kind === "free" && timer.running && countMode() === "focus") {
        pause("external");
      }
    }
    const sid = data?.sessions?.[0]?.id;
    if (sid) {
      externalSessionId = sid;
      prefs.set("externalSession", sid);
    }
  } catch (error) {
    if (pill) {
      pill.textContent = t("unreachable");
      pill.className = "pill pill-warn";
    }
    if (detail) detail.textContent = t("Could not reach the configured service.");
  }
}

export async function toggleExternalMode() {
  const base = (store.setting("server_url", "") || "").trim();
  if (!base) {
    toast("Add an external server URL in Settings → Sync", { tone: "warn" });
    openSettingsPane("sync");
    return;
  }
  const sessionId = externalSessionId || prefs.get("externalSession", null);
  if (!sessionId) {
    toast("Waiting for the next sync poll…", { tone: "warn" });
    return;
  }
  const next = externalMode === "work" ? "free" : "work";
  try {
    await api.externalMode(next, sessionId);
    externalMode = next;
    toast(`Switched to ${next} mode`, { tone: "good" });
  } catch (error) {
    toast("Could not switch the external mode", { tone: "error" });
  }
}

function openSettingsPane(pane) {
  emit("open-settings", { pane });
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */
export function initFocusEngine() {
  restore();
  if (timer.running && gatedByExternalMode()) timer.running = false;

  markActivity();
  initIdleWatchers();

  tickHandle = window.setInterval(() => {
    tick();
    checkIdle();
  }, TICK_MS);

  reminderHandle = window.setInterval(pollReminders, 60000);
  window.setTimeout(pollReminders, 2500);
  window.setInterval(pollExternal, 10000);
  window.setTimeout(pollExternal, 1200);

  byId("focusStartBtn")?.addEventListener("click", () => {
    if (timer.phase === "idle") startPhase("focus");
    else resume();
  });
  byId("focusPauseBtn")?.addEventListener("click", () => pause("manual"));
  byId("focusStopBtn")?.addEventListener("click", () => stop({}));
  byId("focusBreakBtn")?.addEventListener("click", () => {
    if (timer.phase === "break" || timer.phase === "longbreak") startPhase("focus", { auto: true });
    else startPhase("break", { taskId: null, auto: true });
  });
  byId("focusPickTask")?.addEventListener("click", () => {
    emit("switch-tab", { tab: "today" });
    window.setTimeout(() => byId("taskList")?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
  });
  byId("focusDoneBtn")?.addEventListener("click", async () => {
    const task = (store.get("tasks", []) || []).find((item) => item.id === timer.taskId) || activeTask();
    if (!task) return;
    await api.doneTask(task.id, true);
    if (timer.phase === "focus") finishPhase({ skipped: true });
    await refresh();
  });

  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  byId("clearSessionsBtn")?.addEventListener("click", () => refresh());

  // Keyboard / palette actions
  on("timer-command", ({ action }) => {
    if (action === "toggle") {
      if (timer.running) pause("manual");
      else if (timer.phase === "idle") startPhase("focus");
      else resume();
    } else if (action === "stop") stop({});
    else if (action === "break") startPhase("break", { taskId: null, auto: true });
    else if (action === "skip") skipPhase();
  });

  on("focus-task", ({ taskId }) => selectTask(taskId, { start: true }));
  on("state", () => {
    renderTimerUI();
    renderFocusFacts();
    renderFocusQueue();
    renderSessionLog();
  });
  on("switch-tab", () => renderTimerUI());

  // Persist before unload so a reload resumes exactly where the user was.
  window.addEventListener("beforeunload", () => {
    persist();
    const taskId = timer.taskId;
    if (taskId && timer.running) {
      const task = (store.get("tasks", []) || []).find((item) => item.id === taskId);
      if (task && navigator.sendBeacon) {
        const payload = new Blob([JSON.stringify({ remaining_seconds: task.remaining_seconds })], {
          type: "application/json",
        });
        navigator.sendBeacon(`/api/tasks/${taskId}/tick`, payload);
      }
    }
  });

  renderTimerUI();
}

export function applyPreset(preset) {
  const presets = {
    classic: { focus: 25, short: 5, long: 15, cycles: 4 },
    deep: { focus: 50, short: 10, long: 25, cycles: 3 },
    sprint: { focus: 15, short: 3, long: 10, cycles: 5 },
  };
  if (preset === "custom") {
    emit("toast", { message: "Set your own numbers in Settings → Timer", tone: "info" });
    openSettingsPane("focus");
    return;
  }
  const config = presets[preset];
  if (!config) return;
  api
    .settings({
      pomodoro_focus: config.focus,
      pomodoro_break: config.short,
      pomodoro_long_break: config.long,
      pomodoro_cycles: config.cycles,
    })
    .then(() => refresh())
    .then(() => {
      if (timer.phase === "idle") {
        timer.planned = config.focus * 60;
        timer.remaining = config.focus * 60;
        renderTimerUI();
      }
      toast(`Preset: ${config.focus}/${config.short} min`, { tone: "good" });
    });
}

export function timerValue() {
  return snapshot();
}
