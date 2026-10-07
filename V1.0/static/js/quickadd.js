/* ==========================================================================
   TaskArcade — quick add & bulk composer
   Instant, offline-friendly parsing preview (the server parser remains the
   source of truth on submit) with alias resolution highlighted so users can
   see short tag aliases resolve before they commit.
   ========================================================================== */

import {
  byId, h, icon, clear, store, emit, on, debounce, dayLabel,
  parseDurationText, PRIORITY_LABELS, formatNumber,
} from "./core.js";
import { api } from "./api.js";
import { toast as toastUi, openSheet, closeSheet } from "./ui.js";
import { provideRefreshBridge } from "./refreshbus.js";

const t = (value) => window.TaskArcadeI18n?.t?.(value) ?? value;

let refresh = async () => {};
provideRefreshBridge((fn) => { refresh = fn; });

/* --------------------------------------------------------------------------
   Inline preview
   -------------------------------------------------------------------------- */
export function parseLocally(text) {
  const settings = store.get("settings", {}) || {};
  const pomodoro = Number(settings.pomodoro_focus || 25);
  const defaultMinutes = Number(settings.default_duration || 30);
  let working = String(text || "").trim();
  const result = { title: "", tag: "", tagToken: "", alias: false, seconds: null, priority: 0, scheduled: "", recurrence: "", subtasks: [], notes: "", pinned: false };

  if (!working) return result;

  if (working.includes(">")) {
    const [head, ...rest] = working.split(">");
    working = head.trim();
    result.notes = rest.join(">").trim();
  }

  const tokens = working.split(/\s+/);
  const titleParts = [];

  tokens.forEach((token, index) => {
    const isLast = index === tokens.length - 1;
    if (token === "^") { result.pinned = true; return; }

    if (token.startsWith("#") && token.length > 1) {
      if (result.tag) { titleParts.push(token); return; }
      const typed = token.slice(1).toLowerCase();
      const resolved = store.resolveTag(typed);
      result.tag = resolved;
      result.tagToken = typed;
      result.alias = resolved !== typed;
      return;
    }

    if (token.startsWith("+") && token.length > 1) {
      result.subtasks.push(token.slice(1).replace(/-/g, " "));
      return;
    }

    if (token.startsWith("@")) {
      const body = token.slice(1).toLowerCase();
      if (body === "now") { result.scheduled = new Date().toISOString().slice(0, 16); return; }
      const relative = body.match(/^\+(\d+)([a-z]*)$/);
      if (relative) {
        const seconds = parseDurationText(relative[1] + (relative[2] || "m"), pomodoro) || 0;
        result.scheduled = new Date(Date.now() + seconds * 1000).toISOString().slice(0, 16);
        return;
      }
      const clock = body.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
      if (clock) {
        let hour = Number(clock[1]);
        const minute = Number(clock[2] || 0);
        if (clock[3] === "pm" && hour < 12) hour += 12;
        if (clock[3] === "am" && hour === 12) hour = 0;
        if (hour < 24 && minute < 60) {
          result.scheduled = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          return;
        }
      }
      titleParts.push(token);
      return;
    }

    if (token.startsWith("~") || token.startsWith("=")) {
      const body = token.slice(1);
      const pomos = body.match(/^(\d+)(p|pom|pomo|🍅)$/i);
      if (pomos) { result.seconds = Number(pomos[1]) * pomodoro * 60; return; }
      const seconds = parseDurationText(body, pomodoro);
      if (seconds) { result.seconds = seconds; return; }
      titleParts.push(token);
      return;
    }

    if (token.startsWith("!") || /^p[0-3]$/i.test(token)) {
      const markers = token.replace(/!/g, "");
      const value = token.toLowerCase();
      if (/^p[0-3]$/.test(value)) result.priority = Number(value.slice(1));
      else if (!markers) result.priority = 3;                  // "!!!"
      else if (markers.length >= 3) result.priority = 3;
      else if (markers.length === 2) result.priority = 2;
      else if (markers.length === 1) result.priority = 1;      // "!"
      else result.priority = 3;                                 // "!high"
      return;
    }

    if (token.startsWith("*") && token.length > 1) {
      result.recurrence = token.slice(1);
      return;
    }

    const durationMatch = /^\d+(?:\.\d+)?[a-z]+$/i.test(token);
    if ((isLast || durationMatch) && result.seconds === null) {
      const seconds = parseDurationText(token, pomodoro);
      if (seconds) { result.seconds = seconds; return; }
    }

    titleParts.push(token);
  });

  result.title = titleParts.join(" ").trim();
  if (result.seconds === null) {
    const tagDefault = store.tag(result.tag)?.default_minutes || 0;
    result.seconds = (tagDefault || defaultMinutes) * 60;
  }
  return result;
}

