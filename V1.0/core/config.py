"""
TaskArcade V1.0 — configuration constants, palettes, themes and defaults.

Everything that describes "the shape of the product" lives here so that the
services layer stays about behaviour and not about magic numbers.
"""

from __future__ import annotations

import os

APP_NAME = "TaskArcade"
APP_VERSION = "1.0.0"
APP_TAGLINE = "Make time visible."

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "taskarcade.db")
LEGACY_DB_PATHS = [
    os.path.join(BASE_DIR, "kanban.db"),
    os.path.join(os.path.dirname(BASE_DIR), "V0.1", "kanban.db"),
]

# ---------------------------------------------------------------------------
# Tag colours — 24 dark-theme-safe hues. Each entry is (name, hex, soft_hex).
# `soft_hex` is used for translucent chips so colours read well on dark paper.
# ---------------------------------------------------------------------------
PALETTE = [
    {"name": "Ember",     "hex": "#FF6B6B", "soft": "#FF6B6B29"},
    {"name": "Coral",     "hex": "#FF8787", "soft": "#FF878729"},
    {"name": "Tangerine", "hex": "#FFA94D", "soft": "#FFA94D29"},
    {"name": "Amber",     "hex": "#FFC078", "soft": "#FFC07829"},
    {"name": "Honey",     "hex": "#FFD43B", "soft": "#FFD43B29"},
    {"name": "Citrus",    "hex": "#FFE066", "soft": "#FFE06629"},
    {"name": "Olive",     "hex": "#A9E34B", "soft": "#A9E34B29"},
    {"name": "Lime",      "hex": "#C0EB75", "soft": "#C0EB7529"},
    {"name": "Fern",      "hex": "#8CE99A", "soft": "#8CE99A29"},
    {"name": "Mint",      "hex": "#69DB7C", "soft": "#69DB7C29"},
    {"name": "Jade",      "hex": "#38D9A9", "soft": "#38D9A929"},
    {"name": "Seafoam",   "hex": "#63E6BE", "soft": "#63E6BE29"},
    {"name": "Lagoon",    "hex": "#22B8CF", "soft": "#22B8CF29"},
    {"name": "Aqua",      "hex": "#66D9E8", "soft": "#66D9E829"},
    {"name": "Sky",       "hex": "#4DABF7", "soft": "#4DABF729"},
    {"name": "Azure",     "hex": "#91A7FF", "soft": "#91A7FF29"},
    {"name": "Indigo",    "hex": "#748FFC", "soft": "#748FFC29"},
    {"name": "Violet",    "hex": "#9775FA", "soft": "#9775FA29"},
    {"name": "Orchid",    "hex": "#DA77F2", "soft": "#DA77F229"},
    {"name": "Blossom",   "hex": "#F783AC", "soft": "#F783AC29"},
    {"name": "Rose",      "hex": "#F06595", "soft": "#F0659529"},
    {"name": "Slate",     "hex": "#8D99AE", "soft": "#8D99AE29"},
    {"name": "Sand",      "hex": "#D8C3A5", "soft": "#D8C3A529"},
    {"name": "Stone",     "hex": "#ADB5BD", "soft": "#ADB5BD29"},
]

PALETTE_HEXES = [c["hex"] for c in PALETTE]
COLOR_BY_HEX = {c["hex"].upper(): c for c in PALETTE}
SOFT_BY_HEX = {c["hex"].upper(): c["soft"] for c in PALETTE}


def soft_color(hex_color: str) -> str:
    """Return the translucent companion for a palette colour (fallback: 18%)."""
    if not hex_color:
        return "rgba(148, 163, 184, .16)"
    value = hex_color.strip()
    match = SOFT_BY_HEX.get(value.upper())
    if match:
        return match
    if value.startswith("#") and len(value) == 7:
        return value + "29"
    return "rgba(148, 163, 184, .16)"


