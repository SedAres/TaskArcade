/* ==========================================================================
   TaskArcade — library view
   Templates, recurring rules, the tag/alias vocabulary editor, backup &
   restore, history and the day bookkeeping tools.
   ========================================================================== */

import {
  byId, h, icon, clear, store, emit, on, prefs, fmtDuration, fmtShort, fmtMinutes,
  dayLabel, relativeTime, download, toCsv, storageNote, PRIORITY_LABELS,
} from "./core.js";
import { api } from "./api.js";
import { toast, confirmAction, formDialog, actionSheet, openSheet, closeSheet } from "./ui.js";
import { statsCsv } from "./insights.js";

let refresh = async () => {};
export function provideRefresh(fn) {
  refresh = fn;
}

/* --------------------------------------------------------------------------
   Templates
   -------------------------------------------------------------------------- */
export function renderTemplates() {
  const holder = byId("templateList");
  if (!holder) return;
  const templates = store.get("templates", []) || [];
  clear(holder);
  if (!templates.length) {
    holder.appendChild(h("p", { class: "form-hint" }, "No templates yet — save a day to create one."));
    return;
  }

  templates.forEach((template) => {
    const card = h("article", { class: "template-card" }, [
      h("h4", { class: "template-name" }, template.name),
      template.description ? h("p", { class: "user-content" }, template.description) : null,
      h("div", { class: "template-meta" }, [
        h("span", {}, [icon("list"), ` ${template.task_count} tasks`]),
        h("span", {}, [icon("clock"), ` ${fmtMinutes(template.minutes)}`]),
        template.payload?.start ? h("span", {}, [icon("calendar"), ` starts ${template.payload.start}`]) : null,
        h("span", {}, [icon("repeat"), ` used ${template.use_count}×`]),
      ]),
      h("div", { class: "template-actions" }, [
        h("button", {
          class: "btn btn-sm btn-primary",
          type: "button",
          onclick: async () => {
            try {
              await api.applyTemplate(template.id, store.settingNum("current_day_index", 1));
              toast(`Applied “${template.name}” to ${dayLabel(store.settingNum("current_day_index", 1))}`, { tone: "good" });
              await refresh();
            } catch (error) {
              toast(error.message || "Could not apply the template", { tone: "error" });
            }
          },
        }, [icon("plus"), "Apply to today"]),
        h("button", {
          class: "btn btn-sm btn-quiet",
          type: "button",
          onclick: async () => {
            const data = await formDialog({
              title: "Apply to another day",
              fields: [
                { name: "day", label: "Virtual day index", type: "number", value: store.settingNum("current_day_index", 1) + 1, min: 1 },
                { name: "shift", label: "Shift scheduled times by (minutes)", type: "number", value: 0, min: -720, max: 720 },
              ],
              submitLabel: "Apply",
            });
            if (!data) return;
            await api.applyTemplate(template.id, data.day, data.shift || 0);
            toast(`Applied to day ${data.day}`, { tone: "good" });
            await refresh();
          },
        }, "Other day…"),
        h("button", {
          class: "btn btn-sm btn-quiet",
          type: "button",
          onclick: () => renameTemplate(template),
        }, "Rename"),
        h("button", {
          class: "btn btn-sm btn-quiet",
          type: "button",
          onclick: () => {
            download(`template-${template.name.replace(/\s+/g, "-").toLowerCase()}.json`, JSON.stringify(template, null, 2));
          },
        }, "Export"),
        h("button", {
          class: "btn btn-sm btn-danger",
          type: "button",
          onclick: async () => {
            const ok = await confirmAction({ title: "Delete template?", text: template.name, okLabel: "Delete" });
            if (!ok) return;
            await api.deleteTemplate(template.id);
            await refresh();
          },
        }, "Delete"),
      ]),
    ]);
    holder.appendChild(card);
  });
}

