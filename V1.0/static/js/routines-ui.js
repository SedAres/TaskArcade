/* ==========================================================================
   TaskArcade — routine library and mobile-first guided runner
   ========================================================================== */

import { $, byId, h, icon, clear, store, emit, on, fmtDuration, formatNumber, calendarDayLabel } from "./core.js";
import { api } from "./api.js";
import { initDragAndDrop } from "./dnd.js";
import { openSheet, closeSheet, confirmAction, toast } from "./ui.js";

const t = (value) => window.TaskArcadeI18n?.t?.(value) ?? value;
let initialized = false;
let ticker = null;
let runDeadline = null;
let runClockStamp = "";
let expiredStepKey = "";
let transitionInFlight = false;
let wakeLock = null;

function settingEnabled(key, fallback = true) {
  const value = store.setting(key, fallback ? 1 : 0);
  return value === true || Number(value) === 1;
}

function routines() {
  return store.get("routines", []) || [];
}

function activeRun() {
  return store.get("active_routine_run", null);
}

function updateStoreFromRoutineResponse(data) {
  if (!data) return;
  store.set({
    routines: data.routines ?? store.get("routines", []),
    active_routine_run: data.active_routine_run ?? null,
    routine_runs: data.routine_runs ?? store.get("routine_runs", []),
  });
}

async function reloadRoutineState() {
  const data = await api.routines(false);
  updateStoreFromRoutineResponse(data);
  return data;
}