# ---------------------------------------------------------------------------
# Exactly five appearance palettes. They retain a gentle typographic and
# geometry character; the eight selectable layout designs remain independent.
# ---------------------------------------------------------------------------
THEMES = [
    {
        "id": "lumen",
        "label": "Lumen",
        "tagline": "Clear daily agenda",
        "blurb": "A calm, time-aware day plan with clear next steps.",
        "default_scheme": "light",
        "swatch": ["#FF6B4A", "#FFF6F1", "#241F1C"],
        "font": "sans",
        "radius": 16,
        "density": "cozy",
    },
    {
        "id": "midnight",
        "label": "Midnight",
        "tagline": "Focused workspace",
        "blurb": "One clear priority, with the next few steps close at hand.",
        "default_scheme": "dark",
        "swatch": ["#6C8CFF", "#0B0E17", "#E7ECFF"],
        "font": "sans",
        "radius": 12,
        "density": "compact",
    },
    {
        "id": "terminal",
        "label": "Slate",
        "tagline": "Quiet, focused palette",
        "blurb": "Balanced charcoal tones with comfortable contrast for long sessions.",
        "default_scheme": "dark",
        "swatch": ["#78A99B", "#11171D", "#E4EAF0"],
        "font": "sans",
        "radius": 10,
        "density": "compact",
    },
    {
        "id": "zen",
        "label": "Zen Paper",
        "tagline": "Calm single column",
        "blurb": "Editorial single column, warm paper, nothing shouting.",
        "default_scheme": "light",
        "swatch": ["#1F6F5C", "#F7F3EA", "#2A2622"],
        "font": "serif",
        "radius": 4,
        "density": "roomy",
    },
    {
        "id": "arcade",
        "label": "Harbor",
        "tagline": "Calm deep teal",
        "blurb": "A measured teal palette with clear surfaces and calm contrast.",
        "default_scheme": "dark",
        "swatch": ["#69A99A", "#101A1D", "#E5EFED"],
        "font": "sans",
        "radius": 14,
        "density": "cozy",
    },
]

THEME_IDS = [t["id"] for t in THEMES]
THEME_BY_ID = {t["id"]: t for t in THEMES}
DESIGNS = [
    {"id": "agenda", "label": "Agenda", "description": "A time-aware day plan with a clear next step."},
    {"id": "board", "label": "Board", "description": "Separate day lanes that are easy to scan."},
    {"id": "calendar", "label": "Week map", "description": "Seven day columns for a broad weekly view."},
    {"id": "cards", "label": "Cards", "description": "Comfortable task cards with room to breathe."},
    {"id": "compact", "label": "Compact", "description": "A tidy list that keeps extra detail out of the way."},
    {"id": "flow", "label": "Flow", "description": "A connected sequence for moving from one task to the next."},
    {"id": "focus", "label": "Focus first", "description": "One clear priority, with the next few steps close at hand."},
    {"id": "stream", "label": "Reading flow", "description": "A calm, text-first plan with an editorial rhythm."},
]
LAYOUTS = [design["id"] for design in DESIGNS]

SCHEMES = ["auto", "light", "dark"]
VIEW_MODES = ["today", "tomorrow", "3days", "week", "custom", "all"]
DENSITIES = ["compact", "cozy", "roomy"]
TIME_FORMATS = ["hm", "clock", "decimal", "minutes"]
COUNT_MODES = ["focus", "always", "off"]
CARRY_OVER_MODES = ["always", "ask", "never"]
PRIORITIES = [0, 1, 2, 3]
PRIORITY_LABELS = {0: "None", 1: "Low", 2: "Medium", 3: "High"}
PRIORITY_COLORS = {0: "", 1: "#4DABF7", 2: "#FFA94D", 3: "#FF6B6B"}


def priority_label(value: int) -> str:
    return PRIORITY_LABELS.get(int(value or 0), "None")
SORT_MODES = ["manual", "duration", "duration_desc", "priority", "alpha", "created"]

