/* ==========================================================================
   Projects workspace
   ========================================================================== */

import { byId, calendarDayLabel, clear, h, icon, store } from "./core.js";
import { api } from "./api.js";
import { openSheet, closeSheet, toast, confirmAction } from "./ui.js";
import { openTaskSheet } from "./tasks.js";
import { t } from "./i18n.js";

let refreshImpl = async () => {};
let activeFilter = "open";
let editingProjectId = 0;

export function provideRefresh(fn) {
  refreshImpl = fn;
}

export function initProjectsUI() {
  byId("newProjectBtn")?.addEventListener("click", () => openProjectSheet());
  byId("createFirstProjectBtn")?.addEventListener("click", () => openProjectSheet());
  byId("projectSheetClose")?.addEventListener("click", () => closeSheet("projectSheet"));
  byId("projectCancelBtn")?.addEventListener("click", () => closeSheet("projectSheet"));
  byId("projectForm")?.addEventListener("submit", saveProject);
  byId("projectFilter")?.addEventListener("change", (event) => {
    activeFilter = event.target.value || "open";
    renderProjects();
  });
  byId("projectsGrid")?.addEventListener("click", (event) => {
    const control = event.target.closest("[data-project-action]");
    if (!control) return;
    const project = (store.get("projects", []) || []).find((item) => Number(item.id) === Number(control.dataset.id));
    if (!project) return;
    const action = control.dataset.projectAction;
    if (action === "edit") openProjectSheet(project);
    else if (action === "archive") toggleArchive(project);
    else if (action === "delete") deleteProject(project);
    else if (action === "task") {
      event.stopPropagation();
      openTaskSheet(Number(control.dataset.taskId));
    }
  });

  const colorInput = byId("projectColor");
  colorInput?.addEventListener("input", () => {
    byId("projectColorPreview")?.style.setProperty("--project-color", colorInput.value);
  });
}

export function renderProjects() {
  const grid = byId("projectsGrid");
  if (!grid) return;
  const projects = store.get("projects", []) || [];
  const tasks = store.get("tasks", []) || [];
  const openProjects = projects.filter((project) => !["archived", "completed"].includes(project.status));
  const completed = projects.filter((project) => project.status === "completed").length;
  const totalOpenTasks = projects.reduce((sum, project) => sum + Number(project.open_count || 0), 0);

  const activeCount = byId("projectsActiveCount");
  const taskCount = byId("projectsTaskCount");
  const completeCount = byId("projectsCompletedCount");
  if (activeCount) activeCount.textContent = String(openProjects.length);
  if (taskCount) taskCount.textContent = String(totalOpenTasks);
  if (completeCount) completeCount.textContent = String(completed);

  const filtered = projects.filter((project) => {
    if (activeFilter === "open") return project.status !== "archived";
    if (activeFilter === "active") return project.status === "active";
    if (activeFilter === "completed") return project.status === "completed";
    if (activeFilter === "archived") return project.status === "archived";
    return true;
  });

  clear(grid);
  filtered.forEach((project) => grid.appendChild(projectCard(project, tasks)));
  const empty = byId("projectsEmpty");
  if (empty) empty.hidden = filtered.length > 0;
  const emptyTitle = byId("projectsEmptyTitle");
  const emptyNote = byId("projectsEmptyNote");
  if (!filtered.length && emptyTitle && emptyNote) {
    const hasProjects = projects.length > 0;
    emptyTitle.textContent = t(hasProjects ? "No projects in this view" : "Give your work a home");
    emptyNote.textContent = t(hasProjects
      ? "Change the filter to see your other projects."
      : "Create a project, then link tasks to it from the task editor.");
  }
}