async function renameTemplate(template) {
  const data = await formDialog({
    title: "Rename template",
    fields: [
      { name: "name", label: "Name", type: "text", value: template.name, required: true },
      { name: "description", label: "Description", type: "text", value: template.description || "" },
    ],
    submitLabel: "Save",
  });
  if (!data) return;
  await api.saveTemplate({ name: data.name, description: data.description, payload: template.payload });
  await refresh();
}

export function initTemplates() {
  byId("saveDayTemplateBtn")?.addEventListener("click", async () => {
    const current = store.settingNum("current_day_index", 1);
    const data = await formDialog({
      title: "Save today as a template",
      eyebrow: `Day ${current}`,
      fields: [
        { name: "name", label: "Template name", type: "text", placeholder: "My deep work morning", required: true },
        { name: "description", label: "Description", type: "text", placeholder: "Optional" },
      ],
      submitLabel: "Save template",
    });
    if (!data) return;
    try {
      await api.templateFromDay(current, data.name, data.description || "");
      toast(`Saved “${data.name}”`, { tone: "good" });
      await refresh();
    } catch (error) {
      toast(error.message || "Could not save the template", { tone: "error" });
    }
  });
}

/* --------------------------------------------------------------------------
   Recurrences
   -------------------------------------------------------------------------- */
export function renderRecurrences() {
  const holder = byId("recurrenceList");
  if (!holder) return;
  const rules = store.get("recurrences", []) || [];
  clear(holder);
  if (!rules.length) {
    holder.appendChild(h("p", { class: "form-hint" }, "No recurring tasks yet. Add one from a task's menu or the button above."));
    return;
  }
  rules.forEach((rule) => {
    holder.appendChild(
      h("article", { class: `recurrence-card${rule.active ? "" : " is-archived"}` }, [
        h("h4", { class: "template-title" }, rule.title),
        h("div", { class: "recurrence-meta" }, [
          h("span", {}, [icon("repeat"), ` ${rule.rule_text}`]),
          rule.tag ? h("span", {}, `#${store.tag(rule.tag)?.label || rule.tag}`) : null,
          h("span", {}, fmtShort(rule.duration_seconds)),
          rule.priority ? h("span", {}, `${PRIORITY_LABELS[rule.priority]} priority`) : null,
        ]),
        h("div", { class: "recurrence-actions" }, [
          h("button", {
            class: "btn btn-sm btn-quiet",
            type: "button",
            onclick: async () => {
              await api.updateRecurrence(rule.id, { active: !rule.active });
              toast(rule.active ? "Rule paused" : "Rule resumed", { tone: "info" });
              await refresh();
            },
          }, rule.active ? "Pause" : "Resume"),
          h("button", {
            class: "btn btn-sm btn-quiet",
            type: "button",
            onclick: async () => {
              const data = await formDialog({
                title: "Create the next occurrences",
                eyebrow: rule.title,
                eyebrowIsUserContent: true,
                fields: [{ name: "horizon", label: "How many days ahead?", type: "number", value: 14, min: 1, max: 120 }],
                submitLabel: "Materialise",
              });
              if (!data) return;
              try {
                const result = await api.materialize(data.horizon);
                toast(`Created ${result?.result?.created ?? 0} task(s)`, { tone: "good" });
                await refresh();
              } catch (error) {
                toast(error.message || "Could not create occurrences", { tone: "error" });
              }
            },
          }, "Materialise"),
          h("button", {
            class: "btn btn-sm btn-quiet",
            type: "button",
            onclick: () => editRecurrence(rule),
          }, "Edit"),
          h("button", {
            class: "btn btn-sm btn-danger",
            type: "button",
            onclick: async () => {
              const ok = await confirmAction({ title: "Delete rule?", text: rule.title, okLabel: "Delete" });
              if (!ok) return;
              await api.deleteRecurrence(rule.id);
              await refresh();
            },
          }, "Delete"),
        ]),
      ]),
    );
  });
}

