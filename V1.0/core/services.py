"""
TaskArcade V1.0 — domain services.

Pure-ish functions that receive a sqlite connection and plain Python data and
return JSON-ready structures. The Flask layer (app.py) only does routing,
request parsing and error handling.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import history
from .config import (
    DEFAULT_SETTINGS,
    DEFAULT_TAGS,
    ENUM_SETTINGS,
    PALETTE_HEXES,
    SETTING_RANGES,
    SETTING_TYPES,
    priority_label,
)
from .parser import (
    ParseContext,
    humanize_rule,
    parse_bulk,
    parse_duration,
    parse_line,
    rule_matches_day,
    rule_to_human_short,
)
from .db import utc_now


# ===========================================================================
# Small helpers
# ===========================================================================
def _as_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _json_loads(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ===========================================================================
# Serialization
# ===========================================================================
def serialize_settings(row: sqlite3.Row) -> dict[str, Any]:
    data = {key: row[key] for key in row.keys() if key != "id"}
    for key, caster in SETTING_TYPES.items():
        if key not in data or data[key] is None:
            data[key] = DEFAULT_SETTINGS.get(key)
            continue
        if caster is bool:
            data[key] = bool(data[key])
        elif caster is float:
            data[key] = _as_float(data[key], DEFAULT_SETTINGS.get(key, 0.0))
        elif caster is int:
            data[key] = _as_int(data[key], DEFAULT_SETTINGS.get(key, 0))
        else:
            data[key] = str(data[key])
    return data


def serialize_tag(row: sqlite3.Row, aliases: list[str] | None = None) -> dict[str, Any]:
    return {
        "name": row["tag_name"],
        "label": row["label"] or row["tag_name"].capitalize(),
        "color": row["color"] or PALETTE_HEXES[17],
        "icon": row["icon"] or "tag",
        "description": row["description"] or "",
        "default_minutes": _as_int(row["default_minutes"], 0),
        "sort_order": _as_int(row["sort_order"], 0),
        "archived": bool(row["archived"]),
        "aliases": aliases or [],
    }


def serialize_subtask(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "title": row["title"],
        "done": bool(row["done"]),
        "order_index": _as_int(row["order_index"]),
    }


def serialize_task(row: sqlite3.Row, subtasks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    total = _as_int(row["total_seconds"])
    remaining = _as_int(row["remaining_seconds"])
    row_keys = row.keys()
    elapsed = max(0, _as_int(row["elapsed_seconds"])) if "elapsed_seconds" in row_keys else max(0, total - (0 if row["done"] else remaining))
    return {
        "id": row["id"],
        "day_index": _as_int(row["day_index"], 1),
        "project_id": _as_int(row["project_id"]) if "project_id" in row.keys() else 0,
        "title": row["title"],
        "notes": row["notes"] or "",
        "tag": row["tag"] or "",
        "priority": _as_int(row["priority"]),
        "total_seconds": total,
        "remaining_seconds": remaining,
        "elapsed_seconds": elapsed,
        "order_index": _as_int(row["order_index"]),
        "done": bool(row["done"]),
        "pinned": bool(row["pinned"]),
        "scheduled_at": row["scheduled_at"] or "",
        "reminder_at": row["reminder_at"] or "",
        "tomatoes_estimate": _as_int(row["tomatoes_estimate"]),
        "tomatoes_done": _as_int(row["tomatoes_done"]),
        "skipped_count": _as_int(row["skipped_count"]),
        "source": row["source"] or "manual",
        "recurrence_id": _as_int(row["recurrence_id"]),
        "focus_seconds": _as_int(row["focus_seconds"]),
        "created_at": row["created_at"] or "",
        "updated_at": row["updated_at"] or "",
        "completed_at": row["completed_at"] or "",
        "archived": bool(row["archived"]),
        "progress": round(((total - remaining) / total) * 100, 2) if total > 0 else (100.0 if row["done"] else 0.0),
        "subtasks": subtasks if subtasks is not None else [],
    }


def serialize_recurrence(row: sqlite3.Row) -> dict[str, Any]:
    rule = _json_loads(row["rule"], {})
    return {
        "id": row["id"],
        "title": row["title"],
        "notes": row["notes"] or "",
        "tag": row["tag"] or "",
        "priority": _as_int(row["priority"]),
        "duration_seconds": _as_int(row["duration_seconds"], 1800),
        "rule": rule,
        "rule_text": humanize_rule(rule),
        "rule_short": rule_to_human_short(rule),
        "anchor_day_index": _as_int(row["anchor_day_index"], 1),
        "last_day_index": _as_int(row["last_day_index"]),
        "active": bool(row["active"]),
    }


def serialize_template(row: sqlite3.Row) -> dict[str, Any]:
    payload = _json_loads(row["payload"], {})
    tasks = payload.get("tasks", []) if isinstance(payload, dict) else []
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "kind": row["kind"] or "task_set",
        "payload": payload,
        "task_count": len(tasks),
        "minutes": sum(_as_int(t.get("minutes", 0)) for t in tasks),
        "use_count": _as_int(row["use_count"]),
    }


def serialize_event(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "at": row["at"],
        "kind": row["kind"],
        "task_id": _as_int(row["task_id"]),
        "day_index": _as_int(row["day_index"]),
        "seconds": _as_int(row["seconds"]),
        "title": row["title"] or "",
        "meta": _json_loads(row["meta"], {}),
    }


def serialize_session(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "task_id": _as_int(row["task_id"]),
        "kind": row["kind"],
        "seconds": _as_int(row["seconds"]),
        "planned_seconds": _as_int(row["planned_seconds"]),
        "completed": bool(row["completed"]),
        "day_index": _as_int(row["day_index"]),
        "started_at": row["started_at"],
        "ended_at": row["ended_at"] or "",
    }


def serialize_day_log(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "day_index": _as_int(row["day_index"]),
        "planned_seconds": _as_int(row["planned_seconds"]),
        "focus_seconds": _as_int(row["focus_seconds"]),
        "completed": _as_int(row["completed"]),
        "skipped": _as_int(row["skipped"]),
        "carried": _as_int(row["carried"]),
        "capacity_minutes": _as_int(row["capacity_minutes"]),
        "note": row["note"] or "",
        "mood": row["mood"] or "",
        "finished_at": row["finished_at"] or "",
        "updated_at": row["updated_at"] or "",
    }


# ===========================================================================
# Events
# ===========================================================================
def log_event(
    conn: sqlite3.Connection,
    kind: str,
    *,
    task_id: int = 0,
    day_index: int = 0,
    seconds: int = 0,
    title: str = "",
    meta: dict[str, Any] | None = None,
) -> None:
    conn.execute(
        "INSERT INTO events (at, kind, task_id, day_index, seconds, title, meta) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (now_iso(), kind, _as_int(task_id), _as_int(day_index), _as_int(seconds), title, json.dumps(meta or {})),
    )


def list_events(conn: sqlite3.Connection, limit: int = 60, kind: str = "", task_id: int = 0) -> list[dict[str, Any]]:
    clauses, values = [], []
    if kind:
        clauses.append("kind LIKE ?")
        values.append(kind.replace("*", "%"))
    if task_id:
        clauses.append("task_id = ?")
        values.append(_as_int(task_id))
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(_clamp(limit, 1, 500))
    rows = conn.execute(f"SELECT * FROM events {where} ORDER BY id DESC LIMIT ?", values).fetchall()
    return [serialize_event(row) for row in rows]


def purge_events(conn: sqlite3.Connection, keep: int = 800) -> int:
    rows = conn.execute("SELECT id FROM events ORDER BY id DESC LIMIT ?", (_clamp(keep, 50, 20000),)).fetchall()
    if not rows:
        return 0
    floor_id = rows[-1]["id"]
    cursor = conn.execute("DELETE FROM events WHERE id < ?", (floor_id,))
    return cursor.rowcount or 0


# ===========================================================================
# Settings
# ===========================================================================
def get_settings_row(conn: sqlite3.Connection) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    if row is None:
        conn.execute("INSERT INTO settings (id) VALUES (1)")
        row = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    return row


def get_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    return serialize_settings(get_settings_row(conn))


def get_setting(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    settings = get_settings(conn)
    return settings.get(key, DEFAULT_SETTINGS.get(key, default))


def update_settings(conn: sqlite3.Connection, data: dict[str, Any], snapshot: bool = True) -> dict[str, Any]:
    if snapshot:
        history.push(conn, "settings update", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    fields, values = [], []
    for key, raw in (data or {}).items():
        if key not in SETTING_TYPES:
            continue
        if key in ENUM_SETTINGS and str(raw) not in ENUM_SETTINGS[key]:
            continue
        if key in SETTING_RANGES:
            caster = SETTING_TYPES[key]
            value = _as_float(raw, 0) if caster is float else _as_int(raw, 0)
            low, high = SETTING_RANGES[key]
            if caster is float:
                value = max(float(low), min(float(high), value))
            else:
                value = _clamp(int(value), int(low), int(high))
        elif SETTING_TYPES[key] is int or SETTING_TYPES[key] is float:
            value = _as_int(raw, 0)
        else:
            value = raw if isinstance(raw, str) else str(raw)
            if key == "calendar_start_date":
                value = value.strip()
                if value:
                    from .calendar import parse_calendar_date
                    current_mode = str(data.get("calendar_system") or get_setting(conn, "calendar_system", "auto"))
                    current_language = str(data.get("language") or get_setting(conn, "language", "en"))
                    parse_mode = current_mode if current_mode != "auto" else ("jalali" if current_language == "fa" else "gregorian")
                    try:
                        value = parse_calendar_date(value, parse_mode).isoformat()
                    except ValueError as exc:
                        raise ValueError("Calendar start date is not valid") from exc
            elif key == "timezone":
                value = value.strip()[:80]
                if value:
                    try:
                        ZoneInfo(value)
                    except (ZoneInfoNotFoundError, ValueError) as exc:
                        raise ValueError("Time zone must be a valid IANA name, such as Asia/Tehran") from exc
            elif key == "greeting":
                value = value.strip()[:120]
            if key == "accent" and value and value.upper() not in {c.upper() for c in PALETTE_HEXES}:
                # accept any custom hex the user pastes
                if not (value.startswith("#") and len(value) in (4, 7)):
                    continue
        fields.append(f"{key} = ?")
        values.append(value)

    if fields:
        # `WHERE id = 1` is a literal, so only the assignment values are bound.
        conn.execute(f"UPDATE settings SET {', '.join(fields)} WHERE id = 1", values)
        log_event(conn, "settings.update", meta={"keys": [f.split(" =")[0] for f in fields]})
    return get_settings(conn)


# ===========================================================================
# Tags & aliases
# ===========================================================================
def alias_map(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT alias, tag_name FROM tag_aliases").fetchall()
    mapping = {row["alias"].lower(): row["tag_name"] for row in rows}
    rows = conn.execute("SELECT tag_name FROM tags").fetchall()
    for row in rows:  # a tag always resolves to itself
        mapping.setdefault(row["tag_name"].lower(), row["tag_name"])
    return mapping


def tag_defaults(conn: sqlite3.Connection) -> dict[str, int]:
    rows = conn.execute("SELECT tag_name, default_minutes FROM tags").fetchall()
    return {row["tag_name"].lower(): _as_int(row["default_minutes"], 0) for row in rows}


def parse_context(conn: sqlite3.Connection) -> ParseContext:
    settings = get_settings(conn)
    return ParseContext(
        aliases=alias_map(conn),
        tag_defaults=tag_defaults(conn),
        default_duration_minutes=_as_int(settings.get("default_duration"), 30),
        pomodoro_minutes=_as_int(settings.get("pomodoro_focus"), 25),
        day_start_hour=_as_int(settings.get("day_start_hour"), 4),
    )


def next_tag_color(conn: sqlite3.Connection) -> str:
    used = {row["color"] for row in conn.execute("SELECT color FROM tags").fetchall()}
    for color in PALETTE_HEXES:
        if color not in used:
            return color
    count = conn.execute("SELECT COUNT(*) AS c FROM tags").fetchone()["c"]
    return PALETTE_HEXES[count % len(PALETTE_HEXES)]


def ensure_tag(conn: sqlite3.Connection, name: str) -> str:
    """Create the tag if needed and return the canonical name."""
    canonical = (name or "").strip().lstrip("#").lower()
    if not canonical:
        return ""
    row = conn.execute("SELECT tag_name FROM tags WHERE tag_name = ?", (canonical,)).fetchone()
    if row is None:
        order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM tags").fetchone()["n"]
        conn.execute(
            "INSERT INTO tags (tag_name, label, color, icon, description, default_minutes, sort_order, created_at) "
            "VALUES (?, ?, ?, 'tag', '', 0, ?, ?)",
            (canonical, canonical.capitalize(), next_tag_color(conn), order, utc_now()),
        )
        log_event(conn, "tag.add", title=canonical)
    return canonical


def list_tags(conn: sqlite3.Connection, include_archived: bool = False) -> list[dict[str, Any]]:
    clause = "" if include_archived else "WHERE archived = 0"
    rows = conn.execute(
        f"SELECT * FROM tags {clause} ORDER BY sort_order ASC, tag_name ASC"
    ).fetchall()
    alias_rows = conn.execute("SELECT alias, tag_name FROM tag_aliases ORDER BY LENGTH(alias) ASC").fetchall()
    grouped: dict[str, list[str]] = {}
    for row in alias_rows:
        grouped.setdefault(row["tag_name"], []).append(row["alias"])
    return [serialize_tag(row, grouped.get(row["tag_name"], [])) for row in rows]


def upsert_tag(conn: sqlite3.Connection, data: dict[str, Any]) -> dict[str, Any]:
    name = str(data.get("name", "")).strip().lstrip("#").lower()
    if not name:
        raise ValueError("Tag name is required")
    history.push(conn, f"tag {name}", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    existing = conn.execute("SELECT * FROM tags WHERE tag_name = ?", (name,)).fetchone()

    fields: dict[str, Any] = {}
    if "label" in data:
        fields["label"] = str(data["label"]).strip() or name.capitalize()
    if "color" in data and str(data["color"]).strip():
        fields["color"] = str(data["color"]).strip()
    if "icon" in data:
        fields["icon"] = str(data["icon"]).strip() or "tag"
    if "description" in data:
        fields["description"] = str(data["description"]).strip()
    if "default_minutes" in data:
        fields["default_minutes"] = _clamp(_as_int(data["default_minutes"], 0), 0, 1440)
    if "sort_order" in data:
        fields["sort_order"] = _as_int(data["sort_order"], 0)
    if "archived" in data:
        fields["archived"] = 1 if data["archived"] else 0

    if existing is None:
        fields.setdefault("label", name.capitalize())
        fields.setdefault("color", next_tag_color(conn))
        fields.setdefault("icon", "tag")
        fields.setdefault("description", "")
        fields.setdefault("default_minutes", 0)
        fields.setdefault("sort_order", 0)
        fields.setdefault("archived", 0)
        columns = ["tag_name", "created_at"] + list(fields.keys())
        values = [name, utc_now()] + list(fields.values())
        conn.execute(
            f"INSERT INTO tags ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            values,
        )
        log_event(conn, "tag.add", title=name)
    else:
        if fields:
            assignments = ", ".join(f"{key} = ?" for key in fields)
            conn.execute(f"UPDATE tags SET {assignments} WHERE tag_name = ?", list(fields.values()) + [name])
            log_event(conn, "tag.update", title=name, meta={"fields": list(fields.keys())})

    if "aliases" in data and isinstance(data["aliases"], list):
        set_aliases(conn, name, [str(a) for a in data["aliases"]])
    return {"name": name}


def set_aliases(conn: sqlite3.Connection, tag_name: str, aliases: Iterable[str]) -> list[str]:
    cleaned = []
    for alias in aliases:
        value = str(alias).strip().lstrip("#").lower()
        if not value or len(value) > 24:
            continue
        if value not in cleaned:
            cleaned.append(value)

    conn.execute("DELETE FROM tag_aliases WHERE tag_name = ?", (tag_name,))
    for value in cleaned:
        conn.execute(
            "INSERT OR REPLACE INTO tag_aliases (alias, tag_name, created_at) VALUES (?, ?, ?)",
            (value, tag_name, utc_now()),
        )
    log_event(conn, "alias.add", title=tag_name, meta={"aliases": cleaned})
    return cleaned


def add_alias(conn: sqlite3.Connection, alias: str, tag_name: str) -> dict[str, Any]:
    value = str(alias).strip().lstrip("#").lower()
    tag = str(tag_name).strip().lstrip("#").lower()
    if not value or not tag:
        raise ValueError("Alias and tag are required")
    if len(value) > 24:
        raise ValueError("Alias is too long")
    ensure_tag(conn, tag)
    conflict = conn.execute("SELECT tag_name FROM tag_aliases WHERE alias = ?", (value,)).fetchone()
    if conflict and conflict["tag_name"] != tag:
        raise ValueError(f"'{value}' already points at #{conflict['tag_name']}")
    conn.execute(
        "INSERT OR REPLACE INTO tag_aliases (alias, tag_name, created_at) VALUES (?, ?, ?)",
        (value, tag, utc_now()),
    )
    log_event(conn, "alias.add", title=tag, meta={"alias": value})
    return {"alias": value, "tag": tag}


def delete_alias(conn: sqlite3.Connection, alias: str) -> None:
    value = str(alias).strip().lstrip("#").lower()
    conn.execute("DELETE FROM tag_aliases WHERE alias = ?", (value,))
    log_event(conn, "alias.delete", meta={"alias": value})


def delete_tag(conn: sqlite3.Connection, name: str) -> dict[str, Any]:
    tag = str(name).strip().lstrip("#").lower()
    history.push(conn, f"delete tag #{tag}", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    affected = conn.execute("SELECT COUNT(*) AS c FROM tasks WHERE tag = ?", (tag,)).fetchone()["c"]
    conn.execute("DELETE FROM tags WHERE tag_name = ?", (tag,))
    conn.execute("UPDATE tasks SET tag = '' WHERE tag = ?", (tag,))
    log_event(conn, "tag.delete", title=tag, meta={"tasks_untagged": affected})
    return {"deleted": tag, "tasks_untagged": affected}


def merge_tags(conn: sqlite3.Connection, source: str, target: str) -> dict[str, Any]:
    src = str(source).strip().lstrip("#").lower()
    dst = ensure_tag(conn, target)
    if not src or not dst or src == dst:
        raise ValueError("Pick two different tags")
    history.push(conn, f"merge #{src} into #{dst}", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    cursor = conn.execute("UPDATE tasks SET tag = ? WHERE tag = ?", (dst, src))
    moved = cursor.rowcount or 0
    conn.execute("UPDATE tag_aliases SET tag_name = ? WHERE tag_name = ?", (dst, src))
    conn.execute("INSERT OR IGNORE INTO tag_aliases (alias, tag_name, created_at) VALUES (?, ?, ?)", (src, dst, utc_now()))
    conn.execute("DELETE FROM tags WHERE tag_name = ?", (src,))
    log_event(conn, "tag.update", title=dst, meta={"merged_from": src, "tasks": moved})
    return {"moved": moved, "target": dst}


def reorder_tags(conn: sqlite3.Connection, order: list[str]) -> None:
    for index, name in enumerate(order or []):
        conn.execute(
            "UPDATE tags SET sort_order = ? WHERE tag_name = ?",
            (index, str(name).strip().lstrip("#").lower()),
        )


# ===========================================================================
# Task helpers
# ===========================================================================
def _project_service():
    from . import projects as project_service
    return project_service


def task_row(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM tasks WHERE id = ?", (_as_int(task_id),)).fetchone()


def next_order(conn: sqlite3.Connection, day_index: int) -> int:
    row = conn.execute(
        "SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM tasks WHERE day_index = ?",
        (_as_int(day_index, 1),),
    ).fetchone()
    return _as_int(row["n"])


def default_duration_seconds(conn: sqlite3.Connection, tag: str = "") -> int:
    ctx = parse_context(conn)
    if tag and ctx.tag_defaults.get(tag.lower()):
        return ctx.tag_defaults[tag.lower()] * 60
    return _as_int(get_setting(conn, "default_duration", 30), 30) * 60


def subtasks_for(conn: sqlite3.Connection, task_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM subtasks WHERE task_id = ? ORDER BY order_index ASC, id ASC", (task_id,)
    ).fetchall()
    return [serialize_subtask(row) for row in rows]


def insert_task(conn: sqlite3.Connection, data: dict[str, Any], day_index: int) -> int:
    seconds = _as_int(data.get("seconds") or data.get("total_seconds") or 0)
    if seconds <= 0:
        seconds = default_duration_seconds(conn, str(data.get("tag", "")))
    tag = ensure_tag(conn, str(data.get("tag", ""))) if data.get("tag") else ""
    order = data.get("order_index")
    if order is None:
        order = next_order(conn, day_index)
    cursor = conn.execute(
        "INSERT INTO tasks (day_index, project_id, title, notes, tag, priority, total_seconds, remaining_seconds, "
        "order_index, done, pinned, scheduled_at, reminder_at, tomatoes_estimate, source, recurrence_id, "
        "created_at, updated_at, last_touched_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            day_index,
            _project_service().validate_project_id(conn, data.get("project_id", 0)),
            str(data.get("title", "")).strip(),
            str(data.get("notes", "") or ""),
            tag,
            _clamp(_as_int(data.get("priority", 0)), 0, 3),
            seconds,
            seconds,
            _as_int(order),
            1 if data.get("pinned") else 0,
            str(data.get("scheduled_at", "") or ""),
            str(data.get("reminder_at", "") or ""),
            _as_int(data.get("tomatoes_estimate", 0)),
            str(data.get("source", "manual")),
            _as_int(data.get("recurrence_id", 0)),
            utc_now(),
            utc_now(),
            utc_now(),
        ),
    )
    task_id = int(cursor.lastrowid)

    # reminder default when scheduled
    if data.get("scheduled_at") and not data.get("reminder_at"):
        lead = _as_int(get_setting(conn, "reminder_lead", 5), 5)
        reminder = derive_reminder(str(data["scheduled_at"]), lead)
        if reminder:
            conn.execute("UPDATE tasks SET reminder_at = ? WHERE id = ?", (reminder, task_id))

    for index, child in enumerate(data.get("subtasks") or []):
        title = str(child).strip()
        if not title:
            continue
        conn.execute(
            "INSERT INTO subtasks (task_id, title, done, order_index, created_at) VALUES (?, ?, 0, ?, ?)",
            (task_id, title, index, utc_now()),
        )

    log_event(
        conn,
        "task.create",
        task_id=task_id,
        day_index=day_index,
        seconds=seconds,
        title=str(data.get("title", "")),
        meta={"tag": tag, "source": data.get("source", "manual")},
    )
    return task_id


def derive_reminder(scheduled_at: str, lead_minutes: int) -> str:
    """Turn a scheduled value ('09:30' or ISO) into an ISO reminder moment."""
    if not scheduled_at:
        return ""
    try:
        if "T" in scheduled_at:
            base = datetime.fromisoformat(scheduled_at)
        else:
            hour, _, minute = scheduled_at.partition(":")
            today = datetime.now().date()
            base = datetime.combine(today, datetime.min.time()).replace(
                hour=_as_int(hour, 9), minute=_as_int(minute, 0)
            )
        return (base - timedelta(minutes=max(0, lead_minutes))).replace(microsecond=0).isoformat()
    except (ValueError, TypeError):
        return ""


def reindex_day(conn: sqlite3.Connection, day_index: int) -> None:
    rows = conn.execute(
        "SELECT id FROM tasks WHERE day_index = ? AND archived = 0 "
        "ORDER BY done ASC, order_index ASC, id ASC",
        (day_index,),
    ).fetchall()
    for index, row in enumerate(rows):
        conn.execute("UPDATE tasks SET order_index = ? WHERE id = ?", (index, row["id"]))


def update_task(conn: sqlite3.Connection, task_id: int, data: dict[str, Any]) -> dict[str, Any]:
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    history.push(conn, f"edit “{task['title'][:40]}”", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))

    fields: dict[str, Any] = {}
    if "title" in data and str(data["title"]).strip():
        fields["title"] = str(data["title"]).strip()
    if "notes" in data:
        fields["notes"] = str(data["notes"] or "")
    if "tag" in data:
        raw = str(data["tag"] or "").strip().lstrip("#").lower()
        if raw:
            ctx = parse_context(conn)
            resolved, _, _ = ctx.resolve_tag(raw)
            fields["tag"] = ensure_tag(conn, resolved)
        else:
            fields["tag"] = ""
    if "project_id" in data:
        fields["project_id"] = _project_service().validate_project_id(conn, data.get("project_id"))
    if "priority" in data:
        fields["priority"] = _clamp(_as_int(data["priority"]), 0, 3)
    if "pinned" in data:
        fields["pinned"] = 1 if data["pinned"] else 0
    if "scheduled_at" in data:
        fields["scheduled_at"] = str(data["scheduled_at"] or "")
        if fields["scheduled_at"]:
            lead = _as_int(get_setting(conn, "reminder_lead", 5), 5)
            fields["reminder_at"] = derive_reminder(fields["scheduled_at"], lead)
    if "reminder_at" in data:
        fields["reminder_at"] = str(data["reminder_at"] or "")
    if "tomatoes_estimate" in data:
        fields["tomatoes_estimate"] = max(0, _as_int(data["tomatoes_estimate"]))
    if "tomatoes_done" in data:
        fields["tomatoes_done"] = max(0, _as_int(data["tomatoes_done"]))
    if "skipped_count" in data:
        fields["skipped_count"] = max(0, _as_int(data["skipped_count"]))
    if "day_index" in data:
        fields["day_index"] = max(1, _as_int(data["day_index"], task["day_index"]))
    if "archived" in data:
        fields["archived"] = 1 if data["archived"] else 0

    # duration handling — three interchangeable ways to say the same thing
    new_total: int | None = None
    if "duration_text" in data and str(data["duration_text"]).strip():
        parsed = parse_duration(str(data["duration_text"]).strip(), _as_int(get_setting(conn, "pomodoro_focus", 25), 25))
        if parsed is None or parsed <= 0:
            raise ValueError("Invalid duration format")
        new_total = parsed
    elif "total_seconds" in data and str(data["total_seconds"]).strip() != "":
        candidate = _as_int(data["total_seconds"], -1)
        if candidate <= 0:
            raise ValueError("Duration must be greater than zero")
        new_total = candidate

    if new_total is not None:
        _apply_new_duration(conn, task, fields, new_total)

    if "remaining_seconds" in data:
        total = max(1, _as_int(fields.get("total_seconds", task["total_seconds"]), 1))
        remaining = _clamp(_as_int(data["remaining_seconds"]), 0, total)
        fields["remaining_seconds"] = remaining
        fields["elapsed_seconds"] = max(0, total - remaining)
        fields["done"] = 1 if remaining <= 0 else 0

    if "done" in data:
        is_done = bool(data["done"])
        fields["done"] = 1 if is_done else 0
        total = max(1, _as_int(fields.get("total_seconds", task["total_seconds"]), 1))
        if is_done:
            fields["remaining_seconds"] = 0
            fields["elapsed_seconds"] = total
            fields["completed_at"] = utc_now()
        else:
            fields["completed_at"] = ""
            fields["remaining_seconds"] = total
            fields["elapsed_seconds"] = 0

    if "elapsed_seconds" in data and str(data["elapsed_seconds"]).strip() != "":
        elapsed = _as_int(data["elapsed_seconds"], -1)
        if elapsed < 0:
            raise ValueError("Elapsed time cannot be negative")
        elapsed = min(elapsed, 7 * 24 * 3600)
        total = max(1, _as_int(fields.get("total_seconds", task["total_seconds"]), 1))
        is_done = bool(fields.get("done", task["done"]))
        fields["elapsed_seconds"] = elapsed
        fields["remaining_seconds"] = 0 if is_done else max(1, total - min(total, elapsed))
        fields["done"] = 1 if is_done else 0
        fields["completed_at"] = (fields.get("completed_at") or task["completed_at"] or utc_now()) if is_done else ""

    if fields:
        fields["updated_at"] = utc_now()
        fields["last_touched_at"] = utc_now()
        assignments = ", ".join(f"{key} = ?" for key in fields)
        conn.execute(f"UPDATE tasks SET {assignments} WHERE id = ?", list(fields.values()) + [task_id])
        log_event(
            conn,
            "task.update",
            task_id=task_id,
            day_index=_as_int(fields.get("day_index", task["day_index"])),
            title=str(fields.get("title", task["title"])),
            meta={"fields": [k for k in fields if k not in ("updated_at", "last_touched_at")]},
        )
    if "day_index" in fields and fields["day_index"] != task["day_index"]:
        reindex_day(conn, task["day_index"])
        reindex_day(conn, fields["day_index"])
    return {"id": task_id}


def _apply_new_duration(
    conn: sqlite3.Connection, task: sqlite3.Row, fields: dict[str, Any], new_total: int
) -> None:
    """Change a task's duration, preserving elapsed progress but never silently
    finishing a task the user is still working on."""
    old_total = _as_int(task["total_seconds"])
    old_remaining = _as_int(task["remaining_seconds"])
    task_keys = task.keys()
    elapsed = max(0, _as_int(task["elapsed_seconds"])) if "elapsed_seconds" in task_keys else max(
        0, old_total - (0 if task["done"] else old_remaining)
    )
    if old_total <= 0:
        elapsed = 0

    remaining = max(0, new_total - min(new_total, elapsed))
    if elapsed >= new_total and not bool(task["done"]) and new_total > 0:
        # Keep an unfinished task open even when its recorded time exceeds the
        # revised estimate; the separate elapsed value retains the overrun.
        remaining = 1
    fields["total_seconds"] = new_total
    fields["elapsed_seconds"] = elapsed
    fields["remaining_seconds"] = 0 if bool(task["done"]) else remaining
    fields["done"] = 1 if bool(task["done"]) else 0
    if _as_int(task["tomatoes_estimate"]) and not _as_int(task["tomatoes_done"]):
        pass  # keep the estimate as authored


def create_task(conn: sqlite3.Connection, data: dict[str, Any]) -> dict[str, Any]:
    history.push(conn, "add task", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    day_index = max(1, _as_int(data.get("day_index"), _as_int(get_setting(conn, "current_day_index", 1), 1)))
    task_id = insert_task(conn, data, day_index)
    return {"id": task_id, "day_index": day_index}


def bulk_create(conn: sqlite3.Connection, text: str, day_index: int | None = None) -> dict[str, Any]:
    ctx = parse_context(conn)
    good, bad = parse_bulk(text, ctx)
    if not good:
        return {"created": 0, "bad_lines": bad, "error": "No valid task lines found"}
    history.push(conn, f"bulk add {len(good)} task(s)", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    target_day = _as_int(day_index) or _as_int(get_setting(conn, "current_day_index", 1), 1)
    created = []
    for item in good:
        task_id = insert_task(conn, item, target_day)
        created.append(task_id)
        if item.get("recurrence"):
            create_recurrence(
                conn,
                {
                    "title": item["title"],
                    "tag": item["tag"],
                    "priority": item["priority"],
                    "duration_seconds": item["seconds"],
                    "rule": item["recurrence"],
                    "anchor_day_index": target_day,
                    "notes": item.get("notes", ""),
                },
                snapshot=False,
            )
    reindex_day(conn, target_day)
    return {"created": len(created), "ids": created, "bad_lines": bad, "day_index": target_day}


def delete_task(conn: sqlite3.Connection, task_id: int) -> dict[str, Any]:
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    history.push(conn, f"delete “{task['title'][:40]}”", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    conn.execute("DELETE FROM subtasks WHERE task_id = ?", (task_id,))
    conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    reindex_day(conn, _as_int(task["day_index"]))
    log_event(conn, "task.delete", task_id=task_id, day_index=_as_int(task["day_index"]), title=task["title"])
    return {"deleted": task_id}


def complete_task(conn: sqlite3.Connection, task_id: int, done: bool = True) -> dict[str, Any]:
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    history.push(conn, f"{'complete' if done else 'reopen'} “{task['title'][:40]}”",
                 limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    if done:
        conn.execute(
            "UPDATE tasks SET done = 1, remaining_seconds = 0, elapsed_seconds = total_seconds, completed_at = ?, updated_at = ?, last_touched_at = ? "
            "WHERE id = ?",
            (utc_now(), utc_now(), utc_now(), task_id),
        )
        log_event(conn, "task.done", task_id=task_id, day_index=_as_int(task["day_index"]),
                  seconds=_as_int(task["total_seconds"]), title=task["title"])
    else:
        total = max(1, _as_int(task["total_seconds"]))
        conn.execute(
            "UPDATE tasks SET done = 0, remaining_seconds = ?, elapsed_seconds = 0, completed_at = '', updated_at = ?, last_touched_at = ? "
            "WHERE id = ?",
            (total, utc_now(), utc_now(), task_id),
        )
        log_event(conn, "task.undone", task_id=task_id, day_index=_as_int(task["day_index"]), title=task["title"])
    return {"id": task_id, "done": done}


def skip_task(conn: sqlite3.Connection, task_id: int, to_end: bool = True) -> dict[str, Any]:
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    history.push(conn, f"skip “{task['title'][:40]}”", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    if to_end:
        order = next_order(conn, _as_int(task["day_index"]))
        conn.execute("UPDATE tasks SET order_index = ?, updated_at = ? WHERE id = ?", (order, utc_now(), task_id))
    conn.execute(
        "UPDATE tasks SET skipped_count = skipped_count + 1, last_touched_at = ? WHERE id = ?",
        (utc_now(), task_id),
    )
    log_event(conn, "task.skip", task_id=task_id, day_index=_as_int(task["day_index"]), title=task["title"])
    return {"id": task_id}


def tick_task(conn: sqlite3.Connection, task_id: int, remaining_seconds: float, seconds_spent: float = 0.0) -> dict[str, Any]:
    """Persist the countdown; optionally record focus seconds spent."""
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    total = _as_int(task["total_seconds"])
    remaining = int(max(0, min(total, round(_as_float(remaining_seconds, total)))))
    done = 1 if (remaining <= 0 and _as_int(get_setting(conn, "auto_done", 1)) == 1) else _as_int(task["done"])
    spent = max(0, int(round(_as_float(seconds_spent, 0))))
    elapsed = max(0, total - remaining)
    if spent:
        conn.execute(
            "UPDATE tasks SET remaining_seconds = ?, elapsed_seconds = ?, done = ?, focus_seconds = focus_seconds + ?, "
            "updated_at = ?, last_touched_at = ?, completed_at = CASE WHEN ? = 1 AND completed_at = '' "
            "THEN ? ELSE completed_at END WHERE id = ?",
            (remaining, elapsed, done, spent, utc_now(), utc_now(), done, utc_now(), task_id),
        )
    else:
        conn.execute(
            "UPDATE tasks SET remaining_seconds = ?, elapsed_seconds = ?, done = ?, updated_at = ?, last_touched_at = ?, "
            "completed_at = CASE WHEN ? = 1 AND completed_at = '' THEN ? ELSE completed_at END WHERE id = ?",
            (remaining, elapsed, done, utc_now(), utc_now(), done, utc_now(), task_id),
        )
    log_event(conn, "task.tick", task_id=task_id, day_index=_as_int(task["day_index"]),
              seconds=spent, title=task["title"])
    return {"id": task_id, "remaining_seconds": remaining, "done": bool(done)}


def toggle_start(conn: sqlite3.Connection, task_id: int) -> dict[str, Any]:
    """Flip a task's "in progress" marker (stored as completed_at sentinel-free
    flag: we use last_touched_at ordering and a dedicated event)."""
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    log_event(conn, "task.start" if not task["done"] else "task.pause", task_id=task_id,
              day_index=_as_int(task["day_index"]), title=task["title"])
    conn.execute("UPDATE tasks SET last_touched_at = ? WHERE id = ?", (utc_now(), task_id))
    return {"id": task_id}


def move_task(conn: sqlite3.Connection, task_id: int, day_index: int, order_index: int | None = None) -> dict[str, Any]:
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    history.push(conn, f"move “{task['title'][:40]}”", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    target_day = max(1, _as_int(day_index, task["day_index"]))
    target_order = next_order(conn, target_day) if order_index is None else _as_int(order_index)
    conn.execute(
        "UPDATE tasks SET day_index = ?, order_index = ?, updated_at = ?, last_touched_at = ? WHERE id = ?",
        (target_day, target_order, utc_now(), utc_now(), task_id),
    )
    if target_day != _as_int(task["day_index"]):
        reindex_day(conn, _as_int(task["day_index"]))
    reindex_day(conn, target_day)
    log_event(conn, "task.move", task_id=task_id, day_index=target_day, title=task["title"],
              meta={"from_day": _as_int(task["day_index"])})
    return {"id": task_id, "day_index": target_day}


def reorder_tasks(conn: sqlite3.Connection, order: list[int], day_index: int | None = None) -> dict[str, Any]:
    if not isinstance(order, list) or not order:
        raise ValueError("order must be a non-empty list of task ids")
    history.push(conn, "reorder tasks", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    for index, raw_id in enumerate(order):
        task_id = _as_int(raw_id, -1)
        if task_id <= 0:
            continue
        if day_index:
            conn.execute(
                "UPDATE tasks SET order_index = ?, day_index = ? WHERE id = ?",
                (index, _as_int(day_index), task_id),
            )
        else:
            conn.execute("UPDATE tasks SET order_index = ? WHERE id = ?", (index, task_id))
    log_event(conn, "task.reorder", meta={"count": len(order), "day_index": _as_int(day_index)})
    return {"reordered": len(order)}


def duplicate_task(conn: sqlite3.Connection, task_id: int) -> dict[str, Any]:
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    history.push(conn, f"duplicate “{task['title'][:40]}”", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    cursor = conn.execute(
        "INSERT INTO tasks (day_index, project_id, title, notes, tag, priority, total_seconds, remaining_seconds, order_index, "
        "done, pinned, scheduled_at, reminder_at, tomatoes_estimate, source, created_at, updated_at, last_touched_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', '', ?, 'manual', ?, ?, ?)",
        (
            _as_int(task["day_index"]),
            _as_int(task["project_id"]),
            f"{task['title']} (copy)",
            task["notes"] or "",
            task["tag"] or "",
            _as_int(task["priority"]),
            _as_int(task["total_seconds"]),
            _as_int(task["total_seconds"]),
            next_order(conn, _as_int(task["day_index"])),
            1 if task["pinned"] else 0,
            _as_int(task["tomatoes_estimate"]),
            utc_now(),
            utc_now(),
            utc_now(),
        ),
    )
    new_id = int(cursor.lastrowid)
    for child in subtasks_for(conn, task_id):
        conn.execute(
            "INSERT INTO subtasks (task_id, title, done, order_index, created_at) VALUES (?, ?, 0, ?, ?)",
            (new_id, child["title"], child["order_index"], utc_now()),
        )
    log_event(conn, "task.duplicate", task_id=new_id, day_index=_as_int(task["day_index"]), title=task["title"])
    return {"id": new_id}


def split_task(conn: sqlite3.Connection, task_id: int, pieces: int = 2, titles: list[str] | None = None) -> dict[str, Any]:
    """Break a task into N sequential chunks of equal remaining time."""
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    pieces = _clamp(_as_int(pieces, 2), 2, 12)
    history.push(conn, f"split “{task['title'][:40]}”", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    chunk = max(60, _as_int(task["remaining_seconds"]) // pieces)
    created = []
    base_day = _as_int(task["day_index"])
    base_order = _as_int(task["order_index"])
    conn.execute(
        "UPDATE tasks SET total_seconds = ?, remaining_seconds = ?, elapsed_seconds = 0, done = 0, updated_at = ? WHERE id = ?",
        (chunk, chunk, utc_now(), task_id),
    )
    for index in range(1, pieces):
        label = (titles[index - 1] if titles and index - 1 < len(titles) else f"{task['title']} · part {index + 1}")
        cursor = conn.execute(
            "INSERT INTO tasks (day_index, project_id, title, notes, tag, priority, total_seconds, remaining_seconds, "
            "order_index, done, source, created_at, updated_at, last_touched_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'split', ?, ?, ?)",
            (base_day, _as_int(task["project_id"]), label, task["notes"] or "", task["tag"] or "", _as_int(task["priority"]),
             chunk, chunk, base_order + index, utc_now(), utc_now(), utc_now()),
        )
        created.append(int(cursor.lastrowid))
    reindex_day(conn, base_day)
    log_event(conn, "task.split", task_id=task_id, day_index=base_day, title=task["title"],
              meta={"pieces": pieces, "created": created})
    return {"id": task_id, "created": created}


def purge_done(conn: sqlite3.Connection, day_index: int | None = None, older_than_days: int = 0) -> dict[str, Any]:
    """Archive (soft delete) finished tasks, optionally limited to a day."""
    history.push(conn, "purge finished tasks", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    clause = "done = 1 AND archived = 0"
    values: list[Any] = []
    if day_index:
        clause += " AND day_index = ?"
        values.append(_as_int(day_index))
    if older_than_days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).replace(microsecond=0).isoformat()
        clause += " AND completed_at != '' AND completed_at < ?"
        values.append(cutoff)
    cursor = conn.execute(f"UPDATE tasks SET archived = 1, updated_at = ? WHERE {clause}", [utc_now()] + values)
    count = cursor.rowcount or 0
    log_event(conn, "cleanup", meta={"archived": count, "day_index": _as_int(day_index)})
    return {"archived": count}


def unarchive(conn: sqlite3.Connection, task_id: int) -> dict[str, Any]:
    conn.execute("UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ?", (utc_now(), _as_int(task_id)))
    return {"id": _as_int(task_id)}


# ===========================================================================
# Subtasks
# ===========================================================================
def add_subtask(conn: sqlite3.Connection, task_id: int, title: str) -> dict[str, Any]:
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    title = str(title or "").strip()
    if not title:
        raise ValueError("Subtask title is required")
    order = conn.execute(
        "SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM subtasks WHERE task_id = ?", (task_id,)
    ).fetchone()["n"]
    cursor = conn.execute(
        "INSERT INTO subtasks (task_id, title, done, order_index, created_at) VALUES (?, ?, 0, ?, ?)",
        (task_id, title, order, utc_now()),
    )
    log_event(conn, "subtask.add", task_id=task_id, title=title)
    return {"id": int(cursor.lastrowid)}


def toggle_subtask(conn: sqlite3.Connection, subtask_id: int, done: bool | None = None) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM subtasks WHERE id = ?", (subtask_id,)).fetchone()
    if row is None:
        raise KeyError("Subtask not found")
    new_state = (not bool(row["done"])) if done is None else bool(done)
    conn.execute(
        "UPDATE subtasks SET done = ?, completed_at = ? WHERE id = ?",
        (1 if new_state else 0, utc_now() if new_state else "", subtask_id),
    )
    log_event(conn, "subtask.toggle", task_id=_as_int(row["task_id"]), title=row["title"],
              meta={"done": new_state})
    sync_task_from_subtasks(conn, _as_int(row["task_id"]))
    return {"id": subtask_id, "done": new_state}


def update_subtask(conn: sqlite3.Connection, subtask_id: int, data: dict[str, Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    if "title" in data and str(data["title"]).strip():
        fields["title"] = str(data["title"]).strip()
    if "order_index" in data:
        fields["order_index"] = _as_int(data["order_index"])
    if fields:
        assignments = ", ".join(f"{key} = ?" for key in fields)
        conn.execute(f"UPDATE subtasks SET {assignments} WHERE id = ?", list(fields.values()) + [subtask_id])
    return {"id": subtask_id}


def delete_subtask(conn: sqlite3.Connection, subtask_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM subtasks WHERE id = ?", (subtask_id,)).fetchone()
    if row is None:
        raise KeyError("Subtask not found")
    conn.execute("DELETE FROM subtasks WHERE id = ?", (subtask_id,))
    log_event(conn, "subtask.delete", task_id=_as_int(row["task_id"]), title=row["title"])
    return {"deleted": subtask_id}


def sync_task_from_subtasks(conn: sqlite3.Connection, task_id: int) -> None:
    """When every subtask is ticked, offer to finish the parent (auto if enabled).
    Progress is otherwise reflected through subtask counts only."""
    rows = conn.execute("SELECT done FROM subtasks WHERE task_id = ?", (task_id,)).fetchall()
    if not rows:
        return
    if all(row["done"] for row in rows) and _as_int(get_setting(conn, "auto_done", 1)) == 1:
        task = task_row(conn, task_id)
        if task is not None and not task["done"]:
            conn.execute(
                "UPDATE tasks SET done = 1, remaining_seconds = 0, elapsed_seconds = total_seconds, completed_at = ?, updated_at = ? WHERE id = ?",
                (utc_now(), utc_now(), task_id),
            )
            log_event(conn, "task.done", task_id=task_id, day_index=_as_int(task["day_index"]),
                      title=task["title"], meta={"via": "subtasks"})


# ===========================================================================
# Day progression
# ===========================================================================
def day_summary(conn: sqlite3.Connection, day_index: int) -> dict[str, Any]:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE day_index = ? AND archived = 0", (day_index,)
    ).fetchall()
    total = sum(_as_int(r["total_seconds"]) for r in rows)
    remaining = sum(0 if r["done"] else _as_int(r["remaining_seconds"]) for r in rows)
    elapsed = sum(max(0, _as_int(r["elapsed_seconds"])) for r in rows)
    done_count = sum(1 for r in rows if r["done"])
    focus = conn.execute(
        "SELECT COALESCE(SUM(seconds), 0) AS s FROM sessions WHERE day_index = ? AND kind = 'focus'",
        (day_index,),
    ).fetchone()["s"]
    capacity_row = conn.execute("SELECT capacity_minutes FROM day_logs WHERE day_index = ?", (day_index,)).fetchone()
    capacity_minutes = (
        _as_int(capacity_row["capacity_minutes"])
        if capacity_row is not None and _as_int(capacity_row["capacity_minutes"]) >= 0
        else _as_int(get_setting(conn, "capacity_minutes", 480), 480)
    )
    capacity = capacity_minutes * 60
    overdue = remaining > capacity > 0
    return {
        "day_index": day_index,
        "tasks": len(rows),
        "done": done_count,
        "open": len(rows) - done_count,
        "planned_seconds": total,
        "remaining_seconds": remaining,
        "done_seconds": elapsed,
        "elapsed_seconds": elapsed,
        "focus_seconds": _as_int(focus),
        "capacity_seconds": capacity,
        "capacity_minutes": capacity_minutes,
        "over_capacity": overdue,
        "completion": round((done_count / len(rows)) * 100, 1) if rows else 0.0,
        "progress": round(((total - remaining) / total) * 100, 1) if total else 0.0,
    }


def finish_day(conn: sqlite3.Connection, note: str = "", mood: str = "", carry: str | None = None) -> dict[str, Any]:
    settings = get_settings(conn)
    history.push(conn, "finish day", limit=_as_int(settings.get("undo_limit"), 40))
    current = _as_int(settings.get("current_day_index"), 1)
    next_day = current + 1
    mode = carry if carry in ("always", "ask", "never") else settings.get("carry_over", "always")

    summary = day_summary(conn, current)
    unfinished = conn.execute(
        "SELECT * FROM tasks WHERE day_index = ? AND done = 0 AND archived = 0 ORDER BY order_index ASC",
        (current,),
    ).fetchall()
    carried = 0
    if mode != "never":
        order = next_order(conn, next_day)
        for task in unfinished:
            conn.execute(
                "UPDATE tasks SET day_index = ?, order_index = ?, updated_at = ? WHERE id = ?",
                (next_day, order, utc_now(), task["id"]),
            )
            order += 1
            carried += 1
    if settings.get("auto_carry_done") and mode != "never":
        # finished tasks stay where they happened (they are history), unless the
        # user asked for a fresh weekly board.
        pass

    conn.execute(
        "INSERT INTO day_logs (day_index, planned_seconds, focus_seconds, completed, skipped, carried, "
        "capacity_minutes, note, mood, finished_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(day_index) DO UPDATE SET planned_seconds = excluded.planned_seconds, "
        "focus_seconds = excluded.focus_seconds, completed = excluded.completed, skipped = excluded.skipped, "
        "carried = excluded.carried, note = excluded.note, mood = excluded.mood, "
        "finished_at = excluded.finished_at, updated_at = excluded.updated_at",
        (
            current,
            summary["planned_seconds"],
            summary["focus_seconds"],
            summary["done"],
            conn.execute("SELECT COALESCE(SUM(skipped_count), 0) AS s FROM tasks WHERE day_index = ?", (current,)).fetchone()["s"],
            carried,
            summary["capacity_seconds"] // 60,
            str(note or ""),
            str(mood or ""),
            utc_now(),
            utc_now(),
        ),
    )
    conn.execute("UPDATE settings SET current_day_index = ?, updated_at = ? WHERE id = 1", (next_day, utc_now()))
    log_event(conn, "day.finish", day_index=current, meta={"carried": carried, "mode": mode, "mood": mood})
    return {"from": current, "to": next_day, "carried": carried, "summary": summary, "mode": mode}


def reopen_day(conn: sqlite3.Connection) -> dict[str, Any]:
    settings = get_settings(conn)
    current = _as_int(settings.get("current_day_index"), 1)
    if current <= 1:
        return {"current_day_index": 1, "error": "Already at the first day"}
    history.push(conn, "reopen previous day", limit=_as_int(settings.get("undo_limit"), 40))
    previous = current - 1
    conn.execute("UPDATE settings SET current_day_index = ?, updated_at = ? WHERE id = 1", (previous, utc_now()))
    conn.execute("DELETE FROM day_logs WHERE day_index = ?", (previous,))
    log_event(conn, "day.reopen", day_index=previous)
    return {"current_day_index": previous}


def log_day(conn: sqlite3.Connection, day_index: int, data: dict[str, Any]) -> dict[str, Any]:
    """Save a journal entry and (optionally) a day-specific capacity target.

    Planned/completed/focus totals are derived from the editable tasks and focus
    sessions. They are refreshed here rather than treated as independent facts.
    """
    day = max(1, _as_int(day_index, _as_int(get_setting(conn, "current_day_index", 1), 1)))
    existing = conn.execute("SELECT * FROM day_logs WHERE day_index = ?", (day,)).fetchone()
    summary = day_summary(conn, day)
    capacity = summary["capacity_minutes"]
    if "capacity_minutes" in data and str(data["capacity_minutes"]).strip() != "":
        capacity = _clamp(_as_int(data["capacity_minutes"], capacity), 0, 1440)
    note = str(data.get("note", existing["note"] if existing else "") or "")
    mood = str(data.get("mood", existing["mood"] if existing else "") or "")
    if mood not in ("", "great", "good", "ok", "rough", "awful"):
        raise ValueError("Unknown mood value")
    finished_at = (existing["finished_at"] or "") if existing else ""
    conn.execute(
        "INSERT INTO day_logs (day_index, planned_seconds, focus_seconds, completed, skipped, carried, "
        "capacity_minutes, note, mood, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(day_index) DO UPDATE SET planned_seconds = excluded.planned_seconds, "
        "focus_seconds = excluded.focus_seconds, completed = excluded.completed, "
        "capacity_minutes = excluded.capacity_minutes, note = excluded.note, mood = excluded.mood, "
        "updated_at = excluded.updated_at",
        (
            day, summary["planned_seconds"], summary["focus_seconds"], summary["done"],
            _as_int(existing["skipped"]) if existing else 0,
            _as_int(existing["carried"]) if existing else 0,
            capacity, note, mood, finished_at, utc_now(),
        ),
    )
    log_event(conn, "day.log", day_index=day, meta={"mood": mood})
    return {"day_index": day, "capacity_minutes": capacity}


def list_day_logs(conn: sqlite3.Connection, limit: int = 60) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM day_logs ORDER BY day_index DESC LIMIT ?", (_clamp(limit, 1, 400),)
    ).fetchall()
    return [serialize_day_log(row) for row in rows]


def day_detail(conn: sqlite3.Connection, day_index: int) -> dict[str, Any]:
    """Return every editable record associated with a virtual day."""
    day = max(1, _as_int(day_index, 1))
    rows = conn.execute("SELECT * FROM tasks WHERE day_index = ? ORDER BY archived ASC, order_index ASC, id ASC", (day,)).fetchall()
    tasks = [serialize_task(row, subtasks_for(conn, _as_int(row["id"]))) for row in rows]
    sessions = recent_sessions(conn, limit=300, day_index=day)
    log_row = conn.execute("SELECT * FROM day_logs WHERE day_index = ?", (day,)).fetchone()
    return {
        "day_index": day,
        "summary": day_summary(conn, day),
        "tasks": tasks,
        "sessions": sessions,
        "day_log": serialize_day_log(log_row) if log_row else {
            "day_index": day, "planned_seconds": 0, "focus_seconds": 0, "completed": 0,
            "skipped": 0, "carried": 0, "capacity_minutes": _as_int(get_setting(conn, "capacity_minutes", 480), 480),
            "note": "", "mood": "", "finished_at": "", "updated_at": "",
        },
    }


def _refresh_logged_days(conn: sqlite3.Connection, day_indices: set[int]) -> None:
    for day in {max(1, _as_int(value, 1)) for value in day_indices}:
        row = conn.execute("SELECT day_index FROM day_logs WHERE day_index = ?", (day,)).fetchone()
        if not row:
            continue
        summary = day_summary(conn, day)
        skipped = conn.execute("SELECT COALESCE(SUM(skipped_count), 0) AS s FROM tasks WHERE day_index = ?", (day,)).fetchone()["s"]
        conn.execute(
            "UPDATE day_logs SET planned_seconds = ?, focus_seconds = ?, completed = ?, skipped = ?, updated_at = ? WHERE day_index = ?",
            (summary["planned_seconds"], summary["focus_seconds"], summary["done"], _as_int(skipped), utc_now(), day),
        )


# ===========================================================================
# Focus sessions & pomodoro stats
# ===========================================================================
def start_session(conn: sqlite3.Connection, task_id: int, kind: str = "focus", planned_seconds: int = 0) -> dict[str, Any]:
    day = _as_int(get_setting(conn, "current_day_index", 1), 1)
    cursor = conn.execute(
        "INSERT INTO sessions (task_id, kind, seconds, planned_seconds, completed, day_index, started_at) "
        "VALUES (?, ?, 0, ?, 0, ?, ?)",
        (_as_int(task_id), "break" if kind == "break" else "focus", _as_int(planned_seconds), day, now_iso()),
    )
    session_id = int(cursor.lastrowid)
    log_event(conn, "break.start" if kind == "break" else "focus.start",
              task_id=_as_int(task_id), day_index=day, meta={"session_id": session_id})
    if kind != "break" and _as_int(task_id):
        conn.execute("UPDATE tasks SET last_touched_at = ? WHERE id = ?", (utc_now(), _as_int(task_id)))
    return {"id": session_id}


def end_session(conn: sqlite3.Connection, session_id: int, seconds: int, completed: bool = False,
                task_id: int = 0) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        # tolerate sessions that were never persisted (offline / optimistic UI)
        return {"id": session_id, "seconds": _as_int(seconds), "completed": bool(completed)}
    seconds = max(0, _as_int(seconds))
    conn.execute(
        "UPDATE sessions SET seconds = ?, completed = ?, ended_at = ?, task_id = ? WHERE id = ?",
        (seconds, 1 if completed else 0, now_iso(), _as_int(task_id) or _as_int(row["task_id"]), session_id),
    )
    kind = row["kind"] or "focus"
    resolved_task = _as_int(task_id) or _as_int(row["task_id"])
    if kind == "focus":
        log_event(conn, "focus.complete" if completed else "focus.abandon",
                  task_id=resolved_task, day_index=_as_int(row["day_index"]), seconds=seconds)
        if resolved_task and seconds > 0:
            conn.execute(
                "UPDATE tasks SET focus_seconds = focus_seconds + ?, last_touched_at = ? WHERE id = ?",
                (seconds, utc_now(), resolved_task),
            )
    else:
        log_event(conn, "break.complete" if completed else "focus.abandon",
                  task_id=resolved_task, day_index=_as_int(row["day_index"]), seconds=seconds)
    return {"id": session_id, "seconds": seconds, "completed": bool(completed), "kind": kind}


def recent_sessions(conn: sqlite3.Connection, limit: int = 40, day_index: int | None = None) -> list[dict[str, Any]]:
    if day_index is not None:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE day_index = ? ORDER BY id DESC LIMIT ?",
            (_as_int(day_index), _clamp(limit, 1, 300)),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY id DESC LIMIT ?", (_clamp(limit, 1, 300),)
        ).fetchall()
    return [serialize_session(row) for row in rows]


def update_session(conn: sqlite3.Connection, session_id: int, data: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (_as_int(session_id),)).fetchone()
    if row is None:
        raise KeyError("Focus session not found")
    fields: dict[str, Any] = {}
    if "seconds" in data:
        fields["seconds"] = _clamp(_as_int(data["seconds"]), 0, 7 * 24 * 3600)
    if "planned_seconds" in data:
        fields["planned_seconds"] = _clamp(_as_int(data["planned_seconds"]), 0, 7 * 24 * 3600)
    if "kind" in data:
        kind = str(data["kind"] or "").lower()
        if kind not in ("focus", "break"):
            raise ValueError("Session type must be focus or break")
        fields["kind"] = kind
    if "completed" in data:
        fields["completed"] = 1 if bool(data["completed"]) else 0
    if "day_index" in data:
        fields["day_index"] = max(1, _as_int(data["day_index"], _as_int(row["day_index"], 1)))
    if "task_id" in data:
        task_id = max(0, _as_int(data["task_id"]))
        if task_id and task_row(conn, task_id) is None:
            raise ValueError("Choose a task that still exists")
        fields["task_id"] = task_id
    for key in ("started_at", "ended_at"):
        if key in data:
            value = str(data[key] or "").strip()
            if value:
                try:
                    datetime.fromisoformat(value)
                except ValueError as exc:
                    raise ValueError(f"{key.replace('_', ' ').capitalize()} must be a valid date and time") from exc
            fields[key] = value
    if not fields:
        return {"id": session_id, "updated": False}

    history.push(conn, "edit focus session", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    old_task = _as_int(row["task_id"])
    old_kind = str(row["kind"] or "focus")
    old_seconds = _as_int(row["seconds"])
    values = list(fields.values()) + [_as_int(session_id)]
    conn.execute("UPDATE sessions SET " + ", ".join(f"{key} = ?" for key in fields) + " WHERE id = ?", values)
    new_task = _as_int(fields.get("task_id", old_task))
    new_kind = str(fields.get("kind", old_kind))
    new_seconds = _as_int(fields.get("seconds", old_seconds))
    if old_task and old_kind == "focus":
        conn.execute("UPDATE tasks SET focus_seconds = MAX(0, focus_seconds - ?) WHERE id = ?", (old_seconds, old_task))
    if new_task and new_kind == "focus":
        conn.execute("UPDATE tasks SET focus_seconds = focus_seconds + ? WHERE id = ?", (new_seconds, new_task))
    days = { _as_int(row["day_index"], 1), _as_int(fields.get("day_index", row["day_index"]), 1) }
    _refresh_logged_days(conn, days)
    log_event(conn, "session.update", task_id=new_task, day_index=_as_int(fields.get("day_index", row["day_index"])), seconds=new_seconds, meta={"session_id": session_id, "fields": list(fields)})
    updated = conn.execute("SELECT * FROM sessions WHERE id = ?", (_as_int(session_id),)).fetchone()
    return {"session": serialize_session(updated)}


def delete_session(conn: sqlite3.Connection, session_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (_as_int(session_id),)).fetchone()
    if row is None:
        raise KeyError("Focus session not found")
    history.push(conn, "delete focus session", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    if _as_int(row["task_id"]) and (row["kind"] or "focus") == "focus":
        conn.execute("UPDATE tasks SET focus_seconds = MAX(0, focus_seconds - ?) WHERE id = ?", (_as_int(row["seconds"]), _as_int(row["task_id"])))
    conn.execute("DELETE FROM sessions WHERE id = ?", (_as_int(session_id),))
    day = _as_int(row["day_index"], 1)
    _refresh_logged_days(conn, {day})
    log_event(conn, "session.delete", task_id=_as_int(row["task_id"]), day_index=day, seconds=_as_int(row["seconds"]))
    return {"deleted": _as_int(session_id)}


# ===========================================================================
# Recurrences
# ===========================================================================
def create_recurrence(conn: sqlite3.Connection, data: dict[str, Any], snapshot: bool = True) -> dict[str, Any]:
    if snapshot:
        history.push(conn, "add recurring task", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    title = str(data.get("title", "")).strip()
    if not title:
        raise ValueError("Recurrence needs a title")
    rule = data.get("rule") or {"freq": "daily", "interval": 1, "weekdays": [0, 1, 2, 3, 4], "time": ""}
    tag = ensure_tag(conn, str(data.get("tag", ""))) if data.get("tag") else ""
    anchor = max(1, _as_int(data.get("anchor_day_index"), _as_int(get_setting(conn, "current_day_index", 1), 1)))
    duration = _as_int(data.get("duration_seconds"), default_duration_seconds(conn, tag))
    cursor = conn.execute(
        "INSERT INTO recurrences (title, notes, tag, priority, duration_seconds, rule, anchor_day_index, "
        "last_day_index, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)",
        (
            title,
            str(data.get("notes", "") or ""),
            tag,
            _clamp(_as_int(data.get("priority", 0)), 0, 3),
            duration,
            json.dumps(rule),
            anchor,
            utc_now(),
        ),
    )
    return {"id": int(cursor.lastrowid), "rule_text": humanize_rule(rule)}


def list_recurrences(conn: sqlite3.Connection, active_only: bool = False) -> list[dict[str, Any]]:
    clause = "WHERE active = 1" if active_only else ""
    rows = conn.execute(f"SELECT * FROM recurrences {clause} ORDER BY id DESC").fetchall()
    return [serialize_recurrence(row) for row in rows]


def update_recurrence(conn: sqlite3.Connection, recurrence_id: int, data: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM recurrences WHERE id = ?", (recurrence_id,)).fetchone()
    if row is None:
        raise KeyError("Recurrence not found")
    history.push(conn, "edit recurring task", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    fields: dict[str, Any] = {}
    if "title" in data and str(data["title"]).strip():
        fields["title"] = str(data["title"]).strip()
    if "notes" in data:
        fields["notes"] = str(data["notes"] or "")
    if "tag" in data:
        fields["tag"] = ensure_tag(conn, str(data["tag"] or "")) if data["tag"] else ""
    if "priority" in data:
        fields["priority"] = _clamp(_as_int(data["priority"]), 0, 3)
    if "duration_seconds" in data:
        fields["duration_seconds"] = max(60, _as_int(data["duration_seconds"], 1800))
    if "rule" in data and isinstance(data["rule"], dict):
        fields["rule"] = json.dumps(data["rule"])
    if "active" in data:
        fields["active"] = 1 if data["active"] else 0
    if "anchor_day_index" in data:
        fields["anchor_day_index"] = max(1, _as_int(data["anchor_day_index"], 1))
    if fields:
        assignments = ", ".join(f"{key} = ?" for key in fields)
        conn.execute(f"UPDATE recurrences SET {assignments} WHERE id = ?", list(fields.values()) + [recurrence_id])
    return {"id": recurrence_id}


def delete_recurrence(conn: sqlite3.Connection, recurrence_id: int) -> dict[str, Any]:
    history.push(conn, "delete recurring task", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    conn.execute("DELETE FROM recurrences WHERE id = ?", (recurrence_id,))
    return {"deleted": recurrence_id}


def materialize_recurrences(conn: sqlite3.Connection, up_to_day: int) -> dict[str, Any]:
    """Create concrete tasks for every active recurrence within the horizon."""
    up_to_day = _as_int(up_to_day, 1)
    created = 0
    rows = conn.execute("SELECT * FROM recurrences WHERE active = 1").fetchall()
    calendar_start_date = str(get_setting(conn, "calendar_start_date", "") or "")
    for row in rows:
        rule = _json_loads(row["rule"], {})
        anchor = _as_int(row["anchor_day_index"], 1)
        start = max(_as_int(row["last_day_index"]) + 1, anchor)
        for day in range(start, up_to_day + 1):
            if not rule_matches_day(rule, day, anchor, calendar_start_date):
                continue
            exists = conn.execute(
                "SELECT id FROM tasks WHERE recurrence_id = ? AND day_index = ?",
                (row["id"], day),
            ).fetchone()
            if exists:
                continue
            seconds = _as_int(row["duration_seconds"], 1800)
            scheduled = rule.get("time") or ""
            insert_task(
                conn,
                {
                    "title": row["title"],
                    "notes": row["notes"] or "",
                    "tag": row["tag"] or "",
                    "priority": _as_int(row["priority"]),
                    "seconds": seconds,
                    "scheduled_at": scheduled,
                    "source": "recurrence",
                    "recurrence_id": row["id"],
                },
                day,
            )
            created += 1
        conn.execute("UPDATE recurrences SET last_day_index = ? WHERE id = ?", (max(up_to_day, _as_int(row["last_day_index"])), row["id"]))
    if created:
        log_event(conn, "recurrence.materialize", meta={"created": created, "up_to_day": up_to_day})
    return {"created": created}


# ===========================================================================
# Templates
# ===========================================================================
def list_templates(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM templates ORDER BY use_count DESC, name ASC").fetchall()
    return [serialize_template(row) for row in rows]


def save_template(conn: sqlite3.Connection, data: dict[str, Any]) -> dict[str, Any]:
    name = str(data.get("name", "")).strip()
    if not name:
        raise ValueError("Template name is required")
    payload = data.get("payload") or {}
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    existing = conn.execute("SELECT id FROM templates WHERE name = ?", (name,)).fetchone()
    if existing:
        conn.execute(
            "UPDATE templates SET description = ?, payload = ?, updated_at = ? WHERE id = ?",
            (str(data.get("description", "")), json.dumps(payload), utc_now(), existing["id"]),
        )
        return {"id": existing["id"], "updated": True}
    cursor = conn.execute(
        "INSERT INTO templates (name, description, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (name, str(data.get("description", "")), str(data.get("kind", "task_set")), json.dumps(payload), utc_now(), utc_now()),
    )
    return {"id": int(cursor.lastrowid), "updated": False}


def template_from_day(conn: sqlite3.Connection, day_index: int, name: str, description: str = "") -> dict[str, Any]:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE day_index = ? AND archived = 0 ORDER BY order_index ASC", (_as_int(day_index, 1),)
    ).fetchall()
    tasks = [
        {
            "title": row["title"],
            "tag": row["tag"] or "",
            "minutes": max(1, _as_int(row["total_seconds"]) // 60),
            "priority": _as_int(row["priority"]),
            "notes": row["notes"] or "",
        }
        for row in rows
    ]
    if not tasks:
        raise ValueError("That day has no tasks to save")
    return save_template(conn, {"name": name, "description": description, "payload": {"tasks": tasks}})


def delete_template(conn: sqlite3.Connection, template_id: int) -> dict[str, Any]:
    conn.execute("DELETE FROM templates WHERE id = ?", (template_id,))
    return {"deleted": template_id}


def apply_template(conn: sqlite3.Connection, template_id: int, day_index: int, shift_minutes: int = 0) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
    if row is None:
        raise KeyError("Template not found")
    tpl = serialize_template(row)
    history.push(conn, f"apply template “{tpl['name']}”", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    target_day = max(1, _as_int(day_index, _as_int(get_setting(conn, "current_day_index", 1), 1)))
    created = []
    cursor_minutes = 0
    start_time = str(tpl["payload"].get("start", "") or "")
    base_minutes = 0
    if start_time:
        hours, _, minutes = start_time.partition(":")
        base_minutes = _as_int(hours, 9) * 60 + _as_int(minutes, 0)

    for item in tpl["payload"].get("tasks", []):
        seconds = max(60, _as_int(item.get("minutes", 30)) * 60)
        scheduled = ""
        if start_time:
            absolute = base_minutes + cursor_minutes + shift_minutes
            scheduled = f"{(absolute // 60) % 24:02d}:{absolute % 60:02d}"
        cursor_minutes += seconds // 60
        created.append(
            insert_task(
                conn,
                {
                    "title": str(item.get("title", "Untitled")),
                    "tag": str(item.get("tag", "")),
                    "priority": _as_int(item.get("priority", 0)),
                    "seconds": seconds,
                    "notes": str(item.get("notes", "") or ""),
                    "scheduled_at": scheduled,
                    "source": "template",
                },
                target_day,
            )
        )
    conn.execute("UPDATE templates SET use_count = use_count + 1 WHERE id = ?", (template_id,))
    log_event(conn, "template.apply", day_index=target_day, meta={"template": tpl["name"], "count": len(created)})
    reindex_day(conn, target_day)
    return {"created": created, "day_index": target_day}


# ===========================================================================
# Full state
# ===========================================================================
def full_state(conn: sqlite3.Connection, include_meta: bool = True) -> dict[str, Any]:
    from .config import APP_NAME, APP_TAGLINE, APP_VERSION, PRIORITY_LABELS, SHORTCUTS, THEMES, DESIGNS
    from .stats import overview as stats_overview
    from .calendar import calendar_payload
    from . import routines as routine_service

    settings = get_settings(conn)
    tags = list_tags(conn)
    subtask_rows = conn.execute("SELECT * FROM subtasks ORDER BY order_index ASC, id ASC").fetchall()
    grouped: dict[int, list[dict[str, Any]]] = {}
    for row in subtask_rows:
        grouped.setdefault(_as_int(row["task_id"]), []).append(serialize_subtask(row))

    task_rows = conn.execute(
        "SELECT * FROM tasks WHERE archived = 0 ORDER BY day_index ASC, done ASC, pinned DESC, order_index ASC, id ASC"
    ).fetchall()
    tasks = [serialize_task(row, grouped.get(_as_int(row["id"]), [])) for row in task_rows]

    payload: dict[str, Any] = {
        "app": {"name": APP_NAME, "version": APP_VERSION, "tagline": APP_TAGLINE},
        "settings": settings,
        "calendar": calendar_payload(settings),
        "tags": tags,
        "aliases": alias_map(conn),
        "tasks": tasks,
        "projects": _project_service().list_projects(conn),
        "recurrences": list_recurrences(conn),
        "templates": list_templates(conn),
        "routines": routine_service.list_routines(conn),
        "active_routine_run": routine_service.active_run(conn),
        "routine_runs": routine_service.list_runs(conn, limit=12),
        "events": list_events(conn, limit=40),
        "sessions": recent_sessions(conn, limit=30),
        "day_logs": list_day_logs(conn, limit=45),
        "history": history.history(conn, limit=25),
    }
    if include_meta:
        payload["meta"] = {
            "themes": THEMES,
            "designs": DESIGNS,
            "palette": _palette_payload(),
            "shortcuts": SHORTCUTS,
            "priority_labels": {str(k): v for k, v in PRIORITY_LABELS.items()},
            "stats": stats_overview(conn),
            "today": day_summary(conn, _as_int(settings.get("current_day_index"), 1)),
            "legacy": _legacy_payload(),
        }
    return payload


def _palette_payload() -> list[dict[str, str]]:
    from .config import PALETTE
    return PALETTE


def _legacy_payload() -> dict[str, Any]:
    from .db import legacy_summary
    return legacy_summary()


def resolve_aliases(conn: sqlite3.Connection) -> dict[str, str]:
    return alias_map(conn)


# ===========================================================================
# Backup / restore
# ===========================================================================
EXPORT_TABLES = ["settings", "tags", "tag_aliases", "projects", "tasks", "subtasks", "recurrences", "day_logs", "templates", "routines", "routine_runs", "sessions"]


def export_backup(conn: sqlite3.Connection) -> dict[str, Any]:
    from .config import APP_VERSION
    data: dict[str, Any] = {
        "format": "taskarcade.backup",
        "version": APP_VERSION,
        "exported_at": now_iso(),
        "tables": {},
    }
    for table in EXPORT_TABLES:
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        data["tables"][table] = [dict(row) for row in rows]
    data["counts"] = {table: len(rows) for table, rows in data["tables"].items()}
    return data


def import_backup(conn: sqlite3.Connection, payload: dict[str, Any], mode: str = "merge") -> dict[str, Any]:
    history.push(conn, "import backup", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    tables = (payload or {}).get("tables", {})
    if not isinstance(tables, dict) or not tables:
        raise ValueError("Backup file has no tables")
    if mode == "replace":
        for table in ["subtasks", "tag_aliases", "recurrences", "tasks", "projects", "tags", "day_logs", "routine_runs", "routines", "templates", "sessions"]:
            conn.execute(f"DELETE FROM {table}")

    restored: dict[str, int] = {}
    for table in EXPORT_TABLES:
        rows = tables.get(table) or []
        if table == "settings":
            if rows:
                data = {k: v for k, v in rows[0].items() if k != "id" and k in SETTING_TYPES}
                update_settings(conn, data, snapshot=False)
            continue
        if not rows:
            restored[table] = 0
            continue
        valid_columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        count = 0
        for row in rows:
            record = dict(row) if isinstance(row, dict) else {}
            if table == "tasks" and "elapsed_seconds" not in record:
                total = _as_int(record.get("total_seconds"))
                remaining = _as_int(record.get("remaining_seconds"))
                record["elapsed_seconds"] = total if record.get("done") else max(0, total - remaining)
            columns = [column for column in record if column in valid_columns]
            if not columns:
                continue
            placeholders = ", ".join("?" for _ in columns)
            try:
                conn.execute(
                    f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES ({placeholders})",
                    [record[column] for column in columns],
                )
                count += 1
            except sqlite3.Error:
                continue
        restored[table] = count
    log_event(conn, "backup.import", meta={"restored": restored, "mode": mode})
    return {"restored": restored, "mode": mode}


# ===========================================================================
# Reminders
# ===========================================================================
def due_reminders(conn: sqlite3.Connection, within_minutes: int = 60) -> list[dict[str, Any]]:
    """Tasks whose reminder moment is inside the window (used by the client to
    raise a browser notification without a server push channel)."""
    minutes = _clamp(within_minutes, 1, 1440)
    now = datetime.now()
    horizon = now + timedelta(minutes=minutes)
    rows = conn.execute(
        "SELECT * FROM tasks WHERE archived = 0 AND done = 0 AND reminder_at != '' ORDER BY reminder_at ASC"
    ).fetchall()
    out = []
    for row in rows:
        raw = row["reminder_at"]
        try:
            when = datetime.fromisoformat(raw)
        except ValueError:
            continue
        # Compare in the same frame of reference: naive datetimes are treated as
        # local wall-clock time, aware ones are converted to local.
        when_local = when.astimezone().replace(tzinfo=None) if when.tzinfo else when
        if when_local <= horizon:
            item = serialize_task(row)
            item["due_in_seconds"] = int((when_local - now).total_seconds())
            out.append(item)
    return out


# ===========================================================================
# Bulk operations used by the UI
# ===========================================================================
def bulk_action(conn: sqlite3.Connection, action: str, ids: list[int], **kwargs: Any) -> dict[str, Any]:
    ids = [_as_int(i) for i in (ids or []) if _as_int(i) > 0]
    if not ids:
        raise ValueError("No tasks selected")
    history.push(conn, f"bulk {action}", limit=_as_int(get_setting(conn, "undo_limit", 40), 40))
    touched = 0
    for task_id in ids:
        try:
            if action == "done":
                complete_task(conn, task_id, True)
            elif action == "reopen":
                complete_task(conn, task_id, False)
            elif action == "delete":
                delete_task(conn, task_id)
            elif action == "skip":
                skip_task(conn, task_id)
            elif action == "move":
                move_task(conn, task_id, _as_int(kwargs.get("day_index"), 1))
            elif action == "tag":
                update_task(conn, task_id, {"tag": kwargs.get("tag", "")})
            elif action == "priority":
                update_task(conn, task_id, {"priority": _as_int(kwargs.get("priority"))})
            elif action == "duration":
                update_task(conn, task_id, {"duration_text": kwargs.get("duration_text")})
            elif action == "pin":
                toggle_pinned(conn, task_id)
            touched += 1
        except (KeyError, ValueError):
            continue
    return {"action": action, "touched": touched}


def toggle_pinned(conn: sqlite3.Connection, task_id: int) -> dict[str, Any]:
    task = task_row(conn, task_id)
    if task is None:
        raise KeyError("Task not found")
    new_state = 0 if task["pinned"] else 1
    conn.execute("UPDATE tasks SET pinned = ?, updated_at = ? WHERE id = ?", (new_state, utc_now(), task_id))
    return {"id": task_id, "pinned": bool(new_state)}


# ===========================================================================
# Ranking: which task deserves attention right now
# ===========================================================================
def build_focus_queue(conn: sqlite3.Connection, day_index: int | None = None) -> list[dict[str, Any]]:
    day = _as_int(day_index, _as_int(get_setting(conn, "current_day_index", 1), 1))
    rows = conn.execute(
        "SELECT * FROM tasks WHERE day_index = ? AND done = 0 AND archived = 0", (day,)
    ).fetchall()
    scored = []
    for row in rows:
        task = serialize_task(row, subtasks_for(conn, _as_int(row["id"])))
        score = 0.0
        score += _as_int(task["priority"]) * 12
        if task["pinned"]:
            score += 40
        overdue = _as_int(task["skipped_count"]) * 6
        score += min(30, overdue)
        if task["scheduled_at"]:
            score += 8
        subtask_total = len(task["subtasks"])
        if subtask_total:
            ratio = sum(1 for s in task["subtasks"] if s["done"]) / subtask_total
            score += ratio * 10
        # short tasks float upward so momentum is easy to build
        score += max(0, 20 - _as_int(task["remaining_seconds"]) / 300)
        task["focus_score"] = round(score, 2)
        scored.append(task)
    scored.sort(key=lambda t: (-t["focus_score"], t["order_index"]))
    return scored