# ---------------------------------------------------------------------------
# Default tags. `aliases` make short hand-typed codes resolve to the tag.
# ---------------------------------------------------------------------------
DEFAULT_TAGS = [
    {
        "name": "tracked",
        "label": "Tracked",
        "color": PALETTE[17]["hex"],
        "icon": "eye",
        "aliases": ["t", "tr", "trk"],
        "default_minutes": 30,
    },
    {
        "name": "study",
        "label": "Study",
        "color": PALETTE[14]["hex"],
        "icon": "book",
        "aliases": ["s", "std", "learn"],
        "default_minutes": 60,
    },
    {
        "name": "home",
        "label": "Home",
        "color": PALETTE[9]["hex"],
        "icon": "home",
        "aliases": ["h", "hm", "chores"],
        "default_minutes": 30,
    },
    {
        "name": "fun",
        "label": "Fun",
        "color": PALETTE[19]["hex"],
        "icon": "sparkles",
        "aliases": ["f", "play"],
        "default_minutes": 45,
    },
    {
        "name": "work",
        "label": "Work",
        "color": PALETTE[2]["hex"],
        "icon": "briefcase",
        "aliases": ["w", "job"],
        "default_minutes": 45,
    },
    {
        "name": "health",
        "label": "Health",
        "color": PALETTE[10]["hex"],
        "icon": "heart",
        "aliases": ["he", "gym", "fit"],
        "default_minutes": 45,
    },
]

DEFAULT_SAMPLE_TASKS = [
    {"title": "Morning reset — plan the day", "tag": "tracked", "minutes": 10, "priority": 2},
    {"title": "Deep work block", "tag": "work", "minutes": 90, "priority": 3},
    {"title": "Study English", "tag": "study", "minutes": 60, "priority": 2},
    {"title": "Vacuum the house", "tag": "home", "minutes": 30, "priority": 1},
    {"title": "Walk outside", "tag": "health", "minutes": 45, "priority": 1},
    {"title": "Watch a movie", "tag": "fun", "minutes": 120, "priority": 0},
]

DEFAULT_TEMPLATES = [
    {
        "name": "Deep work morning",
        "description": "Plan, focus 90m, break, review.",
        "kind": "task_set",
        "payload": {
            "tasks": [
                {"title": "Plan the day", "tag": "tracked", "minutes": 10, "priority": 2},
                {"title": "Deep work block", "tag": "work", "minutes": 90, "priority": 3},
                {"title": "Short break — stretch", "tag": "health", "minutes": 10},
                {"title": "Review & note wins", "tag": "tracked", "minutes": 15},
            ]
        },
    },
    {
        "name": "Study evening",
        "description": "Three study sprints with reviews.",
        "kind": "task_set",
        "payload": {
            "tasks": [
                {"title": "Study session 1", "tag": "study", "minutes": 45, "priority": 2},
                {"title": "Review notes", "tag": "study", "minutes": 15},
                {"title": "Study session 2", "tag": "study", "minutes": 45, "priority": 2},
            ]
        },
    },
    {
        "name": "Weekend reset",
        "description": "Home chores and a bit of fun.",
        "kind": "task_set",
        "payload": {
            "tasks": [
                {"title": "Laundry", "tag": "home", "minutes": 40},
                {"title": "Groceries", "tag": "home", "minutes": 60},
                {"title": "Tidy desk", "tag": "home", "minutes": 20},
                {"title": "Movie night", "tag": "fun", "minutes": 120},
            ]
        },
    },
]

# ---------------------------------------------------------------------------
# Recurrence rule vocabulary (virtual days, never real calendar dates)
# ---------------------------------------------------------------------------
RECURRENCE_FREQS = ["daily", "weekdays", "weekends", "weekly", "monthly", "every_n_days"]
DEFAULT_RECURRENCE = {"freq": "daily", "interval": 1, "weekdays": [0, 1, 2, 3, 4], "time": ""}

# ---------------------------------------------------------------------------
# Event kinds written into the history log (drives Insights + activity feed)
# ---------------------------------------------------------------------------
EVENT_KINDS = [
    "task.create",
    "task.update",
    "task.done",
    "task.undone",
    "task.skip",
    "task.delete",
    "task.move",
    "task.reorder",
    "task.split",
    "task.duplicate",
    "task.tick",
    "task.start",
    "task.pause",
    "subtask.add",
    "subtask.toggle",
    "subtask.delete",
    "day.finish",
    "day.reopen",
    "day.log",
    "focus.start",
    "focus.complete",
    "focus.abandon",
    "break.start",
    "break.complete",
    "tag.add",
    "tag.update",
    "tag.delete",
    "alias.add",
    "alias.delete",
    "template.apply",
    "routine.create",
    "routine.update",
    "routine.archive",
    "routine.run.start",
    "routine.step.done",
    "routine.step.skip",
    "routine.run.finish",
    "routine.run.stop",
    "recurrence.materialize",
    "settings.update",
    "backup.import",
    "undo",
    "redo",
    "cleanup",
]