async function editRecurrence(rule) {
  const data = await formDialog({
    title: "Edit recurring task",
    fields: [
      { name: "title", label: "Title", type: "text", value: rule.title, required: true },
      { name: "tag", label: "Tag", type: "text", value: rule.tag || "" },
      {
        name: "freq", label: "Frequency", type: "select", value: rule.rule?.freq || "daily",
        options: [
          { value: "daily", label: "Every day" },
          { value: "weekly", label: "Weekly (specific days)" },
          { value: "every_n_days", label: "Every N days" },
          { value: "monthly", label: "Every 30 days" },
        ],
      },
      { name: "interval", label: "Interval", type: "number", value: rule.rule?.interval || 1, min: 1, max: 60 },
      { name: "time", label: "Preferred time", type: "time", value: rule.rule?.time || "" },
    ],
    submitLabel: "Save rule",
  });
  if (!data) return;
  await api.updateRecurrence(rule.id, {
    title: data.title,
    tag: data.tag,
    duration_seconds: rule.duration_seconds,
    rule: {
      freq: data.freq,
      interval: data.interval || 1,
      weekdays: rule.rule?.weekdays || [0, 1, 2, 3, 4],
      time: data.time || "",
    },
  });
  await refresh();
}

export function initRecurrences() {
  byId("addRecurrenceBtn")?.addEventListener("click", async () => {
    const data = await formDialog({
      title: "New recurring task",
      fields: [
        { name: "title", label: "Title", type: "text", placeholder: "Weekly review", required: true },
        { name: "tag", label: "Tag", type: "text", placeholder: "tracked" },
        { name: "duration", label: "Duration", type: "text", value: "30m", required: true },
        {
          name: "freq", label: "Frequency", type: "select", value: "daily",
          options: [
            { value: "daily", label: "Every day" },
            { value: "weekly", label: "Weekly (Mon–Fri)" },
            { value: "weekends", label: "Weekends" },
            { value: "every_n_days", label: "Every N days" },
            { value: "monthly", label: "Every 30 days" },
          ],
        },
        { name: "interval", label: "Interval", type: "number", value: 1, min: 1, max: 60 },
        { name: "time", label: "Preferred time", type: "time" },
      ],
      submitLabel: "Create rule",
    });
    if (!data) return;

    const seconds = (await api.parse(data.duration))?.parsed?.seconds || 1800;
    const rule = { freq: data.freq, interval: data.interval || 1, weekdays: [0, 1, 2, 3, 4], time: data.time || "" };
    if (data.freq === "weekends") {
      rule.freq = "weekly";
      rule.weekdays = [5, 6];
    }
    try {
      await api.saveRecurrence({
        title: data.title,
        tag: data.tag,
        duration_seconds: seconds,
        rule,
        anchor_day_index: store.settingNum("current_day_index", 1),
      });
      toast("Recurring task created", { tone: "good" });
      await refresh();
    } catch (error) {
      toast(error.message || "Could not create the rule", { tone: "error" });
    }
  });
}

/* --------------------------------------------------------------------------
   Tags & aliases
   -------------------------------------------------------------------------- */
