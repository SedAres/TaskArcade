/* ==========================================================================
   TaskArcade — theme engine
   Resolves the user's theme + scheme preference into DOM attributes, keeps the
   browser chrome (theme-color) in sync, renders the theme gallery and applies
   fine-tuning (accent, radius, text size, motion, translucency, contrast).
   ========================================================================== */

import { $, $$, byId, h, icon, clear, clamp, store, prefs, on, emit, prefersDark } from "./core.js";

const SCHEME_MEDIA = window.matchMedia("(prefers-color-scheme: dark)");
let mediaListenerBound = false;

export const LAYOUT_OPTIONS = [
  { id: "agenda", label: "Agenda", description: "A time-aware day plan with a clear next step." },
  { id: "board", label: "Board", description: "Separate day lanes that are easy to scan." },
  { id: "calendar", label: "Week map", description: "Seven day columns for a broad weekly view." },
  { id: "cards", label: "Cards", description: "Comfortable task cards with room to breathe." },
  { id: "compact", label: "Compact", description: "A tidy list that keeps extra detail out of the way." },
  { id: "flow", label: "Flow", description: "A connected sequence for moving from one task to the next." },
  { id: "focus", label: "Focus first", description: "The current priority leads; the rest stays nearby." },
  { id: "stream", label: "Reading flow", description: "A calm, text-first plan with an editorial rhythm." },
];

const LEGACY_LAYOUTS = { console: "focus", table: "compact", tiles: "cards" };
const layoutId = (value) => LEGACY_LAYOUTS[value] || (LAYOUT_OPTIONS.some((item) => item.id === value) ? value : "agenda");
const t = (value) => window.TaskArcadeI18n?.t?.(value) ?? value;

/* --------------------------------------------------------------------------
   Resolution
   -------------------------------------------------------------------------- */
export function themeDefinition(id) {
  const themes = store.meta?.themes || [];
  return themes.find((theme) => theme.id === id) || themes[0] || { id: "lumen", radius: 16, label: "Lumen" };
}

export function currentThemeId() {
  const id = prefs.get("theme", "lumen");
  return themeDefinition(id).id;
}

export function resolvedScheme() {
  const choice = prefs.get("scheme", "auto");
  if (choice === "light" || choice === "dark") return choice;
  return prefersDark() ? "dark" : "light";
}

export function currentLayout() {
  // Layout selection is an independent design system; palette changes never
  // switch the user's chosen information hierarchy.
  const saved = prefs.get("layoutOverride", "agenda");
  return layoutId(!saved || saved === "auto" ? "agenda" : saved);
}

/* --------------------------------------------------------------------------
   Applying
   -------------------------------------------------------------------------- */
export function applyTheme({ silent = false } = {}) {
  const root = document.documentElement;
  const themeId = currentThemeId();
  const definition = themeDefinition(themeId);
  const scheme = resolvedScheme();
  const layout = currentLayout();

  root.dataset.theme = themeId;
  root.dataset.scheme = scheme;
  root.dataset.schemePref = prefs.get("scheme", "auto");
  root.dataset.layout = layout;
  root.dataset.density = prefs.get("density", definition.density || "cozy");
  root.dataset.motion = prefs.get("motion", true) ? "on" : "off";
  root.dataset.transparency = prefs.get("transparency", true) ? "on" : "off";
  root.dataset.contrast = prefs.get("contrast", false) ? "high" : "normal";
  root.dataset.themeLabel = definition.label || themeId;

  // Accent, radius and text size are inline custom properties so they can be
  // layered on top of any theme without a new stylesheet.
  const accent = prefs.get("accent", "") || "";
  if (accent) {
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-strong", shade(accent, -0.12));
    root.style.setProperty("--accent-soft", hexToRgba(accent, 0.16));
    root.style.setProperty("--focus-ring", accent);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-strong");
    root.style.removeProperty("--accent-soft");
    root.style.removeProperty("--focus-ring");
  }

  const radius = prefs.get("radius", null);
  if (radius === null || radius === undefined || radius === "") {
    root.style.removeProperty("--radius");
    root.style.removeProperty("--radius-sm");
    root.style.removeProperty("--radius-lg");
  } else {
    const value = clamp(Number(radius), 0, 34);
    root.style.setProperty("--radius", `${value}px`);
    root.style.setProperty("--radius-sm", `${Math.max(0, Math.round(value * 0.62))}px`);
    root.style.setProperty("--radius-lg", `${Math.min(40, Math.round(value * 1.4))}px`);
  }

  const fontScale = clamp(Number(prefs.get("fontScale", 1)) || 1, 0.8, 1.35);
  root.style.setProperty("--font-scale", String(fontScale));

  const meta = byId("themeColorMeta");
  if (meta) {
    meta.setAttribute("content", scheme === "dark" ? "#0b0e17" : "#f6f3ee");
  }

  if (!mediaListenerBound) {
    SCHEME_MEDIA.addEventListener("change", () => {
      if (prefs.get("scheme", "auto") === "auto") applyTheme();
    });
    mediaListenerBound = true;
  }

  if (!silent) emit("theme", { theme: themeId, scheme, layout });
}

