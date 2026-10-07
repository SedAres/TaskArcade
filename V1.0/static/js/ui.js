/* ==========================================================================
   TaskArcade — UI primitives
   Sheets (bottom sheet on mobile, centred panel on desktop), confirm dialogs,
   toasts, action lists, generated form dialogs and the pull-to-refresh feel.
   ========================================================================== */

import { $, $$, byId, h, icon, clear, emit, on, clamp, prefersReducedMotion } from "./core.js";

let openSheets = [];
let previousFocus = null;

/* --------------------------------------------------------------------------
   Sheet plumbing
   -------------------------------------------------------------------------- */
export function initSheets() {
  $$("[data-close-sheet]").forEach((button) => {
    button.addEventListener("click", () => closeSheet(button.closest(".sheet")));
  });

  $$(".sheet").forEach((sheet) => {
    sheet.addEventListener("mousedown", (event) => {
      if (event.target === sheet) closeSheet(sheet);
    });
    sheet.addEventListener("touchstart", (event) => {
      if (event.target === sheet) closeSheet(sheet);
    }, { passive: true });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openSheets.length) {
      event.stopPropagation();
      closeSheet(openSheets[openSheets.length - 1]);
    }
  });
}

export function openSheet(target) {
  const sheet = typeof target === "string" ? byId(target) : target;
  if (!sheet) return null;
  previousFocus = document.activeElement;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  if (!openSheets.includes(sheet)) openSheets.push(sheet);
  syncScrim();
  const focusable = sheet.querySelector(
    "input:not([type=hidden]):not([disabled]), textarea, select, button:not([data-close-sheet])",
  );
  window.setTimeout(() => {
    if (focusable && !sheet.dataset.noAutofocus) focusable.focus({ preventScroll: true });
  }, 60);
  emit("sheet-open", { id: sheet.id });
  return sheet;
}

export function closeSheet(target = null) {
  const sheet = target ? (typeof target === "string" ? byId(target) : target) : openSheets[openSheets.length - 1];
  if (!sheet) return;
  sheet.classList.remove("is-open");
  openSheets = openSheets.filter((item) => item !== sheet);
  window.setTimeout(() => {
    if (!sheet.classList.contains("is-open")) sheet.hidden = true;
  }, 140);
  syncScrim();
  if (!openSheets.length && previousFocus && document.contains(previousFocus)) {
    previousFocus.focus({ preventScroll: true });
  }
  emit("sheet-close", { id: sheet.id });
}

export function closeAllSheets() {
  [...openSheets].forEach((sheet) => closeSheet(sheet));
}

function syncScrim() {
  const scrim = byId("scrim");
  if (!scrim) return;
  const anyOpen = openSheets.length > 0;
  scrim.hidden = !anyOpen;
}

export function toggleSheet(id) {
  const sheet = byId(id);
  if (!sheet) return;
  if (sheet.classList.contains("is-open")) closeSheet(sheet);
  else openSheet(sheet);
}

/* --------------------------------------------------------------------------
   Toasts
   -------------------------------------------------------------------------- */
const TOAST_ICONS = { good: "check", warn: "bell", error: "x", info: "sparkles" };

function localized(value) {
  return window.TaskArcadeI18n?.t?.(value) ?? value;
}

export function toast(message, { tone = "info", timeout = 3400, action = null } = {}) {
  const container = byId("toasts");
  if (!container) return null;
  const node = h("div", { class: `toast toast-${tone}` }, [
    icon(TOAST_ICONS[tone] || "sparkles"),
    h("span", { class: "grow" }, localized(String(message ?? ""))),
    action
      ? h("button", {
          class: "toast-action",
          type: "button",
          onclick: () => {
            action.run();
            dismiss();
          },
        }, action.label)
      : null,
  ]);

  const dismiss = () => {
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), 240);
  };

  container.appendChild(node);
  if (timeout) window.setTimeout(dismiss, timeout);
  return { dismiss, node };
}

/* --------------------------------------------------------------------------
   Confirm dialog
   -------------------------------------------------------------------------- */