export function renderTagTable() {
  const holder = byId("tagTable");
  if (!holder) return;
  const tags = store.get("tags", []) || [];
  clear(holder);

  if (!tags.length) {
    holder.appendChild(h("p", { class: "form-hint" }, "No tags yet — create one and give it a couple of aliases."));
    return;
  }

  tags.forEach((tag) => {
    const aliases = h("div", { class: "tag-row-aliases" });
    (tag.aliases || []).forEach((alias) => {
      aliases.appendChild(
        h("span", { class: "alias-chip" }, [
          `#${alias}`,
          h("button", {
            type: "button",
            title: `Remove alias #${alias}`,
            onclick: async () => {
              await api.deleteAlias(alias);
              toast(`#${alias} no longer maps to #${tag.name}`, { tone: "info" });
              await refresh();
            },
          }, icon("x")),
        ]),
      );
    });
    aliases.appendChild(
      h("button", {
        class: "alias-chip",
        type: "button",
        title: "Add an alias",
        onclick: () => addAliasPrompt(tag),
      }, [icon("plus"), "alias"]),
    );

    const tasks = (store.get("tasks", []) || []).filter((task) => task.tag === tag.name);
    const spent = tasks.reduce((sum, task) => sum + Number(task.total_seconds || 0), 0);

    holder.appendChild(
      h("div", { class: `tag-row${tag.archived ? " is-archived" : ""}`, style: { "--tag-color": tag.color } }, [
        h("i", { class: "tag-dot", style: { background: tag.color } }),
        h("div", { class: "tag-row-main" }, [
          h("div", { class: "tag-row-name" }, [
            h("span", { class: "user-content" }, `#${tag.label}`),
            h("small", { class: "form-hint" }, `${tasks.length} task${tasks.length === 1 ? "" : "s"} · ${fmtShort(spent)}`),
            tag.default_minutes ? h("small", { class: "form-hint" }, `default ${tag.default_minutes}m`) : null,
          ]),
          aliases,
        ]),
        h("div", { class: "tag-row-actions" }, [
          h("button", {
            class: "icon-btn icon-btn-sm",
            type: "button",
            title: "Edit tag",
            onclick: () => editTagPrompt(tag),
          }, icon("pen")),
          h("button", {
            class: "icon-btn icon-btn-sm",
            type: "button",
            title: "Merge into another tag",
            onclick: () => mergeTagPrompt(tag),
          }, icon("split")),
          h("button", {
            class: "icon-btn icon-btn-sm",
            type: "button",
            title: tag.archived ? "Restore tag" : "Archive tag",
            onclick: async () => {
              await api.saveTag({ name: tag.name, archived: !tag.archived });
              await refresh();
            },
          }, icon(tag.archived ? "undo" : "inbox")),
          h("button", {
            class: "icon-btn icon-btn-sm",
            type: "button",
            title: "Delete tag",
            onclick: async () => {
              const ok = await confirmAction({
                title: `Delete #${tag.name}?`,
                text: `${tasks.length} task(s) will keep their text but lose the tag.`,
                okLabel: "Delete tag",
              });
              if (!ok) return;
              await api.deleteTag(tag.name);
              await refresh();
            },
          }, icon("trash")),
        ]),
      ]),
    );
  });
}

async function addAliasPrompt(tag) {
  const data = await formDialog({
    title: `New alias for #${tag.name}`,
    eyebrow: "Typing an alias anywhere a tag is accepted resolves to this tag",
    fields: [
      {
        name: "alias",
        label: "Alias (without the #)",
        type: "text",
        placeholder: "t",
        required: true,
        note: "Short is better: two or three characters you would never type by accident.",
      },
    ],
    submitLabel: "Add alias",
  });
  if (!data) return;
  try {
    await api.addAlias(data.alias, tag.name);
    toast(`#${data.alias.replace(/^#/, "")} → #${tag.name}`, { tone: "good" });
    await refresh();
  } catch (error) {
    toast(error.message || "Could not add the alias", { tone: "error" });
  }
}

async function editTagPrompt(tag) {
  const data = await formDialog({
    title: `Edit #${tag.name}`,
    fields: [
      { name: "label", label: "Display label", type: "text", value: tag.label },
      { name: "color", label: "Colour", type: "color", value: tag.color },
      { name: "icon", label: "Icon name", type: "text", value: tag.icon, note: "Eye, book, home, sparkles, briefcase, heart, star, bolt…" },
      { name: "default_minutes", label: "Default duration (minutes)", type: "number", value: tag.default_minutes, min: 0, max: 1440 },
      { name: "description", label: "Description", type: "text", value: tag.description || "" },
    ],
    submitLabel: "Save tag",
  });
  if (!data) return;
  await api.saveTag({ name: tag.name, ...data });
  await refresh();
}

async function mergeTagPrompt(tag) {
  const others = (store.get("tags", []) || []).filter((item) => item.name !== tag.name);
  const data = await formDialog({
    title: `Merge #${tag.name} into…`,
    eyebrow: "Tasks, aliases and colours move to the target tag",
    fields: [
      {
        name: "target",
        label: "Target tag",
        type: "select",
        value: others[0]?.name || "",
        options: others.map((item) => ({ value: item.name, label: `#${item.label}` })),
      },
    ],
    submitLabel: "Merge",
  });
  if (!data?.target) return;
  const result = await api.mergeTags(tag.name, data.target);
  toast(`Moved ${result?.result?.moved ?? 0} task(s) into #${data.target}`, { tone: "good" });
  await refresh();
}