export function setTheme(id) {
  const definition = themeDefinition(id);
  prefs.set("theme", definition.id);
  if (prefs.get("radius", null) === null) {
    // first switch: adopt the theme's own geometry
    prefs.set("radius", null);
  }
  applyTheme();
}

export function setScheme(choice) {
  prefs.set("scheme", choice);
  applyTheme();
}

export function toggleScheme() {
  const next = resolvedScheme() === "dark" ? "light" : "dark";
  setScheme(next);
  emit("toast", { message: `${next === "dark" ? "Dark" : "Light"} scheme`, tone: "info" });
}

export function setDensity(density) {
  prefs.set("density", density);
  applyTheme();
}

export function setLayoutOverride(layout) {
  prefs.set("layoutOverride", layoutId(layout || "agenda"));
  applyTheme();
}

export function setAccent(hex) {
  prefs.set("accent", hex || "");
  applyTheme();
}

export function setRadius(value) {
  prefs.set("radius", value === "" || value === null ? null : Number(value));
  applyTheme();
}

export function setFontScale(value) {
  prefs.set("fontScale", Number(value) / (Number(value) > 3 ? 100 : 1));
  applyTheme();
}

export function setMotion(value) {
  prefs.set("motion", !!value);
  applyTheme();
}

/* --------------------------------------------------------------------------
   Colour maths for the accent override
   -------------------------------------------------------------------------- */