export function renderParseChips(parsed, { error = "" } = {}) {
  const holder = byId("quickAddPreview");
  if (!holder) return;
  clear(holder);
  if (error) {
    holder.appendChild(h("span", { class: "parse-chip parse-chip-error" }, [icon("x"), error]));
    return;
  }
  if (!parsed.title) return;

  const chips = [];
  if (parsed.tag) {
    const tag = store.tag(parsed.tag);
    const color = tag?.color || "#8D99AE";
    chips.push(
      h("span", {
        class: "parse-chip parse-chip-tag",
        style: { "--tag-color": color, "--tag-soft": `${color}22` },
      }, [
        `#${tag?.label || parsed.tag}`,
        parsed.alias ? h("em", {}, ` from #${parsed.tagToken}`) : null,
      ]),
    );
  }
  if (parsed.seconds) chips.push(h("span", { class: "parse-chip parse-chip-time" }, [icon("clock"), fmtDurationLite(parsed.seconds)]));
  if (parsed.priority) chips.push(h("span", { class: "parse-chip parse-chip-priority" }, [icon("bolt"), `${PRIORITY_LABELS[parsed.priority]} priority`]));
  if (parsed.scheduled) chips.push(h("span", { class: "parse-chip" }, [icon("calendar"), parsed.scheduled.replace("T", " ")]));
  if (parsed.recurrence) chips.push(h("span", { class: "parse-chip" }, [icon("repeat"), parsed.recurrence]));
  if (parsed.subtasks.length) chips.push(h("span", { class: "parse-chip" }, [icon("list"), `${parsed.subtasks.length} step(s)`]));
  if (parsed.notes) chips.push(h("span", { class: "parse-chip" }, [icon("note"), "note"]));
  if (parsed.pinned) chips.push(h("span", { class: "parse-chip" }, [icon("pin"), "pinned"]));

  chips.push(h("span", { class: "parse-chip" }, [icon("arrow-right"), `“${truncate(parsed.title, 42)}”`]));
  chips.forEach((chip) => holder.appendChild(chip));
}

function fmtDurationLite(seconds) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  if (minutes) return `${minutes}m`;
  return `${total}s`;
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/* --------------------------------------------------------------------------
   Wiring
   -------------------------------------------------------------------------- */