export function confirmAction({ title = "Are you sure?", text = "", okLabel = "Confirm", danger = true } = {}) {
  return new Promise((resolve) => {
    const dialog = byId("confirmDialog");
    if (!dialog) return resolve(window.confirm(`${localized(title)}\n\n${localized(text)}`));
    byId("confirmTitle").textContent = localized(title);
    byId("confirmText").textContent = localized(text);
    const ok = byId("confirmOk");
    const cancel = byId("confirmCancel");
    ok.textContent = localized(okLabel);
    ok.className = danger ? "btn btn-danger" : "btn btn-primary";
    dialog.hidden = false;

    const finish = (value) => {
      dialog.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (event) => {
      if (event.target === dialog) finish(false);
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("click", onBackdrop);
    window.setTimeout(() => cancel.focus(), 30);
  });
}

/* --------------------------------------------------------------------------
   Action sheet — an array of {label, icon, danger, run, hint}
   -------------------------------------------------------------------------- */
export function actionSheet(title, actions, { userTitle = false } = {}) {
  const list = byId("actionSheetList");
  const sheet = byId("actionSheet");
  if (!list || !sheet) return;
  byId("actionSheetTitle").textContent = userTitle ? String(title || "") : localized(title || "Actions");
  clear(list);
  actions.filter(Boolean).forEach((action) => {
    const node = h("button", {
      class: `action-item${action.danger ? " is-danger" : ""}`,
      type: "button",
      onclick: () => {
        closeSheet(sheet);
        window.setTimeout(() => action.run?.(), 130);
      },
    }, [
      action.icon ? icon(action.icon) : null,
      h("span", { class: "grow" }, action.label),
      action.hint ? h("small", {}, action.hint) : null,
    ]);
    list.appendChild(node);
  });
  openSheet(sheet);
}

/* --------------------------------------------------------------------------
   Generated form dialog
   Field spec: {name, label, type, value, placeholder, options, min, max, step, note, required}
   -------------------------------------------------------------------------- */
export function formDialog({ title = "Form", eyebrow = "", eyebrowIsUserContent = false, fields = [], submitLabel = "Save" }) {
  return new Promise((resolve) => {
    const sheet = byId("formSheet");
    const body = byId("formSheetBody");
    const submit = byId("formSubmitBtn");
    if (!sheet || !body) return resolve(null);

    byId("formSheetTitle").textContent = localized(title);
    byId("formSheetEyebrow").textContent = eyebrowIsUserContent ? String(eyebrow || "") : localized(eyebrow);
    submit.textContent = localized(submitLabel);
    clear(body);

    const inputs = {};
    fields.forEach((field) => {
      const id = `form-${field.name}`;
      let control;
      if (field.type === "select") {
        control = h(
          "select",
          { id },
          (field.options || []).map((option) =>
            h("option", { value: option.value, selected: String(option.value) === String(field.value), "data-no-translate": ["tag", "task_id", "target", "title"].includes(field.name) }, option.label),
          ),
        );
      } else if (field.type === "textarea") {
        control = h("textarea", { id, rows: field.rows || 3, placeholder: field.placeholder || "", value: field.value ?? "" });
      } else if (field.type === "checkbox") {
        control = h("input", { id, type: "checkbox", checked: !!field.value });
      } else {
        control = h("input", {
          id,
          type: field.type || "text",
          value: field.value ?? "",
          placeholder: field.placeholder || "",
          min: field.min,
          max: field.max,
          step: field.step,
          autocomplete: "off",
          spellcheck: "false",
        });
      }
      inputs[field.name] = control;
      body.appendChild(
        h("div", { class: "field" }, [
          h("label", { for: id }, field.label),
          control,
          field.note ? h("small", {}, field.note) : null,
        ]),
      );
    });

    const finish = (value) => {
      submit.removeEventListener("click", onOk);
      sheet.removeEventListener("click", onBackdrop);
      closeSheet(sheet);
      resolve(value);
    };

    const collect = () => {
      const data = {};
      fields.forEach((field) => {
        const control = inputs[field.name];
        if (field.type === "checkbox") data[field.name] = control.checked;
        else if (field.type === "number") data[field.name] = Number(control.value);
        else data[field.name] = control.value;
      });
      return data;
    };

    const onOk = () => {
      const data = collect();
      const missing = fields.find((field) => field.required && !String(data[field.name] ?? "").trim());
      if (missing) {
        toast(`${missing.label} is required`, { tone: "warn" });
        inputs[missing.name].focus();
        return;
      }
      finish(data);
    };
    const onBackdrop = (event) => {
      if (event.target === sheet) finish(null);
    };

    submit.addEventListener("click", onOk);
    sheet.addEventListener("click", onBackdrop);
    openSheet(sheet);
  });
}

/* --------------------------------------------------------------------------
   Celebration — a small confetti burst, skipped when motion is off
   -------------------------------------------------------------------------- */
export function celebrate(intensity = 18) {
  if (prefersReducedMotion()) return;
  const colors = ["var(--accent)", "var(--accent-2)", "var(--good)", "var(--warn)"];
  const rect = { x: window.innerWidth / 2, y: window.innerHeight * 0.32 };
  for (let index = 0; index < intensity; index += 1) {
    const piece = h("i", { class: "confetti-piece" });
    piece.style.background = colors[index % colors.length];
    piece.style.left = `${rect.x}px`;
    piece.style.top = `${rect.y}px`;
    piece.style.setProperty("--dx", `${(Math.random() - 0.5) * 420}px`);
    piece.style.setProperty("--dy", `${120 + Math.random() * 260}px`);
    piece.style.animationDelay = `${Math.random() * 140}ms`;
    document.body.appendChild(piece);
    window.setTimeout(() => piece.remove(), 1700);
  }
}

/* --------------------------------------------------------------------------
   Pull to refresh (touch only) — emits "pull-refresh"
   -------------------------------------------------------------------------- */
export function initPullToRefresh() {
  let startY = 0;
  let pulling = false;
  const indicator = byId("pullIndicator");
  if (!indicator) return;

  window.addEventListener(
    "touchstart",
    (event) => {
      if (window.scrollY > 4 || event.touches.length !== 1) return;
      if (document.body.classList.contains("focus-mode")) return;
      startY = event.touches[0].clientY;
      pulling = true;
    },
    { passive: true },
  );

  window.addEventListener(
    "touchmove",
    (event) => {
      if (!pulling) return;
      const delta = event.touches[0].clientY - startY;
      if (delta > 70) indicator.hidden = false;
    },
    { passive: true },
  );

  window.addEventListener(
    "touchend",
    (event) => {
      if (!pulling) return;
      const delta = (event.changedTouches[0]?.clientY || 0) - startY;
      pulling = false;
      if (delta > 70) {
        indicator.hidden = true;
        emit("pull-refresh", {});
      } else {
        indicator.hidden = true;
      }
    },
    { passive: true },
  );
}

/* --------------------------------------------------------------------------
   Segmented control helper
   -------------------------------------------------------------------------- */
export function bindSegmented(container, { value, onChange, attribute = "data-value" }) {
  if (!container) return;
  const buttons = $$("button", container);
  const paint = (current) => {
    buttons.forEach((button) => {
      const selected = String(button.dataset[attribute.replace("data-", "").replace(/-([a-z])/g, (m, c) => c.toUpperCase())]) === String(current);
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-checked", selected ? "true" : "false");
    });
  };
  paint(value);
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const datasetKey = Object.keys(button.dataset)[0];
      const next = button.dataset[datasetKey];
      paint(next);
      onChange(next, button);
    });
  });
  return paint;
}

/* --------------------------------------------------------------------------
   Switch helper
   -------------------------------------------------------------------------- */
export function bindSwitch(button, { value, onChange }) {
  if (!button) return null;
  const paint = (current) => {
    button.setAttribute("aria-checked", current ? "true" : "false");
    button.classList.toggle("is-active", !!current);
  };
  paint(value);
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    paint(next);
    onChange(next);
  });
  return paint;
}

/* --------------------------------------------------------------------------
   Scroll helpers
   -------------------------------------------------------------------------- */
export function scrollToTop(behavior = "smooth") {
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : behavior });
}

export function reveal(node) {
  if (!node) return;
  const rect = node.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    node.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
}
