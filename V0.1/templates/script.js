/* =========================================================================
   Flowline — frontend logic
   - Loads/saves state against the Flask API (same-origin).
   - Renders virtual-day calendar columns with duration-proportional task
     blocks, drag & drop reordering, and a circular countdown ring for the
     active task.
   - Polls an external server (`/api/state`) every 10s for work/free mode,
     and deducts time from the active task every second while mode==work.
   ========================================================================= */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Global state
  // ------------------------------------------------------------------
  let APP = { settings: {}, tags: [], tasks: [], palette: [] };
  let selectedPaletteColor = null;
  let editingTaskId = null;

  let externalMode = null; // 'work' | 'free' | null
  let externalSessionId = localStorage.getItem("flowline_ext_session_id") || null;

  let localRemainingOverride = null; // { taskId, remaining } — smooth 1s ticking cache
  let lastPersistedRemaining = null;

  const RING_RADIUS = 68;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  // ------------------------------------------------------------------
  // DOM refs
  // ------------------------------------------------------------------
  const el = (id) => document.getElementById(id);

  const modeToggleBtn = el("modeToggleBtn");
  const modeLabel = el("modeLabel");
  const finishDayBtn = el("finishDayBtn");
  const settingsBtn = el("settingsBtn");
  const settingsModal = el("settingsModal");
  const closeSettingsBtn = el("closeSettingsBtn");
  const serverUrlInput = el("serverUrlInput");
  const saveServerUrlBtn = el("saveServerUrlBtn");
  const tagListEl = el("tagList");
  const newTagInput = el("newTagInput");
  const addTagBtn = el("addTagBtn");
  const paletteSwatchesEl = el("paletteSwatches");

  const viewSwitch = el("viewSwitch");
  const customDaysInput = el("customDaysInput");
  const toggleBulkBtn = el("toggleBulkBtn");
  const bulkPanel = el("bulkPanel");
  const bulkDaySelect = el("bulkDaySelect");
  const bulkTextarea = el("bulkTextarea");
  const bulkSubmitBtn = el("bulkSubmitBtn");
  const bulkError = el("bulkError");

  const calendarColumns = el("calendarColumns");

  const activePanel = el("activePanel");
  const ringProgress = el("ringProgress");
  const ringTime = el("ringTime");
  const ringSub = el("ringSub");
  const activeDayLabel = el("activeDayLabel");
  const activeTagChip = el("activeTagChip");
  const activeTitle = el("activeTitle");
  const activeSubtitle = el("activeSubtitle");
  const doneBtn = el("doneBtn");
  const skipBtn = el("skipBtn");

  const editModal = el("editModal");
  const closeEditBtn = el("closeEditBtn");
  const editTitleInput = el("editTitleInput");
  const editTagInput = el("editTagInput");
  const editDurationInput = el("editDurationInput");
  const deleteTaskBtn = el("deleteTaskBtn");
  const saveTaskBtn = el("saveTaskBtn");

  ringProgress.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;

  // ------------------------------------------------------------------
  // Formatting helpers
  // ------------------------------------------------------------------
  function formatDuration(totalSeconds) {
    totalSeconds = Math.max(0, Math.round(totalSeconds || 0));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) {
      return m > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
    }
    if (m > 0) {
      return `${m}m`;
    }
    return `${s}s`;
  }

  function tagColor(tagName) {
    const found = APP.tags.find((t) => t.name === tagName);
    return found ? found.color : "#9775FA";
  }

  // ------------------------------------------------------------------
  // API helpers
  // ------------------------------------------------------------------
  async function apiFetch(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch (e) {
        /* ignore */
      }
      const err = new Error(`API ${path} failed with ${res.status}`);
      err.body = body;
      throw err;
    }
    return res.json();
  }

  async function loadState() {
    const data = await apiFetch("/api/state");
    APP = data;
    render();
  }

  // ------------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------------
  function getDayRange() {
    const cur = APP.settings.current_day_index || 1;
    let count = 1;
    switch (APP.settings.view_mode) {
      case "3days":
        count = 3;
        break;
      case "week":
        count = 7;
        break;
      case "custom":
        count = Math.max(1, APP.settings.view_days || 1);
        break;
      default:
        count = 1;
    }
    const days = [];
    for (let i = 0; i < count; i++) days.push(cur + i);
    return days;
  }

  function tasksForDay(dayIndex) {
    return APP.tasks
      .filter((t) => t.day_index === dayIndex)
      .slice()
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return a.order_index - b.order_index;
      });
  }

  function getActiveTask() {
    const cur = APP.settings.current_day_index || 1;
    const dayTasks = tasksForDay(cur).filter((t) => !t.done);
    return dayTasks.length ? dayTasks[0] : null;
  }

  // Apply any locally-ticked (not-yet-persisted) remaining seconds on top of
  // the authoritative server state so the UI doesn't jump backwards.
  function effectiveRemaining(task) {
    if (localRemainingOverride && localRemainingOverride.taskId === task.id) {
      return localRemainingOverride.remaining;
    }
    return task.remaining_seconds;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function render() {
    renderModeButton();
    renderViewSwitch();
    renderSettingsPanelData();
    renderBulkDaySelect();
    renderCalendar();
    renderActivePanel();
  }

  function renderModeButton() {
    modeToggleBtn.classList.remove("mode-work", "mode-free", "mode-unknown");
    if (externalMode === "work") {
      modeToggleBtn.classList.add("mode-work");
      modeLabel.textContent = "mode: work";
    } else if (externalMode === "free") {
      modeToggleBtn.classList.add("mode-free");
      modeLabel.textContent = "mode: free";
    } else {
      modeToggleBtn.classList.add("mode-unknown");
      modeLabel.textContent = "mode: unknown";
    }
  }

  function renderViewSwitch() {
    const buttons = viewSwitch.querySelectorAll(".view-btn");
    buttons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === APP.settings.view_mode);
    });
    customDaysInput.classList.toggle("visible", APP.settings.view_mode === "custom");
    if (document.activeElement !== customDaysInput) {
      customDaysInput.value = APP.settings.view_days || 4;
    }
  }

  function renderSettingsPanelData() {
    if (document.activeElement !== serverUrlInput) {
      serverUrlInput.value = APP.settings.server_url || "";
    }
    tagListEl.innerHTML = "";
    APP.tags.forEach((tag) => {
      const row = document.createElement("div");
      row.className = "tag-row";
      row.innerHTML = `
        <span class="tag-swatch" style="background:${tag.color}"></span>
        <span>#${tag.name}</span>
        <button type="button" data-tag="${tag.name}" title="Delete tag"><i class="fa-solid fa-trash"></i></button>
      `;
      row.querySelector("button").addEventListener("click", () => deleteTag(tag.name));
      tagListEl.appendChild(row);
    });

    paletteSwatchesEl.innerHTML = "";
    (APP.palette || []).forEach((color) => {
      const dot = document.createElement("div");
      dot.className = "palette-dot";
      dot.style.background = color;
      if (color === selectedPaletteColor) dot.classList.add("selected");
      dot.addEventListener("click", () => {
        selectedPaletteColor = color;
        renderSettingsPanelData();
      });
      paletteSwatchesEl.appendChild(dot);
    });
  }

  function renderBulkDaySelect() {
    const days = getDayRange();
    const current = APP.settings.current_day_index || 1;
    const prevValue = bulkDaySelect.value;
    bulkDaySelect.innerHTML = "";
    days.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d === current ? `Day ${d} (current)` : `Day ${d}`;
      bulkDaySelect.appendChild(opt);
    });
    if (prevValue && days.includes(Number(prevValue))) {
      bulkDaySelect.value = prevValue;
    }
  }

  function renderCalendar() {
    const days = getDayRange();
    const current = APP.settings.current_day_index || 1;
    const activeTask = getActiveTask();

    calendarColumns.innerHTML = "";

    days.forEach((dayIndex) => {
      const dayTasks = tasksForDay(dayIndex);
      const totalSeconds = dayTasks.reduce((sum, t) => sum + t.total_seconds, 0);
      const remainingSeconds = dayTasks.reduce(
        (sum, t) => sum + (t.done ? 0 : effectiveRemaining(t)),
        0
      );
      const doneSeconds = totalSeconds - remainingSeconds;
      const pct = totalSeconds > 0 ? Math.min(100, (doneSeconds / totalSeconds) * 100) : 0;

      const column = document.createElement("div");
      column.className = "day-column" + (dayIndex === current ? " is-current" : "");
      column.dataset.day = dayIndex;

      column.innerHTML = `
        <div class="day-column-header">
          <div class="day-title-row">
            <h4>Day ${dayIndex}</h4>
            ${dayIndex === current ? '<span class="day-today-badge">Current</span>' : ""}
          </div>
          <div class="day-stats">
            <span>${dayTasks.length} task${dayTasks.length === 1 ? "" : "s"}</span>
            <span>${formatDuration(remainingSeconds)} left of ${formatDuration(totalSeconds)}</span>
          </div>
          <div class="day-progress-track"><div class="day-progress-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="day-tasks" data-day="${dayIndex}"></div>
      `;

      const tasksContainer = column.querySelector(".day-tasks");

      if (dayTasks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "day-empty";
        empty.textContent = "No tasks yet";
        tasksContainer.appendChild(empty);
      } else {
        dayTasks.forEach((task) => {
          tasksContainer.appendChild(buildTaskBlock(task, totalSeconds, activeTask));
        });
      }

      setupDragAndDrop(tasksContainer, dayIndex);
      calendarColumns.appendChild(column);
    });
  }

  function buildTaskBlock(task, columnTotalSeconds, activeTask) {
    const block = document.createElement("div");
    const isActive = activeTask && activeTask.id === task.id;
    block.className =
      "task-block" + (task.done ? " is-done" : "") + (isActive ? " is-active" : "");
    block.draggable = !task.done;
    block.dataset.id = task.id;
    block.style.setProperty("--tag-color", tagColor(task.tag));

    const heightRatio = columnTotalSeconds > 0 ? task.total_seconds / columnTotalSeconds : 0;
    const minHeight = 64;
    const scaledHeight = Math.max(minHeight, heightRatio * 520);
    block.style.minHeight = `${scaledHeight}px`;

    const remaining = task.done ? 0 : effectiveRemaining(task);
    const progressPct = task.total_seconds > 0
      ? Math.min(100, ((task.total_seconds - remaining) / task.total_seconds) * 100)
      : 0;

    block.innerHTML = `
      <div class="task-top">
        <span class="task-title">${escapeHtml(task.title)}</span>
        <button type="button" class="task-edit-btn" title="Edit task"><i class="fa-solid fa-pen"></i></button>
      </div>
      <div class="task-meta-row">
        <span class="task-tag-pill">#${escapeHtml(task.tag)}</span>
        <span class="task-duration">${task.done ? "done" : formatDuration(remaining)}</span>
      </div>
      <div class="task-mini-progress"><div class="task-mini-progress-fill" style="width:${progressPct}%"></div></div>
    `;

    block.querySelector(".task-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(task);
    });

    return block;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function renderActivePanel() {
    const activeTask = getActiveTask();
    const current = APP.settings.current_day_index || 1;

    if (!activeTask) {
      activePanel.classList.add("inactive");
      activeDayLabel.textContent = `Day ${current}`;
      activeTagChip.textContent = "—";
      activeTitle.textContent = "All tasks complete 🎉";
      activeSubtitle.textContent = "Press Finish Day to move on, or bulk add more tasks.";
      doneBtn.disabled = true;
      skipBtn.disabled = true;
      setRing(0, 1);
      ringTime.textContent = "--";
      ringSub.textContent = "remaining";
      return;
    }

    doneBtn.disabled = false;
    skipBtn.disabled = false;

    activeDayLabel.textContent = `Day ${activeTask.day_index}`;
    activeTagChip.textContent = `#${activeTask.tag}`;
    activeTagChip.style.background = `${tagColor(activeTask.tag)}2e`;
    activeTagChip.style.color = tagColor(activeTask.tag);
    activeTitle.textContent = activeTask.title;
    activeSubtitle.textContent = `Total duration ${formatDuration(activeTask.total_seconds)}`;

    const remaining = effectiveRemaining(activeTask);
    ringTime.textContent = formatDuration(remaining);
    ringSub.textContent = externalMode === "work" ? "counting down" : externalMode === "free" ? "paused (free)" : "remaining";
    setRing(remaining, activeTask.total_seconds);
  }

  function setRing(remaining, total) {
    const safeTotal = total > 0 ? total : 1;
    const fraction = Math.max(0, Math.min(1, remaining / safeTotal));
    const offset = RING_CIRCUMFERENCE * (1 - fraction);
    ringProgress.style.strokeDashoffset = `${offset}`;
  }

  // ------------------------------------------------------------------
  // Drag & drop reordering (within a single day column)
  // ------------------------------------------------------------------
  let dragState = null;

  function setupDragAndDrop(container, dayIndex) {
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      container.classList.add("drag-over");
      const afterElement = getDragAfterElement(container, e.clientY);
      const dragging = document.querySelector(".task-block.dragging");
      if (!dragging) return;
      if (afterElement == null) {
        container.appendChild(dragging);
      } else {
        container.insertBefore(dragging, afterElement);
      }
    });

    container.addEventListener("dragleave", () => {
      container.classList.remove("drag-over");
    });

    container.addEventListener("drop", async (e) => {
      e.preventDefault();
      container.classList.remove("drag-over");
      if (!dragState || dragState.dayIndex !== dayIndex) return;
      const ids = Array.from(container.querySelectorAll(".task-block")).map((b) =>
        Number(b.dataset.id)
      );
      dragState = null;
      try {
        await apiFetch("/api/tasks/reorder", {
          method: "POST",
          body: JSON.stringify({ order: ids }),
        });
        await loadState();
      } catch (err) {
        console.error("Failed to reorder tasks:", err);
        await loadState();
      }
    });

    container.querySelectorAll(".task-block").forEach((block) => {
      block.addEventListener("dragstart", () => {
        block.classList.add("dragging");
        dragState = { dayIndex, id: Number(block.dataset.id) };
      });
      block.addEventListener("dragend", () => {
        block.classList.remove("dragging");
      });
    });
  }

  function getDragAfterElement(container, y) {
    const items = [...container.querySelectorAll(".task-block:not(.dragging)")];
    return items.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: null }
    ).element;
  }

  // ------------------------------------------------------------------
  // Task actions
  // ------------------------------------------------------------------
  async function markDone(taskId) {
    try {
      await apiFetch(`/api/tasks/${taskId}/done`, { method: "POST" });
      clearLocalOverrideIfMatches(taskId);
      await loadState();
    } catch (err) {
      console.error("Failed to mark task done:", err);
    }
  }

  async function skipTask(taskId) {
    try {
      const remaining = localRemainingOverride && localRemainingOverride.taskId === taskId
        ? localRemainingOverride.remaining
        : null;
      if (remaining !== null) {
        await apiFetch(`/api/tasks/${taskId}/tick`, {
          method: "POST",
          body: JSON.stringify({ remaining_seconds: remaining }),
        });
      }
      await apiFetch(`/api/tasks/${taskId}/skip`, { method: "POST" });
      clearLocalOverrideIfMatches(taskId);
      await loadState();
    } catch (err) {
      console.error("Failed to skip task:", err);
    }
  }

  function clearLocalOverrideIfMatches(taskId) {
    if (localRemainingOverride && localRemainingOverride.taskId === taskId) {
      localRemainingOverride = null;
      lastPersistedRemaining = null;
    }
  }

  async function finishDay() {
    try {
      localRemainingOverride = null;
      lastPersistedRemaining = null;
      await apiFetch("/api/day/finish", { method: "POST" });
      await loadState();
    } catch (err) {
      console.error("Failed to finish day:", err);
    }
  }

  // ------------------------------------------------------------------
  // Edit task modal
  // ------------------------------------------------------------------
  function openEditModal(task) {
    editingTaskId = task.id;
    editTitleInput.value = task.title;
    editTagInput.value = task.tag;
    editDurationInput.value = formatDuration(task.total_seconds);
    editModal.classList.add("visible");
  }

  function closeEditModal() {
    editModal.classList.remove("visible");
    editingTaskId = null;
  }

  async function saveTaskEdits() {
    if (editingTaskId == null) return;
    try {
      await apiFetch(`/api/tasks/${editingTaskId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: editTitleInput.value,
          tag: editTagInput.value.replace(/^#/, ""),
          duration_text: editDurationInput.value,
        }),
      });
      closeEditModal();
      await loadState();
    } catch (err) {
      console.error("Failed to save task edits:", err);
      alert("Could not save task. Check the duration format (e.g. 1h25m, 90m).");
    }
  }

  async function deleteTask() {
    if (editingTaskId == null) return;
    try {
      await apiFetch(`/api/tasks/${editingTaskId}`, { method: "DELETE" });
      closeEditModal();
      await loadState();
    } catch (err) {
      console.error("Failed to delete task:", err);
    }
  }

  // ------------------------------------------------------------------
  // Bulk add
  // ------------------------------------------------------------------
  async function submitBulkAdd() {
    bulkError.textContent = "";
    const text = bulkTextarea.value.trim();
    if (!text) {
      bulkError.textContent = "Paste at least one task line.";
      return;
    }
    try {
      const data = await apiFetch("/api/tasks/bulk", {
        method: "POST",
        body: JSON.stringify({ text, day_index: Number(bulkDaySelect.value) }),
      });
      APP = data;
      render();
      bulkTextarea.value = "";
      if (data.bad_lines && data.bad_lines.length) {
        bulkError.textContent = `Skipped ${data.bad_lines.length} line(s) with invalid format.`;
        console.warn("Skipped bulk lines:", data.bad_lines);
      }
    } catch (err) {
      console.error("Failed to add bulk tasks:", err);
      const msg = err.body && err.body.error ? err.body.error : "Could not parse any task lines.";
      bulkError.textContent = msg;
    }
  }

  // ------------------------------------------------------------------
  // Settings: server URL + tags
  // ------------------------------------------------------------------
  async function saveServerUrl() {
    try {
      await apiFetch("/api/settings", {
        method: "POST",
        body: JSON.stringify({ server_url: serverUrlInput.value.trim() }),
      });
      await loadState();
      externalMode = null;
      externalSessionId = null;
      localStorage.removeItem("flowline_ext_session_id");
      renderModeButton();
      pollExternalState();
    } catch (err) {
      console.error("Failed to save server URL:", err);
    }
  }

  async function addTag() {
    const name = newTagInput.value.trim().replace(/^#/, "");
    if (!name) return;
    try {
      await apiFetch("/api/tags", {
        method: "POST",
        body: JSON.stringify({ name, color: selectedPaletteColor }),
      });
      newTagInput.value = "";
      selectedPaletteColor = null;
      await loadState();
    } catch (err) {
      console.error("Failed to add tag:", err);
    }
  }

  async function deleteTag(name) {
    try {
      await apiFetch(`/api/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
      await loadState();
    } catch (err) {
      console.error("Failed to delete tag:", err);
    }
  }

  async function setViewMode(mode) {
    try {
      const payload = { view_mode: mode };
      if (mode === "custom") {
        payload.view_days = Number(customDaysInput.value) || 4;
      }
      await apiFetch("/api/settings", { method: "POST", body: JSON.stringify(payload) });
      await loadState();
    } catch (err) {
      console.error("Failed to update view mode:", err);
    }
  }

  // ------------------------------------------------------------------
  // External server polling (mode detection) — every 10 seconds
  // ------------------------------------------------------------------
  async function pollExternalState() {
    const base = (APP.settings.server_url || "").trim();
    if (!base) {
      return;
    }
    const url = base.replace(/\/+$/, "") + "/api/state";
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Unexpected status ${res.status}`);
      }
      const data = await res.json();

      const kind = data && data.session && data.session.current && data.session.current.kind;
      if (kind === "work" || kind === "free") {
        externalMode = kind;
      } else {
        console.warn("[Flowline] /api/state response missing session.current.kind:", data);
      }

      const sid = data && data.sessions && data.sessions[0] && data.sessions[0].id;
      if (sid) {
        externalSessionId = sid;
        localStorage.setItem("flowline_ext_session_id", sid);
      } else {
        console.warn("[Flowline] /api/state response missing sessions[0].id:", data);
      }

      renderModeButton();
      renderActivePanel();
    } catch (err) {
      console.error("[Flowline] Failed to poll external /api/state:", err);
    }
  }

  async function toggleExternalMode() {
    const base = (APP.settings.server_url || "").trim();
    if (!base) {
      console.error("[Flowline] No external server URL configured. Set it in Settings.");
      settingsModal.classList.add("visible");
      return;
    }
    if (!externalSessionId) {
      console.error("[Flowline] No external session id known yet. Waiting for next poll.");
      return;
    }
    const newMode = externalMode === "work" ? "free" : "work";
    const url = `${base.replace(/\/+$/, "")}/api/sessions/099e95e6/mode?s=${encodeURIComponent(externalSessionId)}`;
    const payload = JSON.stringify({ mode: newMode });

    try {
      let res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      if (res.status === 405) {
        console.warn("[Flowline] POST not allowed for mode toggle, retrying with PUT.");
        res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
      }
      if (!res.ok) {
        throw new Error(`Mode toggle failed with status ${res.status}`);
      }
      externalMode = newMode;
      renderModeButton();
      renderActivePanel();
    } catch (err) {
      console.error("[Flowline] Failed to toggle external mode:", err);
    }
  }

  // ------------------------------------------------------------------
  // Local countdown ticking (every 1s) — only deducts while mode == work
  // ------------------------------------------------------------------
  function tickActiveTask() {
    if (externalMode !== "work") return;
    const activeTask = getActiveTask();
    if (!activeTask) return;

    let remaining = effectiveRemaining(activeTask);
    remaining = Math.max(0, remaining - 1);
    localRemainingOverride = { taskId: activeTask.id, remaining };

    updateActiveRingLive(activeTask, remaining);
    updateTaskBlockLive(activeTask.id, remaining, activeTask.total_seconds);

    if (remaining <= 0) {
      persistTick(activeTask.id, 0).finally(() => {
        markDone(activeTask.id);
      });
    }
  }

  function updateActiveRingLive(task, remaining) {
    const active = getActiveTask();
    if (!active || active.id !== task.id) return;
    ringTime.textContent = formatDuration(remaining);
    setRing(remaining, task.total_seconds);
  }

  function updateTaskBlockLive(taskId, remaining, total) {
    const block = document.querySelector(`.task-block[data-id="${taskId}"]`);
    if (!block) return;
    const durationEl = block.querySelector(".task-duration");
    if (durationEl) durationEl.textContent = formatDuration(remaining);
    const fillEl = block.querySelector(".task-mini-progress-fill");
    if (fillEl && total > 0) {
      const pct = Math.min(100, ((total - remaining) / total) * 100);
      fillEl.style.width = `${pct}%`;
    }
  }

  async function persistTick(taskId, remainingSeconds) {
    try {
      await apiFetch(`/api/tasks/${taskId}/tick`, {
        method: "POST",
        body: JSON.stringify({ remaining_seconds: remainingSeconds }),
      });
      lastPersistedRemaining = remainingSeconds;
    } catch (err) {
      console.error("[Flowline] Failed to persist task tick:", err);
    }
  }

  function periodicPersist() {
    if (!localRemainingOverride) return;
    if (lastPersistedRemaining === localRemainingOverride.remaining) return;
    persistTick(localRemainingOverride.taskId, localRemainingOverride.remaining);
  }

  // ------------------------------------------------------------------
  // Event wiring
  // ------------------------------------------------------------------
  modeToggleBtn.addEventListener("click", toggleExternalMode);
  finishDayBtn.addEventListener("click", finishDay);

  settingsBtn.addEventListener("click", () => settingsModal.classList.add("visible"));
  closeSettingsBtn.addEventListener("click", () => settingsModal.classList.remove("visible"));
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) settingsModal.classList.remove("visible");
  });

  saveServerUrlBtn.addEventListener("click", saveServerUrl);
  addTagBtn.addEventListener("click", addTag);

  doneBtn.addEventListener("click", () => {
    const task = getActiveTask();
    if (task) markDone(task.id);
  });
  skipBtn.addEventListener("click", () => {
    const task = getActiveTask();
    if (task) skipTask(task.id);
  });

  viewSwitch.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => setViewMode(btn.dataset.view));
  });
  customDaysInput.addEventListener("change", () => {
    if (APP.settings.view_mode === "custom") setViewMode("custom");
  });

  toggleBulkBtn.addEventListener("click", () => {
    bulkPanel.classList.toggle("visible");
  });
  bulkSubmitBtn.addEventListener("click", submitBulkAdd);

  closeEditBtn.addEventListener("click", closeEditModal);
  editModal.addEventListener("click", (e) => {
    if (e.target === editModal) closeEditModal();
  });
  saveTaskBtn.addEventListener("click", saveTaskEdits);
  deleteTaskBtn.addEventListener("click", deleteTask);

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  async function boot() {
    await loadState();
    pollExternalState();
    setInterval(pollExternalState, 10000);
    setInterval(tickActiveTask, 1000);
    setInterval(periodicPersist, 5000);
    window.addEventListener("beforeunload", () => {
      if (localRemainingOverride) {
        const url = `/api/tasks/${localRemainingOverride.taskId}/tick`;
        const blob = new Blob(
          [JSON.stringify({ remaining_seconds: localRemainingOverride.remaining })],
          { type: "application/json" }
        );
        navigator.sendBeacon(url, blob);
      }
    });
  }

  boot();
})();