export function hexToRgb(hex) {
  const value = String(hex || "").replace("#", "").trim();
  if (value.length === 3) {
    return {
      r: parseInt(value[0] + value[0], 16),
      g: parseInt(value[1] + value[1], 16),
      b: parseInt(value[2] + value[2], 16),
    };
  }
  if (value.length !== 6) return { r: 255, g: 107, b: 74 };
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function hexToRgba(hex, alpha = 1) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function shade(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const adjust = (channel) => clamp(Math.round(channel + 255 * amount), 0, 255);
  return `rgb(${adjust(r)}, ${adjust(g)}, ${adjust(b)})`;
}

/* --------------------------------------------------------------------------
   Theme gallery
   -------------------------------------------------------------------------- */
export function renderThemeGallery() {
  const gallery = byId("themeGallery");
  if (!gallery) return;
  const themes = store.meta?.themes || [];
  const active = currentThemeId();
  clear(gallery);

  themes.forEach((theme) => {
    const card = h("button", {
      class: `theme-card${theme.id === active ? " is-active" : ""}`,
      type: "button",
      role: "radio",
      "aria-checked": theme.id === active ? "true" : "false",
      "data-theme-choice": theme.id,
      onclick: () => {
        setTheme(theme.id);
        renderThemeGallery();
        renderAppearanceControls();
      },
    }, [
      h("span", { class: `theme-preview preview-${theme.id}` }, [
        h("i"), h("i"), h("i"),
      ]),
      h("span", { class: "theme-copy" }, [
        h("strong", {}, theme.label),
        h("small", {}, theme.blurb || theme.tagline || ""),
      ]),
      h("span", { class: "theme-meta" }, [
        h("span", { class: "theme-layout-pill" }, t("Palette")), 
        theme.id === active ? icon("check") : null,
      ]),
    ]);
    gallery.appendChild(card);
  });

  // Theme cards use scoped swatches to preview the five separate palettes.
  themes.forEach((theme) => {
    const preview = gallery.querySelector(`.preview-${theme.id}`);
    if (!preview) return;
    const [accent, bg, ink] = theme.swatch || ["#888", "#fff", "#222"];
    preview.style.setProperty("--preview-accent", accent);
    preview.style.setProperty("--preview-bg", bg);
    preview.style.setProperty("--preview-ink", ink);
    preview.dataset.layout = "palette";
  });

  renderLayoutGallery();
}

export function renderLayoutGallery() {
  const gallery = byId("layoutGallery");
  if (!gallery) return;
  const active = currentLayout();
  clear(gallery);
  LAYOUT_OPTIONS.forEach((layout) => {
    const selected = layout.id === active;
    const card = h("button", {
      class: `design-card${selected ? " is-active" : ""}`,
      type: "button",
      role: "radio",
      "aria-checked": selected ? "true" : "false",
      dataset: { layout: layout.id },
      onclick: () => {
        setLayoutOverride(layout.id);
        renderLayoutGallery();
        renderAppearanceControls();
      },
    }, [
      h("span", { class: "layout-preview", dataset: { layout: layout.id }, "aria-hidden": "true" }, [
        h("i"), h("i"), h("i"), h("i"),
      ]),
      h("span", { class: "design-copy" }, [
        h("strong", {}, t(layout.label)),
        h("small", {}, t(layout.description)),
      ]),
      selected ? icon("check") : null,
    ]);
    gallery.appendChild(card);
  });
}

export function renderAppearanceControls() {
  const schemeControl = byId("schemeControl");
  if (schemeControl) {
    $$("button", schemeControl).forEach((button) => {
      const selected = button.dataset.scheme === prefs.get("scheme", "auto");
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-checked", selected ? "true" : "false");
    });
  }
  const densityControl = byId("densityControl");
  if (densityControl) {
    $$("button", densityControl).forEach((button) => {
      const selected = button.dataset.density === prefs.get("density", "cozy");
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-checked", selected ? "true" : "false");
    });
  }
  const radiusRange = byId("radiusRange");
  const radiusOut = byId("radiusOut");
  if (radiusRange) {
    const value = prefs.get("radius", null);
    radiusRange.value = value === null || value === undefined ? themeDefinition(currentThemeId()).radius || 16 : value;
    if (radiusOut) radiusOut.textContent = radiusRange.value;
  }
  const fontRange = byId("fontRange");
  const fontOut = byId("fontOut");
  if (fontRange) {
    fontRange.value = Math.round((Number(prefs.get("fontScale", 1)) || 1) * 100);
    if (fontOut) fontOut.textContent = `${fontRange.value}%`;
  }
  const motionSwitch = byId("motionSwitch");
  if (motionSwitch) motionSwitch.setAttribute("aria-checked", prefs.get("motion", true) ? "true" : "false");
  const transparencySwitch = byId("transparencySwitch");
  if (transparencySwitch) {
    transparencySwitch.setAttribute("aria-checked", prefs.get("transparency", true) ? "true" : "false");
  }
  const contrastSwitch = byId("contrastSwitch");
  if (contrastSwitch) contrastSwitch.setAttribute("aria-checked", prefs.get("contrast", false) ? "true" : "false");

  renderAccentRow();
}

export function renderAccentRow() {
  const row = byId("accentRow");
  if (!row) return;
  const palette = store.meta?.palette || [];
  const active = (prefs.get("accent", "") || "").toUpperCase();
  clear(row);

  row.appendChild(
    h("button", {
      class: `swatch${active ? "" : " is-active"}`,
      type: "button",
      title: "Theme default",
      style: { background: "linear-gradient(135deg, var(--accent), var(--accent-2))" },
      onclick: () => {
        setAccent("");
        renderAppearanceControls();
      },
    }),
  );

  palette.slice(0, 14).forEach((entry) => {
    row.appendChild(
      h("button", {
        class: `swatch${entry.hex.toUpperCase() === active ? " is-active" : ""}`,
        type: "button",
        title: entry.name,
        style: { background: entry.hex },
        onclick: () => {
          setAccent(entry.hex);
          renderAppearanceControls();
        },
      }),
    );
  });
}

/* --------------------------------------------------------------------------
   Wiring for the theme studio controls
   -------------------------------------------------------------------------- */
export function initThemeStudio() {
  on("theme", () => {
    renderThemeGallery();
    renderAppearanceControls();
  });

  const schemeControl = byId("schemeControl");
  schemeControl?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-scheme]");
    if (!button) return;
    setScheme(button.dataset.scheme);
    renderAppearanceControls();
  });

  const densityControl = byId("densityControl");
  densityControl?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-density]");
    if (!button) return;
    setDensity(button.dataset.density);
    renderAppearanceControls();
  });

  byId("radiusRange")?.addEventListener("input", (event) => {
    const output = byId("radiusOut");
    if (output) output.textContent = event.target.value;
    setRadius(event.target.value);
  });

  byId("fontRange")?.addEventListener("input", (event) => {
    const output = byId("fontOut");
    if (output) output.textContent = `${event.target.value}%`;
    setFontScale(event.target.value);
  });

  byId("accentCustom")?.addEventListener("input", (event) => {
    setAccent(event.target.value);
    renderAppearanceControls();
  });

  byId("accentReset")?.addEventListener("click", () => {
    setAccent("");
    renderAppearanceControls();
  });

  const motionSwitch = byId("motionSwitch");
  motionSwitch?.addEventListener("click", () => {
    setMotion(motionSwitch.getAttribute("aria-checked") !== "true");
    renderAppearanceControls();
  });

  const transparencySwitch = byId("transparencySwitch");
  transparencySwitch?.addEventListener("click", () => {
    prefs.set("transparency", transparencySwitch.getAttribute("aria-checked") !== "true");
    applyTheme();
    renderAppearanceControls();
  });

  const contrastSwitch = byId("contrastSwitch");
  contrastSwitch?.addEventListener("click", () => {
    prefs.set("contrast", contrastSwitch.getAttribute("aria-checked") !== "true");
    applyTheme();
    renderAppearanceControls();
  });
}

/* --------------------------------------------------------------------------
   Quick theme cycling (used by the command palette and shortcuts)
   -------------------------------------------------------------------------- */
export function cycleTheme(direction = 1) {
  const themes = store.meta?.themes || [];
  if (!themes.length) return;
  const index = themes.findIndex((theme) => theme.id === currentThemeId());
  const next = themes[(index + direction + themes.length) % themes.length];
  setTheme(next.id);
  emit("toast", { message: `Theme: ${next.label}`, tone: "info" });
  return next;
}

export function themeStylesheetSummary() {
  return (store.meta?.themes || []).map((theme) => ({
    id: theme.id,
    label: theme.label,
    swatch: theme.swatch,
    scheme: theme.default_scheme,
  }));
}
