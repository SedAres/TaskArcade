"""Project persistence and aggregation for TaskArcade.

Projects are deliberately lightweight: tasks keep their own day-based planning
and execution data, while a project groups those tasks under a durable outcome.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from . import history
from .db import utc_now

PROJECT_STATUSES = {"active", "on_hold", "completed", "archived"}
DEFAULT_PROJECT_COLOR = "#4f46e5"
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _history_limit(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT undo_limit FROM settings WHERE id = 1").fetchone()
    return max(1, min(500, _int(row["undo_limit"], 40) if row else 40))


def _log(conn: sqlite3.Connection, kind: str, *, title: str = "", project_id: int = 0, meta: dict[str, Any] | None = None) -> None:
    from .services import log_event

    log_event(conn, kind, title=title, meta={"project_id": project_id, **(meta or {})})


def _values(data: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
    existing = existing or {}
    name = str(data.get("name", existing.get("name", "")) or "").strip()
    if not name:
        raise ValueError("A project needs a name")
    if len(name) > 100:
        raise ValueError("Project name is too long")

    description = str(data.get("description", existing.get("description", "")) or "").strip()
    if len(description) > 1200:
        description = description[:1200]

    color = str(data.get("color", existing.get("color", DEFAULT_PROJECT_COLOR)) or DEFAULT_PROJECT_COLOR).strip()
    if not _HEX_COLOR.fullmatch(color):
        raise ValueError("Choose a valid project color")

    status = str(data.get("status", existing.get("status", "active")) or "active").strip().lower()
    if status not in PROJECT_STATUSES:
        raise ValueError("Choose a valid project status")

    target_day = max(0, min(999999, _int(data.get("target_day", existing.get("target_day", 0)))))
    sort_order = _int(data.get("sort_order", existing.get("sort_order", 0)))
    return {
        "name": name,
        "description": description,
        "color": color.lower(),
        "status": status,
        "target_day": target_day,
        "sort_order": sort_order,
    }


def serialize_project(row: sqlite3.Row) -> dict[str, Any]:
    total = max(0, _int(row["task_count"])) if "task_count" in row.keys() else 0
    completed = max(0, _int(row["completed_count"])) if "completed_count" in row.keys() else 0
    planned = max(0, _int(row["planned_seconds"])) if "planned_seconds" in row.keys() else 0
    elapsed = max(0, _int(row["elapsed_seconds"])) if "elapsed_seconds" in row.keys() else 0
    return {
        "id": _int(row["id"]),
        "name": row["name"] or "",
        "description": row["description"] or "",
        "color": row["color"] or DEFAULT_PROJECT_COLOR,
        "status": row["status"] if row["status"] in PROJECT_STATUSES else "active",
        "target_day": max(0, _int(row["target_day"])),
        "sort_order": _int(row["sort_order"]),
        "task_count": total,
        "completed_count": completed,
        "open_count": max(0, total - completed),
        "planned_seconds": planned,
        "elapsed_seconds": elapsed,
        "progress": round((completed / total) * 100, 1) if total else 0,
        "created_at": row["created_at"] or "",
        "updated_at": row["updated_at"] or "",
    }


def list_projects(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT p.*, COUNT(t.id) AS task_count, "
        "SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END) AS completed_count, "
        "SUM(CASE WHEN t.id IS NOT NULL THEN t.total_seconds ELSE 0 END) AS planned_seconds, "
        "SUM(CASE WHEN t.id IS NOT NULL THEN t.elapsed_seconds ELSE 0 END) AS elapsed_seconds "
        "FROM projects AS p LEFT JOIN tasks AS t ON t.project_id = p.id AND t.archived = 0 "
        "GROUP BY p.id ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 "
        "WHEN 'completed' THEN 2 ELSE 3 END, p.sort_order ASC, p.id DESC"
    ).fetchall()
    return [serialize_project(row) for row in rows]


def get_project(conn: sqlite3.Connection, project_id: int) -> dict[str, Any]:
    project_id = max(1, _int(project_id))
    row = conn.execute(
        "SELECT p.*, COUNT(t.id) AS task_count, "
        "SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END) AS completed_count, "
        "SUM(CASE WHEN t.id IS NOT NULL THEN t.total_seconds ELSE 0 END) AS planned_seconds, "
        "SUM(CASE WHEN t.id IS NOT NULL THEN t.elapsed_seconds ELSE 0 END) AS elapsed_seconds "
        "FROM projects AS p LEFT JOIN tasks AS t ON t.project_id = p.id AND t.archived = 0 "
        "WHERE p.id = ? GROUP BY p.id", (project_id,)
    ).fetchone()
    if row is None:
        raise KeyError("Project not found")
    return serialize_project(row)


def create_project(conn: sqlite3.Connection, data: dict[str, Any]) -> dict[str, Any]:
    values = _values(data)
    history.push(conn, f"create project: {values['name']}", limit=_history_limit(conn))
    order = _int(conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM projects").fetchone()["n"])
    now = utc_now()
    cursor = conn.execute(
        "INSERT INTO projects (name, description, color, status, target_day, sort_order, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (values["name"], values["description"], values["color"], values["status"], values["target_day"], order, now, now),
    )
    project_id = int(cursor.lastrowid)
    _log(conn, "project.create", title=values["name"], project_id=project_id)
    return get_project(conn, project_id)


def update_project(conn: sqlite3.Connection, project_id: int, data: dict[str, Any]) -> dict[str, Any]:
    current = get_project(conn, project_id)
    values = _values(data, current)
    history.push(conn, f"update project: {current['name']}", limit=_history_limit(conn))
    now = utc_now()
    conn.execute(
        "UPDATE projects SET name = ?, description = ?, color = ?, status = ?, target_day = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        (values["name"], values["description"], values["color"], values["status"], values["target_day"], values["sort_order"], now, current["id"]),
    )
    _log(conn, "project.update", title=values["name"], project_id=current["id"])
    return get_project(conn, current["id"])


def delete_project(conn: sqlite3.Connection, project_id: int) -> dict[str, Any]:
    current = get_project(conn, project_id)
    history.push(conn, f"delete project: {current['name']}", limit=_history_limit(conn))
    cursor = conn.execute("UPDATE tasks SET project_id = 0, updated_at = ? WHERE project_id = ?", (utc_now(), current["id"]))
    conn.execute("DELETE FROM projects WHERE id = ?", (current["id"],))
    unassigned = cursor.rowcount or 0
    _log(conn, "project.delete", title=current["name"], project_id=current["id"], meta={"unassigned_tasks": unassigned})
    return {"deleted": current["id"], "unassigned_tasks": unassigned}


def validate_project_id(conn: sqlite3.Connection, value: Any) -> int:
    project_id = max(0, _int(value))
    if not project_id:
        return 0
    exists = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
    if exists is None:
        raise ValueError("Choose an existing project")
    return project_id