# ---------------------------------------------------------------------------
# Settings defaults — mirrored by the DB schema in core/db.py.
# ---------------------------------------------------------------------------
DEFAULT_SETTINGS = {
    "server_url": "",
    "current_day_index": 1,
    "language": "en",
    "calendar_system": "auto",
    "calendar_start_date": "",
    "timezone": "",
    "persian_font": "vazirmatn",
    "digit_style": "auto",
    "view_mode": "today",
    "view_days": 3,
    "sort_mode": "manual",
    "group_mode": "day",           # day | tag | priority | none
    "theme": "lumen",
    "scheme": "auto",
    "density": "cozy",
    "accent": "",
    "radius": 16,
    "font_scale": 1.0,
    "motion": 1,
    "transparency": 1,
    "contrast": 0,
    "day_start_hour": 4,
    "workday_start": "09:00",
    "workday_end": "18:00",
    "daily_goal_minutes": 240,
    "capacity_minutes": 480,
    "week_start": 1,
    "time_format": "hm",
    "default_duration": 30,
    "auto_done": 1,
    "count_mode": "focus",
    "idle_seconds": 180,
    "pomodoro_focus": 25,
    "pomodoro_break": 5,
    "pomodoro_long_break": 15,
    "pomodoro_cycles": 4,
    "pomodoro_auto_start": 1,
    "pomodoro_sound": 1,
    "routine_auto_advance": 1,
    "routine_sound": 1,
    "routine_vibrate": 0,
    "routine_keep_awake": 0,
    "routine_show_next": 1,
    "sound": 1,
    "sound_volume": 0.5,
    "notifications": 0,
    "reminder_lead": 5,
    "carry_over": "always",
    "wip_limit": 3,
    "undo_limit": 40,
    "confirm_destructive": 1,
    "show_done": 1,
    "show_notes_inline": 0,
    "compact_meta": 0,
    "auto_carry_done": 1,
    "week_starts_fresh": 0,
    "greeting": "Make time visible.",
    "quick_add_open": 0,
    "seen_welcome": 0,
}

SETTING_TYPES = {
    "server_url": str,
    "current_day_index": int,
    "language": str,
    "calendar_system": str,
    "calendar_start_date": str,
    "timezone": str,
    "persian_font": str,
    "digit_style": str,
    "view_mode": str,
    "view_days": int,
    "sort_mode": str,
    "group_mode": str,
    "theme": str,
    "scheme": str,
    "density": str,
    "accent": str,
    "radius": int,
    "font_scale": float,
    "motion": int,
    "transparency": int,
    "contrast": int,
    "day_start_hour": int,
    "workday_start": str,
    "workday_end": str,
    "daily_goal_minutes": int,
    "capacity_minutes": int,
    "week_start": int,
    "time_format": str,
    "default_duration": int,
    "auto_done": int,
    "count_mode": str,
    "idle_seconds": int,
    "pomodoro_focus": int,
    "pomodoro_break": int,
    "pomodoro_long_break": int,
    "pomodoro_cycles": int,
    "pomodoro_auto_start": int,
    "pomodoro_sound": int,
    "routine_auto_advance": int,
    "routine_sound": int,
    "routine_vibrate": int,
    "routine_keep_awake": int,
    "routine_show_next": int,
    "sound": int,
    "sound_volume": float,
    "notifications": int,
    "reminder_lead": int,
    "carry_over": str,
    "wip_limit": int,
    "undo_limit": int,
    "confirm_destructive": int,
    "show_done": int,
    "show_notes_inline": int,
    "compact_meta": int,
    "auto_carry_done": int,
    "week_starts_fresh": int,
    "greeting": str,
    "quick_add_open": int,
    "seen_welcome": int,
}