export function initQuickAdd() {
  const form = byId("quickAddForm");
  const input = byId("quickAddInput");
  if (!form || !input) return;

  const preview = debounce(() => {
    const parsed = parseLocally(input.value);
    renderParseChips(parsed);
  }, 120);

  input.addEventListener("input", preview);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitQuickAdd();
    }
    if (event.key === "Escape") input.blur();
    if (event.key === "Tab" && !input.value) {
      event.preventDefault();
      byId("openBulkBtn")?.focus();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitQuickAdd();
  });

  byId("openBulkBtn")?.addEventListener("click", () => openBulkPanel());
  byId("closeBulkBtn")?.addEventListener("click", () => closeBulkPanel());
  byId("bulkSubmitBtn")?.addEventListener("click", submitBulk);
  byId("bulkExampleBtn")?.addEventListener("click", insertBulkExample);
  byId("bulkTextarea")?.addEventListener("input", debounce(renderBulkPreview, 200));

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest('[data-action="open-bulk"]');
    if (trigger) openBulkPanel();
  });

  on("open-bulk", ({ day } = {}) => {
    openBulkPanel();
    if (day) {
      const select = byId("bulkDaySelect");
      if (select) select.value = String(day);
    }
  });

  on("focus-quick-add", ({ day } = {}) => {
    if (day && day !== store.settingNum("current_day_index", 1)) {
      openBulkPanel();
      const select = byId("bulkDaySelect");
      if (select) select.value = String(day);
      return;
    }
    input.focus();
    input.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

export async function submitQuickAdd() {
  const input = byId("quickAddInput");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const parsed = parseLocally(text);
  if (!parsed.title) {
    renderParseChips(parsed, { error: "Add a title before the tags" });
    return;
  }

  try {
    const result = await api.bulkAdd(text, store.settingNum("current_day_index", 1));
    const created = result?.result?.created ?? 0;
    const bad = result?.result?.bad_lines || [];
    if (created) {
      input.value = "";
      renderParseChips({});
      const tag = parsed.tag ? ` as #${store.tag(parsed.tag)?.label || parsed.tag}` : "";
      toastUi(`Added “${truncate(parsed.title, 34)}”${tag}`, {
        tone: "good",
        timeout: 2600,
        action: { label: "Undo", run: () => api.undo().then(() => refresh()) },
      });
      await refresh();
    } else if (bad.length) {
      renderParseChips(parsed, { error: "Could not parse that line" });
      toastUi("That line needs a title and an optional duration", { tone: "warn" });
    } else {
      await refresh();
    }
  } catch (error) {
    toastUi(error.message || "Could not add the task", { tone: "error" });
  }
}

/* --------------------------------------------------------------------------
   Bulk composer
   -------------------------------------------------------------------------- */
export function openBulkPanel() {
  const panel = byId("bulkPanel");
  if (!panel) return;
  if (window.matchMedia("(max-width: 640px)").matches) {
    emit("switch-tab", { tab: "plan" });
  }
  panel.hidden = false;
  renderBulkDaySelect();
  byId("bulkTextarea")?.focus();
  window.setTimeout(() => panel.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
}

export function closeBulkPanel() {
  const panel = byId("bulkPanel");
  if (panel) panel.hidden = true;
}

export function renderBulkDaySelect() {
  const select = byId("bulkDaySelect");
  if (!select) return;
  const current = store.settingNum("current_day_index", 1);
  const previous = select.value;
  clear(select);
  for (let offset = -2; offset <= 21; offset += 1) {
    const day = current + offset;
    if (day < 1) continue;
    select.appendChild(h("option", { value: String(day) }, `${dayLabel(day, current)} (${t("Day")} ${formatNumber(day)})`));
  }
  select.value = previous && select.querySelector(`option[value="${previous}"]`) ? previous : String(current);
}

function renderBulkPreview() {
  const textarea = byId("bulkTextarea");
  const holder = byId("bulkPreview");
  const error = byId("bulkError");
  if (!textarea || !holder) return;
  if (error) error.textContent = "";
  clear(holder);

  const lines = textarea.value.split("\n").filter((line) => line.trim());
  if (!lines.length) return;

  let ok = 0;
  lines.slice(0, 40).forEach((line) => {
    const isChild = /^\s/.test(line) || line.trim().startsWith("-");
    const parsed = parseLocally(line.replace(/^\s*-\s*/, ""));
    if (isChild) {
      holder.appendChild(h("span", { class: "parse-chip" }, [icon("list"), truncate(parsed.title || line.trim(), 30)]));
      return;
    }
    if (parsed.title) {
      ok += 1;
      holder.appendChild(
        h("span", { class: "parse-chip parse-chip-tag", style: parsed.tag ? { "--tag-color": store.tagColor(parsed.tag), "--tag-soft": `${store.tagColor(parsed.tag)}22` } : {} }, [
          parsed.tag ? `#${store.tag(parsed.tag)?.label || parsed.tag} ` : "",
          truncate(parsed.title, 28),
          ` · ${fmtDurationLite(parsed.seconds)}`,
        ]),
      );
    } else {
      holder.appendChild(h("span", { class: "parse-chip parse-chip-error" }, [icon("x"), truncate(line.trim(), 28)]));
    }
  });

  if (ok === 0) holder.appendChild(h("span", { class: "parse-chip" }, t("Nothing to add yet")));
}

async function submitBulk() {
  const textarea = byId("bulkTextarea");
  const error = byId("bulkError");
  const select = byId("bulkDaySelect");
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) {
    if (error) error.textContent = t("Type or paste at least one line.");
    return;
  }
  try {
    const result = await api.bulkAdd(text, Number(select?.value || store.settingNum("current_day_index", 1)));
    const created = result?.result?.created ?? 0;
    const bad = result?.result?.bad_lines || [];
    if (created) {
      textarea.value = "";
      renderBulkPreview();
      const addedLabel = created === 1 ? t("task") : t("tasks");
      const skippedLabel = store.setting("language", "en") === "fa"
        ? (bad.length ? ` · ${formatNumber(bad.length)} ${t("lines skipped")}` : "")
        : (bad.length ? ` · skipped ${bad.length} line(s)` : "");
      const successMessage = store.setting("language", "en") === "fa"
        ? `${formatNumber(created)} ${addedLabel} ${t("added")}${skippedLabel}`
        : `Added ${created} task${created === 1 ? "" : "s"}${skippedLabel}`;
      toastUi(successMessage, {
        tone: bad.length ? "warn" : "good",
        action: { label: t("Undo"), run: () => api.undo().then(() => refresh()) },
      });
      if (bad.length && error) {
        error.textContent = `${t("Skipped:")} ${bad.slice(0, 2).map((item) => t(item.reason || "invalid line")).join(", ")}`;
      }
      closeBulkPanel();
      await refresh();
    } else {
      if (error) error.textContent = t(result?.result?.error || "No valid task lines found.");
      toastUi(t("Nothing was added — check the format"), { tone: "warn" });
    }
  } catch (err) {
    const bad = err.data?.bad_lines || [];
    if (error) {
      error.textContent = bad.length
        ? `${t("Skipped")} ${formatNumber(bad.length)} ${t("lines")} · ${bad.slice(0, 2).map((item) => item.line || item).join(" | ")}`
        : t(err.message || "Could not add the tasks");
    }
    toastUi(t(err.message || "Could not add the tasks"), { tone: "error" });
  }
}

function insertBulkExample() {
  const textarea = byId("bulkTextarea");
  if (!textarea) return;
  const current = store.settingNum("current_day_index", 1);
  const sample = [
    "Plan the day #w 10m !",
    "Deep work block #w 90m @09:30 !!",
    "  outline the report",
    "  write section one",
    "Study English #s 1h *daily",
    "Walk outside #he 45m",
    "Watch a movie #f 2h",
  ].join("\n");
  textarea.value = textarea.value ? `${textarea.value}\n${sample}` : sample;
  textarea.focus();
  renderBulkPreview();
  emit("toast", { message: `Lines will land on day ${current} unless you change the target`, tone: "info" });
}