function formatCountdown(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  const text = `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return formatNumber(text);
}

function countdownRemaining(run = activeRun()) {
  if (!run) return 0;
  if (run.status !== "running" || !runDeadline) return Math.max(0, Number(run.remaining_seconds) || 0);
  return Math.max(0, Math.ceil((runDeadline - Date.now()) / 1000));
}

function configureRunClock(run) {
  if (!run || run.status !== "running") {
    runDeadline = null;
    runClockStamp = run ? `${run.id}:${run.current_step_index}:${run.status}:${run.updated_at}` : "";
    return;
  }
  const stamp = `${run.id}:${run.current_step_index}:${run.updated_at}:${run.remaining_seconds}`;
  if (stamp !== runClockStamp) {
    runClockStamp = stamp;
    runDeadline = Date.now() + Math.max(0, Number(run.remaining_seconds) || 0) * 1000;
    expiredStepKey = "";
  }
}

function progressPercent(elapsed, planned) {
  if (!planned) return 0;
  return Math.max(0, Math.min(100, (Number(elapsed || 0) / Number(planned)) * 100));
}

function currentStepProgress(run, remaining = countdownRemaining(run)) {
  const step = run?.current_step;
  if (!step) return 0;
  const length = Number(step.duration_seconds) || 0;
  return progressPercent(length - remaining, length);
}

function setBar(node, percent) {
  if (node) node.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
}

function renderRunner() {
  const panel = byId("routineRunnerPanel");
  if (!panel) return;
  const run = activeRun();
  clear(panel);
  configureRunClock(run);

  if (!run) {
    panel.appendChild(h("div", { class: "routine-runner-empty" }, [
      h("div", { class: "routine-runner-empty-icon", "aria-hidden": "true" }, icon("play")),
      h("div", {}, [
        h("span", { class: "eyebrow" }, t("Ready when you are")),
        h("h2", {}, t("Start a routine to open the guided runner")),
        h("p", {}, t("Your current step, countdown, progress, and next step will stay together here.")),
      ]),
      h("span", { class: "routine-runner-empty-hint" }, t("Choose a routine below")),
    ]));
    syncWakeLock(null);
    return;
  }

  const steps = run.steps || [];
  const statuses = run.step_statuses || [];
  const step = run.current_step || steps[run.current_step_index] || null;
  const index = Math.max(0, Number(run.current_step_index) || 0);
  const nextIndex = statuses.findIndex((status, stepIndex) => stepIndex > index && status === "pending");
  const next = nextIndex >= 0 ? steps[nextIndex] : null;
  const remaining = countdownRemaining(run);
  const duration = Number(step?.duration_seconds) || 0;
  const stepProgress = currentStepProgress(run, remaining);
  const elapsedNow = Math.max(0, Number(run.elapsed_seconds) || 0) + Math.max(0, Number(run.remaining_seconds) - remaining);
  const overall = progressPercent(elapsedNow, run.planned_seconds);
  const remainingTotal = remaining + (steps.reduce((sum, item, stepIndex) => {
    return sum + (stepIndex > index && statuses[stepIndex] === "pending" ? Number(item.duration_seconds) || 0 : 0);
  }, 0));
  const statusLabel = run.status === "paused" ? t("Paused") : t("In progress");
  const definition = routines().find((item) => item.id === run.routine_id);

  const header = h("header", { class: "routine-runner-header" }, [
    h("div", { class: "routine-runner-title" }, [
      h("span", { class: "routine-runner-emoji", style: { "--routine-color": definition?.color || "var(--accent)" } }, definition?.emoji || "✨"),
      h("div", {}, [
        h("span", { class: "eyebrow" }, [t("Guided runner"), h("span", { class: "runner-status-pill" }, statusLabel)]),
        h("h2", { class: "routine-title" }, run.name),
      ]),
    ]),
    h("button", {
      class: "btn btn-quiet btn-sm routine-stop-btn",
      type: "button",
      onclick: () => stopRoutineRun(run),
    }, [icon("x"), t("Stop routine")]),
  ]);

  const progressBlock = h("div", { class: "routine-overview" }, [
    h("div", { class: "routine-progress-ring", style: { "--routine-progress": `${overall}%` } }, [
      h("span", {}, `${formatNumber(Math.round(overall))}%`),
    ]),
    h("div", { class: "routine-overview-copy" }, [
      h("div", { class: "routine-total-row" }, [
        h("strong", { id: "routineTotalRemaining" }, fmtDuration(remainingTotal)),
        h("span", {}, t("remaining in this routine")),
      ]),
      h("div", { class: "routine-overall-track", role: "progressbar", "aria-label": t("Routine progress"), "aria-valuenow": String(Math.round(overall)), "aria-valuemin": "0", "aria-valuemax": "100" }, [
        h("span", { id: "routineOverallProgress", style: { width: `${overall}%` } }),
      ]),
      h("div", { class: "routine-completion-count" }, [
        `${formatNumber(run.completed_steps || 0)} ${t("completed")}`,
        run.skipped_steps ? ` · ${formatNumber(run.skipped_steps)} ${t("skipped")}` : "",
        ` · ${formatNumber(steps.length)} ${t("steps")}`,
      ]),
    ]),
  ]);

  const stepList = h("nav", { class: "routine-runner-steps", "aria-label": t("Routine steps") });
  steps.forEach((item, stepIndex) => {
    const stepStatus = statuses[stepIndex] || "pending";
    stepList.appendChild(h("div", {
      class: `routine-runner-step is-${stepStatus}${stepIndex === index ? " is-current" : ""}`,
      "aria-current": stepIndex === index ? "step" : null,
    }, [
      h("span", { class: "routine-step-marker", "aria-hidden": "true" }, stepStatus === "completed" ? "✓" : stepStatus === "skipped" ? "–" : formatNumber(stepIndex + 1)),
      h("span", { class: "routine-step-summary" }, [
        h("strong", { class: "routine-step-title" }, `${item.emoji ? `${item.emoji} ` : ""}${item.title}`),
        h("small", {}, fmtDuration(item.duration_seconds)),
      ]),
    ]));
  });

  const currentPanel = h("section", { class: "routine-current-step" }, [
    h("div", { class: "routine-current-copy" }, [
      h("div", { class: "routine-current-eyebrow" }, [
        h("span", { class: "eyebrow" }, t("Current step")),
        h("span", { class: "routine-step-counter" }, `${formatNumber(index + 1)} / ${formatNumber(steps.length)}`),
      ]),
      h("h3", { class: "routine-step-title", id: "routineCurrentStepTitle" }, `${step?.emoji ? `${step.emoji} ` : ""}${step?.title || t("No current step")}`),
      step?.notes ? h("p", { class: "routine-step-notes" }, step.notes) : null,
    ]),
    h("div", { class: "routine-clock-face" }, [
      h("span", { class: "routine-countdown", id: "routineCountdown", "aria-live": "off" }, formatCountdown(remaining)),
      h("span", { class: "routine-clock-caption" }, t("time left in this step")),
    ]),
    h("div", { class: "routine-step-track", role: "progressbar", "aria-label": t("Current step progress"), "aria-valuenow": String(Math.round(stepProgress)), "aria-valuemin": "0", "aria-valuemax": "100" }, [
      h("span", { id: "routineStepProgress", style: { width: `${stepProgress}%` } }),
    ]),
    h("div", { class: "routine-runner-actions" }, [
      h("button", {
        class: "btn btn-primary routine-main-action",
        id: "routinePauseResumeBtn",
        type: "button",
        onclick: () => sendRunCommand(run.status === "running" ? "pause" : "resume"),
      }, [icon(run.status === "running" ? "pause" : "play"), run.status === "running" ? t("Pause") : t("Resume")]),
      h("button", { class: "btn btn-quiet", type: "button", onclick: () => sendRunCommand("complete_step") }, [icon("check"), t("Complete step")]),
      h("button", { class: "btn btn-quiet", type: "button", onclick: () => sendRunCommand("skip_step") }, [icon("skip"), t("Skip step")]),
      h("button", { class: "btn btn-quiet routine-defer-action", type: "button", disabled: !steps.slice(index + 1).some((_, offset) => statuses[index + 1 + offset] === "pending"), onclick: () => sendRunCommand("move_to_end") }, [icon("arrow-right"), t("Move to end")]),
    ]),
  ]);

  const nextPanel = settingEnabled("routine_show_next", true)
    ? h("div", { class: "routine-next-step", id: "routineNextStep" }, next
      ? [h("span", { class: "eyebrow" }, t("Coming next")), h("strong", { class: "routine-step-title" }, `${next.emoji ? `${next.emoji} ` : ""}${next.title}`), h("small", {}, fmtDuration(next.duration_seconds))]
      : [h("span", { class: "eyebrow" }, t("Coming next")), h("strong", {}, t("That is the final step"))])
    : null;

  panel.append(h("div", { class: "routine-runner-shell" }, [
    header,
    progressBlock,
    h("div", { class: "routine-runner-layout" }, [currentPanel, h("aside", { class: "routine-step-rail" }, [
      h("header", { class: "routine-step-rail-head" }, [h("span", { class: "eyebrow" }, t("Your sequence")), h("strong", {}, `${formatNumber(steps.length)} ${t("steps")}`)]),
      stepList,
      nextPanel,
    ])]),
  ]));
  syncWakeLock(run);
}

function renderRoutineCards() {
  const list = byId("routineList");
  if (!list) return;
  const items = routines();
  const count = byId("routineCountPill");
  if (count) count.textContent = `${formatNumber(items.length)} ${t(items.length === 1 ? "routine" : "routines")}`;
  clear(list);
  if (!items.length) {
    list.appendChild(h("div", { class: "routine-empty-list" }, [
      h("span", { class: "routine-empty-glyph", "aria-hidden": "true" }, icon("list")),
      h("div", {}, [h("strong", {}, t("No routines yet")), h("p", {}, t("Create your own sequence, or add a starter routine and make it yours."))]),
      h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: createStarterRoutine }, t("Add a starter")),
    ]));
    return;
  }

  const active = activeRun();
  items.forEach((routine) => {
    const isActive = active?.routine_id === routine.id;
    const first = routine.steps?.[0];
    const card = h("article", {
      class: `routine-card${isActive ? " is-running" : ""}`,
      style: { "--routine-color": routine.color || "var(--accent)" },
    }, [
      h("div", { class: "routine-card-mark", "aria-hidden": "true" }, routine.emoji || "✨"),
      h("div", { class: "routine-card-content" }, [
        h("div", { class: "routine-card-title-row" }, [
          h("h3", { class: "routine-title" }, routine.name),
          isActive ? h("span", { class: "routine-status-tag" }, t("In progress")) : null,
        ]),
        routine.description ? h("p", { class: "routine-description" }, routine.description) : null,
        h("div", { class: "routine-card-meta" }, [
          h("span", {}, [icon("list"), `${formatNumber(routine.step_count)} ${t("steps")}`]),
          h("span", {}, [icon("clock"), fmtDuration(routine.duration_seconds)]),
          first ? h("span", { class: "routine-first-step" }, [t("Starts with"), ": ", h("strong", { class: "routine-step-title" }, first.title)]) : null,
        ]),
        h("div", { class: "routine-card-actions" }, [
          h("button", { class: "btn btn-primary btn-sm", type: "button", disabled: Boolean(active && !isActive), title: active && !isActive ? t("Stop the active routine before starting another") : "", onclick: () => startRoutine(routine) }, [icon("play"), isActive ? t("Open runner") : t("Start")]),
          h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => openRoutineEditor(routine) }, [icon("pen"), t("Edit")]),
          h("button", { class: "icon-btn icon-btn-sm", type: "button", title: t("Archive routine"), "aria-label": `${t("Archive routine")}: ${routine.name}`, onclick: () => archiveRoutine(routine) }, icon("inbox")),
        ]),
      ]),
    ]);
    list.appendChild(card);
  });
}

function renderRunHistory() {
  const list = byId("routineRunHistory");
  if (!list) return;
  const all = store.get("routine_runs", []) || [];
  const history = all.filter((run) => !["running", "paused"].includes(run.status)).slice(0, 8);
  const count = byId("routineHistoryCount");
  if (count) count.textContent = formatNumber(history.length);
  clear(list);
  if (!history.length) {
    list.appendChild(h("p", { class: "routine-history-empty" }, t("Completed and stopped runs will appear here.")));
    return;
  }
  history.forEach((run) => {
    const date = run.day_index ? calendarDayLabel(run.day_index) : "";
    let clock = "";
    if (run.started_at) {
      try {
        const language = store.setting("language", "en") === "fa" ? "fa-IR" : undefined;
        clock = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(new Date(run.started_at));
      } catch { clock = ""; }
    }
    list.appendChild(h("article", { class: `routine-history-row is-${run.status}` }, [
      h("span", { class: "routine-history-mark", "aria-hidden": "true" }, run.status === "completed" ? icon("check") : "—"),
      h("div", { class: "routine-history-copy" }, [
        h("strong", { class: "routine-title" }, run.name),
        h("small", {}, [date, clock ? ` · ${clock}` : "", ` · ${formatNumber(run.completed_steps || 0)}/${formatNumber((run.steps || []).length)} ${t("steps")}`]),
      ]),
      h("span", { class: "routine-history-duration" }, fmtDuration(run.elapsed_seconds)),
    ]));
  });
}

function renderTabBadge() {
  const badge = byId("routineTabBadge");
  if (!badge) return;
  const run = activeRun();
  badge.hidden = !run;
  badge.textContent = run ? (run.status === "paused" ? t("Paused") : formatCountdown(countdownRemaining(run))) : "";
}

function readStepEditorRows() {
  const container = byId("routineStepEditor");
  if (!container) return [];
  return Array.from(container.querySelectorAll(".routine-step-edit")).map((row) => ({
    title: row.querySelector("[data-step-title]")?.value?.trim() || "",
    minutes: Number(row.querySelector("[data-step-minutes]")?.value) || 0,
    emoji: row.querySelector("[data-step-emoji]")?.value?.trim() || "",
    notes: row.querySelector("[data-step-notes]")?.value?.trim() || "",
  }));
}

function makeStepEditRow(step, index, total) {
  const minutes = Math.max(1, Math.ceil(Number(step.duration_seconds || 60) / 60));
  return h("div", { class: "routine-step-edit", dataset: { id: String(index), stepIndex: String(index) } }, [
    h("button", { class: "routine-step-edit-index routine-step-drag", type: "button", title: t("Drag to reorder step"), "aria-label": `${t("Drag to reorder step")} ${formatNumber(index + 1)}`, "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown" }, [icon("drag"), h("span", {}, formatNumber(index + 1))]),
    h("div", { class: "routine-step-edit-fields" }, [
      h("div", { class: "routine-step-edit-main" }, [
        h("input", { type: "text", maxlength: "160", value: step.title || "", placeholder: t("Step name"), dataset: { stepTitle: "1" }, "aria-label": `${t("Step")} ${index + 1} ${t("name")}` }),
        h("input", { type: "number", min: "1", max: "240", step: "1", value: String(minutes), dataset: { stepMinutes: "1" }, "aria-label": `${t("Step")} ${index + 1} ${t("minutes")}` }),
        h("span", { class: "routine-step-minute-label" }, t("min")),
      ]),
      h("div", { class: "routine-step-edit-extra" }, [
        h("input", { type: "text", maxlength: "8", value: step.emoji || "", placeholder: "✨", dataset: { stepEmoji: "1" }, "aria-label": `${t("Step")} ${index + 1} ${t("emoji")}` }),
        h("input", { type: "text", maxlength: "800", value: step.notes || "", placeholder: t("Optional step note"), dataset: { stepNotes: "1" }, "aria-label": `${t("Step")} ${index + 1} ${t("optional note")}` }),
      ]),
    ]),
    h("div", { class: "routine-step-edit-actions" }, [
      h("button", { class: "icon-btn icon-btn-sm", type: "button", disabled: index === 0, title: t("Move step up"), "aria-label": t("Move step up"), dataset: { stepMove: "-1" } }, "↑"),
      h("button", { class: "icon-btn icon-btn-sm", type: "button", disabled: index >= total - 1, title: t("Move step down"), "aria-label": t("Move step down"), dataset: { stepMove: "1" } }, "↓"),
      h("button", { class: "icon-btn icon-btn-sm icon-btn-danger", type: "button", disabled: total <= 1, title: t("Remove step"), "aria-label": t("Remove step"), dataset: { stepRemove: "1" } }, icon("trash")),
    ]),
  ]);
}

function renderStepEditor(steps = []) {
  const container = byId("routineStepEditor");
  if (!container) return;
  clear(container);
  const values = steps.length ? steps : [{ title: "", duration_seconds: 300, emoji: "", notes: "" }];
  values.forEach((step, index) => container.appendChild(makeStepEditRow(step, index, values.length)));
  initDragAndDrop(container, {
    selector: ".routine-step-edit",
    handleSelector: ".routine-step-drag",
    containerSelector: "#routineStepEditor",
    keyboardReorder: false,
    onDrop: () => renderStepEditor(readStepEditorRows()),
  });
}

function openRoutineEditor(routine = null) {
  const form = byId("routineEditorForm");
  if (!form) return;
  form.reset();
  byId("editRoutineId").value = routine?.id || "";
  byId("routineEditorTitle").textContent = t(routine ? "Edit routine" : "New routine");
  byId("routineNameInput").value = routine?.name || "";
  byId("routineDescriptionInput").value = routine?.description || "";
  byId("routineEmojiInput").value = routine?.emoji || "✨";
  byId("routineColorInput").value = /^#[0-9a-f]{6}$/i.test(routine?.color || "") ? routine.color : "#7b8db8";
  byId("routineEditorError").textContent = "";
  byId("saveRoutineBtn").textContent = t(routine ? "Save changes" : "Save routine");
  renderStepEditor(routine?.steps || []);
  openSheet("routineEditorSheet");
}

async function saveRoutine(event) {
  event?.preventDefault();
  const errorNode = byId("routineEditorError");
  if (errorNode) errorNode.textContent = "";
  const steps = readStepEditorRows().map((step) => ({
    ...step,
    duration_seconds: Math.max(10, Math.round(step.minutes * 60)),
  }));
  const name = byId("routineNameInput")?.value?.trim() || "";
  if (!name) {
    if (errorNode) errorNode.textContent = t("Give this routine a name.");
    byId("routineNameInput")?.focus();
    return;
  }
  if (!steps.length || steps.some((step) => !step.title)) {
    if (errorNode) errorNode.textContent = t("Add a name to every step before saving.");
    return;
  }
  if (steps.some((step) => !step.minutes || step.minutes < 1 || step.minutes > 240)) {
    if (errorNode) errorNode.textContent = t("Step durations must be between 1 and 240 minutes.");
    return;
  }
  const payload = {
    name,
    description: byId("routineDescriptionInput")?.value?.trim() || "",
    emoji: byId("routineEmojiInput")?.value?.trim() || "✨",
    color: byId("routineColorInput")?.value || "#7b8db8",
    steps,
  };
  const id = byId("editRoutineId")?.value;
  const submit = byId("saveRoutineBtn");
  if (submit) submit.disabled = true;
  try {
    if (id) await api.updateRoutine(id, payload);
    else await api.createRoutine(payload);
    await reloadRoutineState();
    closeSheet("routineEditorSheet");
    toast(t(id ? "Routine updated" : "Routine saved"), { tone: "good" });
  } catch (error) {
    if (errorNode) errorNode.textContent = t(error.message || "Could not save the routine.");
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function createStarterRoutine() {
  const isFa = store.setting("language", "en") === "fa";
  const sample = isFa ? {
    name: "شروع آرام روز",
    description: "یک شروع کوتاه و روشن برای امروز",
    steps: [
      { title: "مرتب کردن تخت", minutes: 1, emoji: "🛏️" },
      { title: "نوشیدن یک لیوان آب", minutes: 2, emoji: "💧" },
      { title: "کشش آرام بدن", minutes: 5, emoji: "🧘" },
      { title: "انتخاب نخستین کار", minutes: 2, emoji: "✍️" },
    ],
  } : {
    name: "Morning reset",
    description: "A short, steady start for the day",
    steps: [
      { title: "Make the bed", minutes: 1, emoji: "🛏️" },
      { title: "Drink a glass of water", minutes: 2, emoji: "💧" },
      { title: "Gentle stretch", minutes: 5, emoji: "🧘" },
      { title: "Choose the first task", minutes: 2, emoji: "✍️" },
    ],
  };
  const existing = routines().find((routine) => routine.name === sample.name);
  try {
    let routine = existing;
    if (!routine) {
      const response = await api.createRoutine({ ...sample, emoji: "☀️", color: "#d69e36", steps: sample.steps.map((step) => ({ ...step, duration_seconds: step.minutes * 60 })) });
      routine = response?.routine;
    }
    if (routine?.id) {
      const currentRun = activeRun();
      if (!currentRun) await api.startRoutine(routine.id);
      else if (currentRun.routine_id !== routine.id) {
        toast(t("Stop the active routine before starting another"), { tone: "warn" });
        return;
      }
      await reloadRoutineState();
      emit("switch-tab", { tab: "routines" });
      toast(t("Starter routine is ready. You can edit every step."), { tone: "good" });
    }
  } catch (error) {
    toast(t(error.message || "Could not add the starter routine."), { tone: "error" });
  }
}

function openRoutineRunner() {
  // The runner's primary actions sit near the lower edge of the workspace.
  // Clear stale success toasts rather than covering the controls on entry.
  byId("toasts")?.replaceChildren();
  emit("switch-tab", { tab: "routines" });
}

async function startRoutine(routine) {
  if (activeRun()?.routine_id === routine.id) {
    openRoutineRunner();
    return;
  }
  try {
    await api.startRoutine(routine.id);
    await reloadRoutineState();
    openRoutineRunner();
  } catch (error) {
    toast(t(error.message || "Could not start the routine."), { tone: "error" });
  }
}

async function archiveRoutine(routine) {
  const ok = await confirmAction({
    title: t("Archive this routine?"),
    text: t("It will leave your active routine list. Completed run history will remain."),
    okLabel: t("Archive"),
    danger: false,
  });
  if (!ok) return;
  try {
    await api.deleteRoutine(routine.id);
    await reloadRoutineState();
    toast(t("Routine archived"), { tone: "info" });
  } catch (error) {
    toast(t(error.message || "Could not archive the routine."), { tone: "error" });
  }
}

async function sendRunCommand(action, explicitRemaining = undefined) {
  const run = activeRun();
  if (!run || transitionInFlight) return;
  transitionInFlight = true;
  const previousIndex = run.current_step_index;
  const remaining = explicitRemaining === undefined ? countdownRemaining(run) : explicitRemaining;
  try {
    await api.commandRoutineRun(run.id, action, remaining);
    await reloadRoutineState();
    const updated = activeRun();
    if (action === "complete_step" || action === "skip_step") {
      if (updated && updated.current_step_index !== previousIndex || !updated) playRoutineCue();
    }
  } catch (error) {
    toast(t(error.message || "Could not update the routine."), { tone: "error" });
  } finally {
    transitionInFlight = false;
    const fresh = activeRun();
    if (!fresh || fresh.status !== "running") syncWakeLock(null);
  }
}

async function stopRoutineRun(run) {
  const ok = await confirmAction({
    title: t("Stop this routine?"),
    text: t("Your progress will be saved in run history, and you can start again later."),
    okLabel: t("Stop routine"),
    danger: true,
  });
  if (ok) await sendRunCommand("stop");
}

function playRoutineCue() {
  if (settingEnabled("routine_sound", true)) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const context = new AudioContextClass();
        [660, 880].forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, context.currentTime + index * 0.13);
          gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + index * 0.13 + 0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + index * 0.13 + 0.18);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(context.currentTime + index * 0.13);
          oscillator.stop(context.currentTime + index * 0.13 + 0.2);
        });
        window.setTimeout(() => context.close().catch(() => null), 700);
      }
    } catch { /* Audio is optional; the runner remains usable without it. */ }
  }
  if (settingEnabled("routine_vibrate", false) && typeof navigator.vibrate === "function") {
    navigator.vibrate([80, 45, 80]);
  }
}

async function syncWakeLock(run) {
  const shouldHold = Boolean(run && run.status === "running" && settingEnabled("routine_keep_awake", false));
  if (!shouldHold) {
    try { await wakeLock?.release?.(); } catch { /* The browser may already have released it. */ }
    wakeLock = null;
    return;
  }
  if (!navigator.wakeLock?.request || document.visibilityState !== "visible" || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

function updateLiveRunner(run) {
  if (!run || run.status !== "running") return;
  const remaining = countdownRemaining(run);
  const countdown = byId("routineCountdown");
  if (countdown) countdown.textContent = formatCountdown(remaining);
  const stepProgress = currentStepProgress(run, remaining);
  setBar(byId("routineStepProgress"), stepProgress);
  const stepTrack = byId("routineStepProgress")?.parentElement;
  if (stepTrack) stepTrack.setAttribute("aria-valuenow", String(Math.round(stepProgress)));
  const elapsed = Math.max(0, Number(run.elapsed_seconds) || 0) + Math.max(0, Number(run.remaining_seconds) - remaining);
  const overall = progressPercent(elapsed, run.planned_seconds);
  setBar(byId("routineOverallProgress"), overall);
  const overallTrack = byId("routineOverallProgress")?.parentElement;
  if (overallTrack) overallTrack.setAttribute("aria-valuenow", String(Math.round(overall)));
  const ring = $(".routine-progress-ring");
  if (ring) ring.style.setProperty("--routine-progress", `${overall}%`);
  const rest = (run.steps || []).reduce((sum, step, index) => sum + (index > run.current_step_index && run.step_statuses?.[index] === "pending" ? Number(step.duration_seconds) || 0 : 0), 0);
  const total = byId("routineTotalRemaining");
  if (total) total.textContent = fmtDuration(remaining + rest);
  const tabBadge = byId("routineTabBadge");
  if (tabBadge && !tabBadge.hidden) tabBadge.textContent = formatCountdown(remaining);

  if (remaining > 0 || transitionInFlight) return;
  const key = `${run.id}:${run.current_step_index}`;
  if (expiredStepKey === key) return;
  expiredStepKey = key;
  void sendRunCommand("pause", 0).then(() => toast(t("Time is up. Choose Complete step, Skip step, or Move to end."), { tone: "info" }));
}

function tickRoutineTimer() {
  updateLiveRunner(activeRun());
}

export function renderRoutines() {
  if (!activeRun() && byId("appRoot")?.dataset.tab === "routines" && byId("routineRunnerView") && !byId("routineRunnerView").hidden) {
    emit("switch-tab", { tab: "routines", runner: false, scroll: false });
  }
  renderTabBadge();
  renderRunner();
  renderRoutineCards();
  renderRunHistory();
}

export function initRoutineUI() {
  if (initialized) return;
  initialized = true;
  byId("createRoutineBtn")?.addEventListener("click", () => openRoutineEditor());
  byId("starterRoutineBtn")?.addEventListener("click", createStarterRoutine);
  byId("routineEditorForm")?.addEventListener("submit", saveRoutine);
  byId("addRoutineStepBtn")?.addEventListener("click", () => {
    const rows = readStepEditorRows();
    rows.push({ title: "", duration_seconds: 300, emoji: "", notes: "" });
    renderStepEditor(rows);
    const fields = byId("routineStepEditor")?.querySelectorAll("[data-step-title]");
    fields?.[fields.length - 1]?.focus();
  });
  byId("exitRoutineRunnerBtn")?.addEventListener("click", () => emit("switch-tab", { tab: "routines", runner: false }));
  byId("routineStepEditor")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-step-move], button[data-step-remove]");
    if (!button) return;
    const rows = readStepEditorRows();
    const index = Number(button.closest(".routine-step-edit")?.dataset.stepIndex);
    if (button.dataset.stepMove) {
      const next = index + Number(button.dataset.stepMove);
      if (next < 0 || next >= rows.length) return;
      [rows[index], rows[next]] = [rows[next], rows[index]];
    } else if (button.dataset.stepRemove && rows.length > 1) {
      rows.splice(index, 1);
    }
    renderStepEditor(rows);
  });
  byId("routineStepEditor")?.addEventListener("keydown", (event) => {
    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const row = event.target.closest(".routine-step-edit");
      const index = Number(row?.dataset.stepIndex);
      const rows = readStepEditorRows();
      const next = index + (event.key === "ArrowUp" ? -1 : 1);
      if (next < 0 || next >= rows.length) return;
      [rows[index], rows[next]] = [rows[next], rows[index]];
      renderStepEditor(rows);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncWakeLock(activeRun());
  });
  on("state", renderRoutines);
  on("tab", ({ tab }) => { if (tab === "routines") renderRoutines(); });
  ticker = window.setInterval(tickRoutineTimer, 250);
  renderRoutines();
}