# Clamp ranges for numeric settings: (min, max)
SETTING_RANGES = {
    "view_days": (1, 60),
    "radius": (0, 34),
    "font_scale": (0.8, 1.35),
    "day_start_hour": (0, 12),
    "daily_goal_minutes": (0, 1440),
    "capacity_minutes": (0, 1440),
    "week_start": (0, 6),
    "default_duration": (1, 720),
    "idle_seconds": (30, 3600),
    "pomodoro_focus": (1, 180),
    "pomodoro_break": (1, 60),
    "pomodoro_long_break": (1, 120),
    "pomodoro_cycles": (1, 12),
    "reminder_lead": (0, 120),
    "wip_limit": (1, 25),
    "undo_limit": (5, 200),
    "sound_volume": (0.0, 1.0),
}

ENUM_SETTINGS = {
    "view_mode": VIEW_MODES,
    "sort_mode": SORT_MODES,
    "group_mode": ["day", "tag", "priority", "none"],
    "theme": THEME_IDS,
    "scheme": SCHEMES,
    "density": DENSITIES,
    "time_format": TIME_FORMATS,
    "language": ["en", "fa"],
    "calendar_system": ["auto", "gregorian", "jalali"],
    "persian_font": ["vazirmatn", "estedad", "naskh", "sahel"],
    "digit_style": ["auto", "latin", "persian"],
    "count_mode": COUNT_MODES,
    "carry_over": CARRY_OVER_MODES,
}

# ---------------------------------------------------------------------------
# Quick-add parser vocabulary
# ---------------------------------------------------------------------------
TOKEN_PREFIXES = {
    "tag": "#",
    "time": "@",
    "priority": "!",
    "estimate": "~",
    "estimate_alt": "=",
    "recur": "*",
    "subtask": "+",
    "note": ">",
    "pin": "^",
}

DURATION_UNITS = {
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
    "p": 1500, "pom": 1500, "pomo": 1500, "pomodoro": 1500, "tomato": 1500, "🍅": 1500,
    "ثانیه": 1, "ثانیهها": 1, "ث": 1,
    "دقیقه": 60, "دقیقهها": 60, "د": 60,
    "ساعت": 3600, "ساعته": 3600,
    "روز": 86400, "روزه": 86400,
    "پومودورو": 1500, "پوم": 1500,
}

# Bangs form a ladder: "!" low, "!!" medium, "!!!"/more high.
PRIORITY_WORDS = {
    "!": 1,
    "!!": 2,
    "!!!": 3,
    "!!!!": 3,
    "high": 3, "hi": 3, "urgent": 3, "p3": 3, "3": 3, "!!!+": 3,
    "medium": 2, "med": 2, "normal": 2, "p2": 2, "2": 2,
    "low": 1, "lo": 1, "someday": 1, "p1": 1, "1": 1,
    "0": 0, "none": 0, "p0": 0, "no": 0,
    "کم": 1, "پایین": 1, "عادی": 2, "متوسط": 2, "بالا": 3, "زیاد": 3, "فوری": 3,
}

PRIORITY_ICONS = {3: "bolt", 2: "arrow-up", 1: "arrow-down", 0: "minus"}

# ---------------------------------------------------------------------------
# Keyboard shortcut catalogue surfaced in the Help sheet.
# ---------------------------------------------------------------------------
SHORTCUTS = [
    {"keys": "?", "action": "Open this shortcut sheet"},
    {"keys": "Ctrl/⌘ K", "action": "Command palette — jump anywhere, run anything"},
    {"keys": "n", "action": "Focus the quick-add bar"},
    {"keys": "N", "action": "Open the full bulk-add composer"},
    {"keys": "Space", "action": "Start / pause the focus timer on the active task"},
    {"keys": "d", "action": "Mark the active task done"},
    {"keys": "s", "action": "Move the active task to the end of the day"},
    {"keys": "e", "action": "Edit the active task"},
    {"keys": "f", "action": "Toggle focus mode (hide everything but now)"},
    {"keys": "t", "action": "Open themes studio"},
    {"keys": "i", "action": "Open Insights"},
    {"keys": "l", "action": "Toggle light / dark scheme"},
    {"keys": "1…5", "action": "Jump to day 1…5 in the current range"},
    {"keys": "Ctrl/⌘ Z", "action": "Undo last change"},
    {"keys": "Ctrl/⌘ ⇧ Z", "action": "Redo"},
    {"keys": "Ctrl/⌘ ,", "action": "Open settings"},
    {"keys": "Esc", "action": "Close any sheet, panel or palette"},
]