export function initTags() {
  byId("addTagBtn")?.addEventListener("click", async () => {
    const data = await formDialog({
      title: "New tag",
      fields: [
        { name: "name", label: "Name", type: "text", placeholder: "reading", required: true },
        { name: "label", label: "Display label", type: "text", placeholder: "Reading" },
        { name: "color", label: "Colour", type: "color", value: "#9775FA" },
        { name: "aliases", label: "Aliases (comma separated)", type: "text", placeholder: "r, rd, read" },
        { name: "default_minutes", label: "Default duration (minutes)", type: "number", value: 30, min: 0, max: 1440 },
        { name: "icon", label: "Icon", type: "text", value: "tag" },
      ],
      submitLabel: "Create tag",
    });
    if (!data) return;
    const aliases = String(data.aliases || "")
      .split(/[,\s]+/)
      .map((value) => value.trim().replace(/^#/, ""))
      .filter(Boolean);
    await api.saveTag({ ...data, aliases });
    toast(`#${data.name} created${aliases.length ? ` with ${aliases.length} alias(es)` : ""}`, { tone: "good" });
    await refresh();
  });
}

/* --------------------------------------------------------------------------
   Data & backup
   -------------------------------------------------------------------------- */
export function initDataActions() {
  byId("exportBtn")?.addEventListener("click", async () => {
    try {
      const backup = await api.exportBackup();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      download(`taskarcade-${stamp}.json`, JSON.stringify(backup, null, 2));
      toast("Backup downloaded", { tone: "good" });
    } catch (error) {
      toast(error.message || "Could not export", { tone: "error" });
    }
  });

  byId("exportCsvBtn")?.addEventListener("click", () => {
    const rows = (store.get("tasks", []) || []).map((task) => ({
      day: task.day_index,
      title: task.title,
      tag: task.tag,
      priority: PRIORITY_LABELS[task.priority] || "",
      planned_minutes: Math.round(task.total_seconds / 60),
      remaining_minutes: Math.round(task.remaining_seconds / 60),
      focused_minutes: Math.round((task.focus_seconds || 0) / 60),
      done: task.done ? "yes" : "no",
      scheduled: task.scheduled_at,
      notes: (task.notes || "").replace(/\n/g, " "),
    }));
    const dayRows = statsCsv();
    download("taskarcade-tasks.csv", toCsv(rows), "text/csv");
    if (dayRows.length) download("taskarcade-days.csv", toCsv(dayRows), "text/csv");
    toast("CSV exported", { tone: "good" });
  });

  byId("importFile")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      const mode = await formDialog({
        title: "Import backup",
        eyebrow: file.name,
        eyebrowIsUserContent: true,
        fields: [
          {
            name: "mode",
            label: "How should it merge?",
            type: "select",
            value: "merge",
            options: [
              { value: "merge", label: "Merge — add rows, keep what exists" },
              { value: "replace", label: "Replace — wipe tasks, tags and templates first" },
            ],
            note: "An undo checkpoint is created before anything changes.",
          },
        ],
        submitLabel: "Import",
      });
      if (!mode) return;
      const result = await api.importBackup(backup, mode.mode);
      const restored = result?.result?.restored || {};
      toast(`Imported ${restored.tasks ?? 0} tasks, ${restored.tags ?? 0} tags`, { tone: "good", timeout: 5000 });
      await refresh();
    } catch (error) {
      toast(error.message || "That file is not a TaskArcade backup", { tone: "error" });
    } finally {
      event.target.value = "";
    }
  });

  byId("legacyImportBtn")?.addEventListener("click", async () => {
    const legacy = store.meta?.legacy || {};
    const ok = await confirmAction({
      title: "Adopt V0.1 data?",
      text: legacy.path
        ? `Found ${legacy.tasks} tasks and ${legacy.tags} tags in ${legacy.path}. They will be added to this database.`
        : "No V0.1 database was found on the server.",
      okLabel: "Adopt",
      danger: false,
    });
    if (!ok) return;
    try {
      const result = await api.legacyImport(legacy.path || null);
      const imported = result?.result?.imported || {};
      toast(`Adopted ${imported.tasks ?? 0} tasks and ${imported.tags ?? 0} tags`, { tone: "good" });
      await refresh();
    } catch (error) {
      toast(error.message || "Could not adopt the legacy database", { tone: "error" });
    }
  });

  byId("cleanupEventsBtn")?.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "Trim the activity log?",
      text: "Keeps the 800 most recent events and clears the redo stack.",
      okLabel: "Trim",
      danger: false,
    });
    if (!ok) return;
    const result = await api.cleanup(800);
    toast(`Removed ${result?.result?.events_removed ?? 0} events`, { tone: "good" });
    await refresh();
  });

  byId("resetTasksBtn")?.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "Delete every task?",
      text: "Tags, templates and settings are kept. Undo still works afterwards.",
      okLabel: "Delete tasks",
    });
    if (!ok) return;
    await api.reset("tasks");
    toast("All tasks removed", { tone: "warn" });
    await refresh();
  });

  byId("factoryResetBtn")?.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "Factory reset?",
      text: "Removes tasks, tags, aliases and history, and returns to day 1. An undo checkpoint is saved first.",
      okLabel: "Reset everything",
    });
    if (!ok) return;
    await api.reset("all");
    toast("Factory reset complete", { tone: "warn" });
    await refresh();
  });
}

