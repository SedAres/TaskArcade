"""
TaskArcade V1.0 — SQLite persistence layer.

Responsibilities
  * open connections per request (Flask `g`)
  * create the schema on first run
  * perform additive migrations when a column/table is missing (so an old
    V0.1 `kanban.db` can be adopted without data loss)
  * seed defaults, sample tasks, starter tags, templates and aliases
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Iterable

from flask import g

from .config import (
    DATA_DIR,
    DB_PATH,
    DEFAULT_SETTINGS,
    DEFAULT_TAGS,
    DEFAULT_TEMPLATES,
    DEFAULT_SAMPLE_TASKS,
    LEGACY_DB_PATHS,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------------------
# Schema description. Kept declarative so migrations can diff against it.
# ---------------------------------------------------------------------------
TABLE_DDL: dict[str, str] = {
    "settings": """
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1)
        )
    """,
    "tags": """
        CREATE TABLE IF NOT EXISTS tags (
            tag_name TEXT PRIMARY KEY
        )
    """,
    "tag_aliases": """
        CREATE TABLE IF NOT EXISTS tag_aliases (
            alias TEXT PRIMARY KEY,
            tag_name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (tag_name) REFERENCES tags(tag_name) ON DELETE CASCADE
        )
    """,
    "tasks": """
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
    "subtasks": """
        CREATE TABLE IF NOT EXISTS subtasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
    "recurrences": """
        CREATE TABLE IF NOT EXISTS recurrences (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
    "day_logs": """
        CREATE TABLE IF NOT EXISTS day_logs (
            day_index INTEGER PRIMARY KEY
        )
    """,
    "events": """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
    "sessions": """
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
    "snapshots": """
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
    "templates": """
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
    "routines": """
        CREATE TABLE IF NOT EXISTS routines (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
    "routine_runs": """
        CREATE TABLE IF NOT EXISTS routine_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    """,
}

# column name -> SQL type + default
COLUMN_DDL: dict[str, dict[str, str]] = {
    "settings": {
        "server_url": "TEXT NOT NULL DEFAULT ''",
        "current_day_index": "INTEGER NOT NULL DEFAULT 1",
        "language": "TEXT NOT NULL DEFAULT 'en'",
        "calendar_system": "TEXT NOT NULL DEFAULT 'auto'",
        "calendar_start_date": "TEXT NOT NULL DEFAULT ''",
        "timezone": "TEXT NOT NULL DEFAULT ''",
        "persian_font": "TEXT NOT NULL DEFAULT 'vazirmatn'",
        "digit_style": "TEXT NOT NULL DEFAULT 'auto'",
        "view_mode": "TEXT NOT NULL DEFAULT 'today'",
        "view_days": "INTEGER NOT NULL DEFAULT 3",
        "sort_mode": "TEXT NOT NULL DEFAULT 'manual'",
        "group_mode": "TEXT NOT NULL DEFAULT 'day'",
        "theme": "TEXT NOT NULL DEFAULT 'lumen'",
        "scheme": "TEXT NOT NULL DEFAULT 'auto'",
        "density": "TEXT NOT NULL DEFAULT 'cozy'",
        "accent": "TEXT NOT NULL DEFAULT ''",
        "radius": "INTEGER NOT NULL DEFAULT 16",
        "font_scale": "REAL NOT NULL DEFAULT 1.0",
        "motion": "INTEGER NOT NULL DEFAULT 1",
        "transparency": "INTEGER NOT NULL DEFAULT 1",
        "contrast": "INTEGER NOT NULL DEFAULT 0",
        "day_start_hour": "INTEGER NOT NULL DEFAULT 4",
        "workday_start": "TEXT NOT NULL DEFAULT '09:00'",
        "workday_end": "TEXT NOT NULL DEFAULT '18:00'",
        "daily_goal_minutes": "INTEGER NOT NULL DEFAULT 240",
        "capacity_minutes": "INTEGER NOT NULL DEFAULT 480",
        "week_start": "INTEGER NOT NULL DEFAULT 1",
        "time_format": "TEXT NOT NULL DEFAULT 'hm'",
        "default_duration": "INTEGER NOT NULL DEFAULT 30",
        "auto_done": "INTEGER NOT NULL DEFAULT 1",
        "count_mode": "TEXT NOT NULL DEFAULT 'focus'",
        "idle_seconds": "INTEGER NOT NULL DEFAULT 180",
        "pomodoro_focus": "INTEGER NOT NULL DEFAULT 25",
        "pomodoro_break": "INTEGER NOT NULL DEFAULT 5",
        "pomodoro_long_break": "INTEGER NOT NULL DEFAULT 15",
        "pomodoro_cycles": "INTEGER NOT NULL DEFAULT 4",
        "pomodoro_auto_start": "INTEGER NOT NULL DEFAULT 1",
        "pomodoro_sound": "INTEGER NOT NULL DEFAULT 1",
        "routine_auto_advance": "INTEGER NOT NULL DEFAULT 1",
        "routine_sound": "INTEGER NOT NULL DEFAULT 1",
        "routine_vibrate": "INTEGER NOT NULL DEFAULT 0",
        "routine_keep_awake": "INTEGER NOT NULL DEFAULT 0",
        "routine_show_next": "INTEGER NOT NULL DEFAULT 1",
        "sound": "INTEGER NOT NULL DEFAULT 1",
        "sound_volume": "REAL NOT NULL DEFAULT 0.5",
        "notifications": "INTEGER NOT NULL DEFAULT 0",
        "reminder_lead": "INTEGER NOT NULL DEFAULT 5",
        "carry_over": "TEXT NOT NULL DEFAULT 'always'",
        "wip_limit": "INTEGER NOT NULL DEFAULT 3",
        "undo_limit": "INTEGER NOT NULL DEFAULT 40",
        "confirm_destructive": "INTEGER NOT NULL DEFAULT 1",
        "show_done": "INTEGER NOT NULL DEFAULT 1",
        "show_notes_inline": "INTEGER NOT NULL DEFAULT 0",
        "compact_meta": "INTEGER NOT NULL DEFAULT 0",
        "auto_carry_done": "INTEGER NOT NULL DEFAULT 1",
        "week_starts_fresh": "INTEGER NOT NULL DEFAULT 0",
        "greeting": "TEXT NOT NULL DEFAULT 'Make time visible.'",
        "quick_add_open": "INTEGER NOT NULL DEFAULT 0",
        "seen_welcome": "INTEGER NOT NULL DEFAULT 0",
        "updated_at": "TEXT NOT NULL DEFAULT ''",
    },
    "tags": {
        "label": "TEXT NOT NULL DEFAULT ''",
        "color": "TEXT NOT NULL DEFAULT '#9775FA'",
        "icon": "TEXT NOT NULL DEFAULT 'tag'",
        "description": "TEXT NOT NULL DEFAULT ''",
        "default_minutes": "INTEGER NOT NULL DEFAULT 0",
        "sort_order": "INTEGER NOT NULL DEFAULT 0",
        "archived": "INTEGER NOT NULL DEFAULT 0",
        "created_at": "TEXT NOT NULL DEFAULT ''",
    },
    "tasks": {
        "day_index": "INTEGER NOT NULL DEFAULT 1",
        "title": "TEXT NOT NULL DEFAULT ''",
        "notes": "TEXT NOT NULL DEFAULT ''",
        "tag": "TEXT NOT NULL DEFAULT ''",
        "priority": "INTEGER NOT NULL DEFAULT 0",
        "total_seconds": "INTEGER NOT NULL DEFAULT 0",
        "remaining_seconds": "INTEGER NOT NULL DEFAULT 0",
        "elapsed_seconds": "INTEGER NOT NULL DEFAULT 0",
        "order_index": "INTEGER NOT NULL DEFAULT 0",
        "done": "INTEGER NOT NULL DEFAULT 0",
        "pinned": "INTEGER NOT NULL DEFAULT 0",
        "scheduled_at": "TEXT NOT NULL DEFAULT ''",
        "reminder_at": "TEXT NOT NULL DEFAULT ''",
        "tomatoes_estimate": "INTEGER NOT NULL DEFAULT 0",
        "tomatoes_done": "INTEGER NOT NULL DEFAULT 0",
        "skipped_count": "INTEGER NOT NULL DEFAULT 0",
        "source": "TEXT NOT NULL DEFAULT 'manual'",
        "recurrence_id": "INTEGER NOT NULL DEFAULT 0",
        "focus_seconds": "INTEGER NOT NULL DEFAULT 0",
        "last_touched_at": "TEXT NOT NULL DEFAULT ''",
        "created_at": "TEXT NOT NULL DEFAULT ''",
        "updated_at": "TEXT NOT NULL DEFAULT ''",
        "completed_at": "TEXT NOT NULL DEFAULT ''",
        "archived": "INTEGER NOT NULL DEFAULT 0",
    },
    "subtasks": {
        "task_id": "INTEGER NOT NULL DEFAULT 0",
        "title": "TEXT NOT NULL DEFAULT ''",
        "done": "INTEGER NOT NULL DEFAULT 0",
        "order_index": "INTEGER NOT NULL DEFAULT 0",
        "created_at": "TEXT NOT NULL DEFAULT ''",
        "completed_at": "TEXT NOT NULL DEFAULT ''",
    },
    "recurrences": {
        "title": "TEXT NOT NULL DEFAULT ''",
        "notes": "TEXT NOT NULL DEFAULT ''",
        "tag": "TEXT NOT NULL DEFAULT ''",
        "priority": "INTEGER NOT NULL DEFAULT 0",
        "duration_seconds": "INTEGER NOT NULL DEFAULT 1800",
        "rule": "TEXT NOT NULL DEFAULT '{}'",
        "anchor_day_index": "INTEGER NOT NULL DEFAULT 1",
        "last_day_index": "INTEGER NOT NULL DEFAULT 0",
        "active": "INTEGER NOT NULL DEFAULT 1",
        "created_at": "TEXT NOT NULL DEFAULT ''",
    },
    "day_logs": {
        "planned_seconds": "INTEGER NOT NULL DEFAULT 0",
        "focus_seconds": "INTEGER NOT NULL DEFAULT 0",
        "completed": "INTEGER NOT NULL DEFAULT 0",
        "skipped": "INTEGER NOT NULL DEFAULT 0",
        "carried": "INTEGER NOT NULL DEFAULT 0",
        "capacity_minutes": "INTEGER NOT NULL DEFAULT 0",
        "note": "TEXT NOT NULL DEFAULT ''",
        "mood": "TEXT NOT NULL DEFAULT ''",
        "finished_at": "TEXT NOT NULL DEFAULT ''",
        "updated_at": "TEXT NOT NULL DEFAULT ''",
    },
    "events": {
        "at": "TEXT NOT NULL DEFAULT ''",
        "kind": "TEXT NOT NULL DEFAULT ''",
        "task_id": "INTEGER NOT NULL DEFAULT 0",
        "day_index": "INTEGER NOT NULL DEFAULT 0",
        "seconds": "INTEGER NOT NULL DEFAULT 0",
        "title": "TEXT NOT NULL DEFAULT ''",
        "meta": "TEXT NOT NULL DEFAULT '{}'",
    },
    "sessions": {
        "task_id": "INTEGER NOT NULL DEFAULT 0",
        "kind": "TEXT NOT NULL DEFAULT 'focus'",
        "seconds": "INTEGER NOT NULL DEFAULT 0",
        "planned_seconds": "INTEGER NOT NULL DEFAULT 0",
        "completed": "INTEGER NOT NULL DEFAULT 0",
        "day_index": "INTEGER NOT NULL DEFAULT 0",
        "started_at": "TEXT NOT NULL DEFAULT ''",
        "ended_at": "TEXT NOT NULL DEFAULT ''",
    },
    "snapshots": {
        "at": "TEXT NOT NULL DEFAULT ''",
        "label": "TEXT NOT NULL DEFAULT ''",
        "kind": "TEXT NOT NULL DEFAULT 'undo'",
        "payload": "TEXT NOT NULL DEFAULT '{}'",
    },
    "templates": {
        "name": "TEXT NOT NULL DEFAULT ''",
        "description": "TEXT NOT NULL DEFAULT ''",
        "kind": "TEXT NOT NULL DEFAULT 'task_set'",
        "payload": "TEXT NOT NULL DEFAULT '{}'",
        "use_count": "INTEGER NOT NULL DEFAULT 0",
        "created_at": "TEXT NOT NULL DEFAULT ''",
        "updated_at": "TEXT NOT NULL DEFAULT ''",
    },
    "routines": {
        "name": "TEXT NOT NULL DEFAULT ''",
        "description": "TEXT NOT NULL DEFAULT ''",
        "emoji": "TEXT NOT NULL DEFAULT '✨'",
        "color": "TEXT NOT NULL DEFAULT '#7b8db8'",
        "steps_json": "TEXT NOT NULL DEFAULT '[]'",
        "sort_order": "INTEGER NOT NULL DEFAULT 0",
        "archived": "INTEGER NOT NULL DEFAULT 0",
        "created_at": "TEXT NOT NULL DEFAULT ''",
        "updated_at": "TEXT NOT NULL DEFAULT ''",
    },
    "routine_runs": {
        "routine_id": "INTEGER NOT NULL DEFAULT 0",
        "name_snapshot": "TEXT NOT NULL DEFAULT ''",
        "steps_snapshot": "TEXT NOT NULL DEFAULT '[]'",
        "step_statuses_json": "TEXT NOT NULL DEFAULT '[]'",
        "status": "TEXT NOT NULL DEFAULT 'stopped'",
        "current_step_index": "INTEGER NOT NULL DEFAULT 0",
        "remaining_seconds": "INTEGER NOT NULL DEFAULT 0",
        "planned_seconds": "INTEGER NOT NULL DEFAULT 0",
        "elapsed_seconds": "INTEGER NOT NULL DEFAULT 0",
        "completed_steps": "INTEGER NOT NULL DEFAULT 0",
        "skipped_steps": "INTEGER NOT NULL DEFAULT 0",
        "day_index": "INTEGER NOT NULL DEFAULT 1",
        "started_at": "TEXT NOT NULL DEFAULT ''",
        "paused_at": "TEXT NOT NULL DEFAULT ''",
        "ended_at": "TEXT NOT NULL DEFAULT ''",
        "updated_at": "TEXT NOT NULL DEFAULT ''",
    },
}

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_tasks_day ON tasks(day_index, order_index)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_tag ON tasks(tag)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done)",
    "CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id)",
    "CREATE INDEX IF NOT EXISTS idx_events_at ON events(at)",
    "CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)",
    "CREATE INDEX IF NOT EXISTS idx_aliases_tag ON tag_aliases(tag_name)",
    "CREATE INDEX IF NOT EXISTS idx_routines_archived_order ON routines(archived, sort_order)",
    "CREATE INDEX IF NOT EXISTS idx_routine_runs_status ON routine_runs(status, id)",
]

# Columns that are allowed to be read/written generically by services.
TASK_FIELDS = list(COLUMN_DDL["tasks"].keys())
TAG_FIELDS = list(COLUMN_DDL["tags"].keys())
SUBTASK_FIELDS = list(COLUMN_DDL["subtasks"].keys())


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------
def get_db() -> sqlite3.Connection:
    db = getattr(g, "_taskarcade_db", None)
    if db is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        db = sqlite3.connect(DB_PATH, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("PRAGMA busy_timeout = 8000")
        g._taskarcade_db = db
    return db


def close_db(_exception=None) -> None:  # noqa: ARG001
    db = getattr(g, "_taskarcade_db", None)
    if db is not None:
        db.close()
        g._taskarcade_db = None


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"] for row in rows}


def _migrate_table(conn: sqlite3.Connection, table: str) -> int:
    """Add any columns declared in COLUMN_DDL that the live table is missing."""
    existing = table_columns(conn, table)
    added = 0
    for column, decl in COLUMN_DDL.get(table, {}).items():
        if column in existing:
            continue
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        added += 1
    return added


def init_db(seed_samples: bool | None = None) -> dict[str, Any]:
    """
    Create/upgrade the schema. Safe to call repeatedly.

    `seed_samples` controls the starter sample tasks:
      * None (default) — seed only when the database is brand new, so a user who
        deletes every task never sees samples reappear.
      * True / False — force the behaviour (used by tests and the reset tool).
    """
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    report = {"created": [], "migrated_columns": 0, "seeded": []}

    existing_tables = {
        row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    }
    is_fresh_database = not {"tasks", "settings"} & existing_tables
    task_columns_before = table_columns(conn, "tasks") if "tasks" in existing_tables else set()

    for table, ddl in TABLE_DDL.items():
        conn.execute(ddl)
        report["created"].append(table)
    for table in TABLE_DDL:
        report["migrated_columns"] += _migrate_table(conn, table)
    if "tasks" in existing_tables and "elapsed_seconds" not in task_columns_before:
        # Older releases represented elapsed task progress as total minus
        # remaining; completed tasks therefore inherit their planned duration.
        conn.execute(
            "UPDATE tasks SET elapsed_seconds = CASE WHEN done = 1 THEN MAX(0, total_seconds) "
            "ELSE MAX(0, total_seconds - remaining_seconds) END"
        )
    for statement in INDEXES:
        conn.execute(statement)

    # settings singleton -----------------------------------------------------
    if conn.execute("SELECT COUNT(*) AS c FROM settings").fetchone()["c"] == 0:
        conn.execute("INSERT INTO settings (id) VALUES (1)")
        report["seeded"].append("settings")

    # backfill any NULL settings with defaults -------------------------------
    row = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    updates, values = [], []
    for key, default in DEFAULT_SETTINGS.items():
        if key in row.keys() and row[key] is None:
            updates.append(f"{key} = ?")
            values.append(default)
    if updates:
        values.append(1)
        conn.execute(f"UPDATE settings SET {', '.join(updates)} WHERE id = ?", values)
    conn.execute("UPDATE settings SET updated_at = ? WHERE id = 1", (utc_now(),))

    # starter tags + aliases -------------------------------------------------
    if conn.execute("SELECT COUNT(*) AS c FROM tags").fetchone()["c"] == 0:
        _seed_tags(conn, DEFAULT_TAGS)
        report["seeded"].append("tags")

    # make sure every tag has at least a colour and a label -------------------
    for tag in conn.execute("SELECT * FROM tags").fetchall():
        if not tag["color"]:
            conn.execute("UPDATE tags SET color = ? WHERE tag_name = ?", ("#9775FA", tag["tag_name"]))
        if not tag["label"]:
            conn.execute(
                "UPDATE tags SET label = ? WHERE tag_name = ?",
                (tag["tag_name"].capitalize(), tag["tag_name"]),
            )

    # templates --------------------------------------------------------------
    if conn.execute("SELECT COUNT(*) AS c FROM templates").fetchone()["c"] == 0:
        for tpl in DEFAULT_TEMPLATES:
            conn.execute(
                "INSERT INTO templates (name, description, kind, payload, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    tpl["name"],
                    tpl["description"],
                    tpl["kind"],
                    json.dumps(tpl["payload"]),
                    utc_now(),
                    utc_now(),
                ),
            )
        report["seeded"].append("templates")

    # sample tasks (only on a brand-new database) ----------------------------
    wants_samples = is_fresh_database if seed_samples is None else bool(seed_samples)
    if wants_samples and conn.execute("SELECT COUNT(*) AS c FROM tasks").fetchone()["c"] == 0:
        _seed_tasks(conn, DEFAULT_SAMPLE_TASKS)
        report["seeded"].append("tasks")

    conn.commit()
    conn.close()
    return report


def _seed_tags(conn: sqlite3.Connection, tags: Iterable[dict]) -> None:
    for index, tag in enumerate(tags):
        conn.execute(
            "INSERT OR IGNORE INTO tags "
            "(tag_name, label, color, icon, description, default_minutes, sort_order, archived, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (
                tag["name"],
                tag.get("label") or tag["name"].capitalize(),
                tag["color"],
                tag.get("icon", "tag"),
                tag.get("description", ""),
                tag.get("default_minutes", 0),
                index,
                utc_now(),
            ),
        )
        for alias in tag.get("aliases", []):
            conn.execute(
                "INSERT OR IGNORE INTO tag_aliases (alias, tag_name, created_at) VALUES (?, ?, ?)",
                (alias.lower(), tag["name"], utc_now()),
            )


def _seed_tasks(conn: sqlite3.Connection, tasks: Iterable[dict]) -> None:
    now = utc_now()
    for index, task in enumerate(tasks):
        seconds = int(task.get("minutes", 30)) * 60
        conn.execute(
            "INSERT INTO tasks (day_index, title, notes, tag, priority, total_seconds, "
            "remaining_seconds, order_index, done, source, created_at, updated_at, last_touched_at) "
            "VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, 'sample', ?, ?, ?)",
            (
                task["title"],
                task.get("notes", ""),
                task.get("tag", ""),
                int(task.get("priority", 0)),
                seconds,
                seconds,
                index,
                now,
                now,
                now,
            ),
        )


# ---------------------------------------------------------------------------
# Optional adoption of a legacy V0.1 database
# ---------------------------------------------------------------------------
def legacy_summary() -> dict[str, Any]:
    for path in LEGACY_DB_PATHS:
        if os.path.exists(path):
            try:
                conn = sqlite3.connect(path)
                conn.row_factory = sqlite3.Row
                tasks = conn.execute("SELECT COUNT(*) AS c FROM tasks").fetchone()["c"]
                tags = conn.execute("SELECT COUNT(*) AS c FROM tags").fetchone()["c"]
                conn.close()
                return {"path": path, "tasks": tasks, "tags": tags}
            except sqlite3.Error:
                continue
    return {}


def import_legacy(path: str | None = None) -> dict[str, Any]:
    """Copy tasks/tags/settings from an older database into the current one."""
    source = path or legacy_summary().get("path")
    if not source or not os.path.exists(source):
        return {"error": "No legacy database found"}

    legacy = sqlite3.connect(source)
    legacy.row_factory = sqlite3.Row
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row

    imported = {"tasks": 0, "tags": 0}
    for tag in legacy.execute("SELECT * FROM tags").fetchall():
        name = (tag["tag_name"] or "").strip().lower()
        if not name:
            continue
        conn.execute(
            "INSERT OR IGNORE INTO tags (tag_name, label, color, icon, created_at) VALUES (?, ?, ?, 'tag', ?)",
            (name, name.capitalize(), tag["color"] or "#9775FA", utc_now()),
        )
        imported["tags"] += 1

    for task in legacy.execute("SELECT * FROM tasks").fetchall():
        conn.execute(
            "INSERT INTO tasks (day_index, title, notes, tag, priority, total_seconds, remaining_seconds, elapsed_seconds, "
            "order_index, done, source, created_at, updated_at, last_touched_at) "
            "VALUES (?, ?, '', ?, 0, ?, ?, ?, ?, ?, 'legacy', ?, ?, ?)",
            (
                task["day_index"],
                task["title"],
                (task["tag"] or "").strip().lower(),
                task["total_seconds"],
                task["remaining_seconds"],
                task["total_seconds"] if task["done"] else max(0, task["total_seconds"] - task["remaining_seconds"]),
                task["order_index"],
                1 if task["done"] else 0,
                utc_now(),
                utc_now(),
                utc_now(),
            ),
        )
        imported["tasks"] += 1

    conn.commit()
    conn.close()
    legacy.close()
    return {"ok": True, "imported": imported, "source": source}