function projectCard(project, allTasks) {
  const projectTasks = allTasks.filter((task) => Number(task.project_id) === Number(project.id) && !task.archived);
  const recentTasks = projectTasks.slice().sort((a, b) => Number(a.done) - Number(b.done) || Number(a.order_index) - Number(b.order_index)).slice(0, 4);
  const progress = Math.max(0, Math.min(100, Number(project.progress || 0)));
  const statusLabel = {
    active: "Active",
    on_hold: "On hold",
    completed: "Completed",
    archived: "Archived",
  }[project.status] || "Active";
  const translatedStatus = t(statusLabel);

  const preview = h("div", { class: "project-task-preview" });
  if (recentTasks.length) {
    recentTasks.forEach((task) => preview.appendChild(h("button", {
      class: `project-task${task.done ? " is-done" : ""}`,
      type: "button",
      dataset: { projectAction: "task", id: String(project.id), taskId: String(task.id) },
      title: t("Open task"),
    }, [
      h("span", { class: "project-task-check", "aria-hidden": "true" }, task.done ? "✓" : ""),
      h("span", { class: "project-task-name" }, task.title),
      h("span", { class: "project-task-time" }, formatDuration(task.remaining_seconds)),
    ])));
  } else {
    preview.appendChild(h("p", { class: "project-no-tasks" }, t("No tasks linked yet. Open a task and choose this project.")));
  }

  const article = h("article", {
    class: `project-card${project.status === "archived" ? " is-archived" : ""}`,
    style: { "--project-color": project.color || "#4f46e5" },
  }, [
    h("div", { class: "project-card-accent" }),
    h("header", { class: "project-card-head" }, [
      h("span", { class: "project-mark", "aria-hidden": "true" }, icon("briefcase")),
      h("span", { class: `project-status status-${project.status}` }, translatedStatus),
      h("span", { class: "grow" }),
      h("button", { class: "icon-btn icon-btn-sm", type: "button", title: t("Edit project"), "aria-label": `${t("Edit project")}: ${project.name}`, dataset: { projectAction: "edit", id: String(project.id) } }, icon("pen")),
      h("button", { class: "icon-btn icon-btn-sm", type: "button", title: t(project.status === "archived" ? "Restore project" : "Archive project"), "aria-label": `${t(project.status === "archived" ? "Restore project" : "Archive project")}: ${project.name}`, dataset: { projectAction: "archive", id: String(project.id) } }, icon(project.status === "archived" ? "undo" : "archive")),
      h("button", { class: "icon-btn icon-btn-sm", type: "button", title: t("Delete project"), "aria-label": `${t("Delete project")}: ${project.name}`, dataset: { projectAction: "delete", id: String(project.id) } }, icon("trash")),
    ]),
    h("div", { class: "project-card-title-wrap" }, [
      h("h2", { class: "project-name" }, project.name),
      project.description ? h("p", { class: "project-description" }, project.description) : null,
      Number(project.target_day) > 0 ? h("span", { class: "project-target-day" }, [icon("calendar"), `${t("Target")}: ${calendarDayLabel(project.target_day)}`]) : null,
    ]),
    h("div", { class: "project-progress-wrap" }, [
      h("div", { class: "project-progress-track", role: "progressbar", "aria-label": `${progress}% ${t("complete")}`, "aria-valuenow": String(Math.round(progress)), "aria-valuemin": "0", "aria-valuemax": "100" }, [
        h("span", { style: { width: `${progress}%` } }),
      ]),
      h("span", { class: "project-progress-value" }, `${Math.round(progress)}%`),
    ]),
    h("div", { class: "project-metrics" }, [
      metric(String(project.open_count || 0), "Open tasks"),
      metric(String(project.completed_count || 0), "Completed"),
      metric(formatDuration(project.planned_seconds), "Planned time"),
    ]),
    h("div", { class: "project-task-section" }, [
      h("div", { class: "project-task-section-head" }, [h("strong", {}, t("Task list")), h("span", {}, `${project.task_count || 0} ${t("total")}`)]),
      preview,
    ]),
  ]);
  return article;
}

function metric(value, label) {
  return h("div", { class: "project-metric" }, [
    h("strong", {}, value),
    h("span", {}, t(label)),
  ]);
}

function openProjectSheet(project = null) {
  editingProjectId = Number(project?.id || 0);
  const form = byId("projectForm");
  if (!form) return;
  byId("projectSheetTitle").textContent = t(project ? "Edit project" : "New project");
  byId("projectName").value = project?.name || "";
  byId("projectDescription").value = project?.description || "";
  byId("projectColor").value = project?.color || "#4f46e5";
  byId("projectStatus").value = project?.status || "active";
  byId("projectTargetDay").value = project?.target_day || "";
  byId("projectColorPreview")?.style.setProperty("--project-color", byId("projectColor").value);
  byId("projectFormError").textContent = "";
  openSheet("projectSheet");
  window.setTimeout(() => byId("projectName")?.focus(), 80);
}

async function saveProject(event) {
  event.preventDefault();
  const name = byId("projectName").value.trim();
  if (!name) {
    byId("projectFormError").textContent = t("Please enter a project name.");
    byId("projectName").focus();
    return;
  }
  const payload = {
    name,
    description: byId("projectDescription").value.trim(),
    color: byId("projectColor").value,
    status: byId("projectStatus").value,
    target_day: Number(byId("projectTargetDay").value || 0),
  };
  const save = byId("projectSaveBtn");
  save.disabled = true;
  try {
    if (editingProjectId) await api.updateProject(editingProjectId, payload);
    else await api.createProject(payload);
    closeSheet("projectSheet");
    await refreshImpl();
    toast(t(editingProjectId ? "Project updated" : "Project created"), { tone: "good" });
  } catch (error) {
    byId("projectFormError").textContent = t(error.message || "Could not save this project.");
  } finally {
    save.disabled = false;
  }
}

async function toggleArchive(project) {
  const restore = project.status === "archived";
  try {
    await api.updateProject(project.id, { status: restore ? "active" : "archived" });
    await refreshImpl();
    toast(t(restore ? "Project restored" : "Project archived"), { tone: "good" });
  } catch (error) {
    toast(t(error.message || "Could not update this project"), { tone: "error" });
  }
}

async function deleteProject(project) {
  const ok = await confirmAction({
    title: `${t("Delete project")}: ${project.name}?`,
    text: t("Linked tasks will stay in your timeline but will no longer belong to a project."),
    okLabel: t("Delete project"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteProject(project.id);
    await refreshImpl();
    toast(t("Project deleted; linked tasks were kept"), { tone: "good" });
  } catch (error) {
    toast(t(error.message || "Could not delete this project"), { tone: "error" });
  }
}

function formatDuration(seconds = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  if (!value) return "0m";
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return hours ? `${hours}h ${minutes ? `${minutes}m` : ""}`.trim() : `${minutes}m`;
}