/* --------------------------------------------------------------------------
   History
   -------------------------------------------------------------------------- */
export function renderHistory() {
  const holder = byId("historyList");
  if (!holder) return;
  const history = store.get("history", []) || [];
  clear(holder);
  if (!history.length) {
    holder.appendChild(h("li", { class: "form-hint" }, "No checkpoints yet — every edit creates one."));
    return;
  }
  history.forEach((entry) => {
    const item = h("li", { class: "history-item" }, [
      h("span", { class: `history-kind history-${entry.kind}` }, entry.kind),
      h("span", { class: "grow" }, [
        entry.label,
        h("small", { class: "form-hint" }, ` · ${relativeTime(entry.at)}`),
      ]),
    ]);
    item.style.cursor = "pointer";
    item.title = "Restore this checkpoint";
    item.addEventListener("click", () => restoreCheckpoint(entry));
    holder.appendChild(item);
  });

  const note = byId("storageNote");
  if (note) note.textContent = storageNote();
}

async function restoreCheckpoint(entry) {
  const ok = await confirmAction({
    title: `Undo back to “${entry.label}”?`,
    text: "Everything after this checkpoint is rolled back (and can be redone).",
    okLabel: "Roll back",
    danger: false,
  });
  if (!ok) return;
  const steps = (store.get("history", []) || []).findIndex((item) => item.id === entry.id) + 1;
  for (let index = 0; index < Math.max(1, steps); index += 1) {
    const result = await api.undo();
    if (!result?.result?.ok) break;
  }
  toast("Rolled back", { tone: "good" });
  await refresh();
}

export function initHistory() {
  byId("clearHistoryBtn")?.addEventListener("click", async () => {
    await api.clearHistory(null);
    toast("History cleared", { tone: "info" });
    await refresh();
  });
}

/* --------------------------------------------------------------------------
   Library view orchestration
   -------------------------------------------------------------------------- */
export function renderLibrary() {
  renderTemplates();
  renderRecurrences();
  renderTagTable();
  renderHistory();
}

export function initLibrary() {
  initTemplates();
  initRecurrences();
  initTags();
  initDataActions();
  initHistory();
  on("state", renderLibrary);
  on("switch-tab", ({ tab }) => {
    if (tab === "library") renderLibrary();
  });
}
