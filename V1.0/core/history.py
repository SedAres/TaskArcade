"""
TaskArcade V1.0 — undo/redo history.

Every mutating service call funnels through `snapshot()`, which stores the
complete application state (settings, tags, aliases, projects, tasks, subtasks,
recurrences and routines) in the `snapshots` table. `undo` restores the newest snapshot and
pushes the current state onto the redo stack; `redo` does the inverse.

A snapshot is small (a few KB of JSON) and the stack is capped by the
`undo_limit` setting so the database never grows without bound.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import utc_now

SNAPSHOT_TABLES = ["tags", "tag_aliases", "projects", "tasks", "subtasks", "recurrences", "routines"]


def capture(conn: sqlite3.Connection) -> dict[str, Any]:
    payload: dict[str, Any] = {"tables": {}}
    for table in SNAPSHOT_TABLES:
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        payload["tables"][table] = [dict(row) for row in rows]
    settings = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    if settings is not None:
        data = dict(settings)
        data.pop("updated_at", None)
        payload["settings"] = data
    return payload


def push(
    conn: sqlite3.Connection,
    label: str,
    kind: str = "undo",
    limit: int = 40,
    payload: dict[str, Any] | None = None,
) -> int:
    body = payload or capture(conn)
    cursor = conn.execute(
        "INSERT INTO snapshots (at, label, kind, payload) VALUES (?, ?, ?, ?)",
        (utc_now(), label, kind, json.dumps(body)),
    )
    snap_id = cursor.lastrowid
    _trim(conn, "undo", limit)
    if kind == "undo":
        conn.execute("DELETE FROM snapshots WHERE kind = 'redo'")
    return int(snap_id)


def _trim(conn: sqlite3.Connection, kind: str, limit: int) -> None:
    limit = max(5, int(limit or 40))
    rows = conn.execute(
        "SELECT id FROM snapshots WHERE kind = ? ORDER BY id DESC", (kind,)
    ).fetchall()
    if len(rows) <= limit:
        return
    stale = [row["id"] for row in rows[limit:]]
    conn.executemany("DELETE FROM snapshots WHERE id = ?", [(i,) for i in stale])


def _restore(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    tables = payload.get("tables", {})
    # Child rows first so FK cascades never wipe restored parents.
    for table in ["subtasks", "tag_aliases", "recurrences", "tasks", "projects", "tags", "routines"]:
        rows = tables.get(table)
        if rows is None:
            continue
        conn.execute(f"DELETE FROM {table}")
        if not rows:
            continue
        if table == "tasks":
            compatible_rows = []
            for task in rows:
                task = dict(task)
                if "elapsed_seconds" not in task:
                    total = int(task.get("total_seconds", 0) or 0)
                    remaining = int(task.get("remaining_seconds", 0) or 0)
                    task["elapsed_seconds"] = total if task.get("done") else max(0, total - remaining)
                compatible_rows.append(task)
            rows = compatible_rows
        columns = list(rows[0].keys())
        placeholders = ", ".join("?" for _ in columns)
        column_sql = ", ".join(columns)
        conn.executemany(
            f"INSERT INTO {table} ({column_sql}) VALUES ({placeholders})",
            [tuple(row.get(col) for col in columns) for row in rows],
        )

    settings = payload.get("settings")
    if settings:
        keys = [k for k in settings.keys() if k != "id"]
        if keys:
            assignments = ", ".join(f"{k} = ?" for k in keys)
            conn.execute(
                f"UPDATE settings SET {assignments}, updated_at = ? WHERE id = 1",
                [settings[k] for k in keys] + [utc_now()],
            )


def undo(conn: sqlite3.Connection, limit: int = 40) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM snapshots WHERE kind = 'undo' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if row is None:
        return {"ok": False, "error": "Nothing to undo"}

    previous = json.loads(row["payload"])
    current = capture(conn)
    push(conn, f"redo of {row['label']}", kind="redo", limit=limit, payload=current)
    _restore(conn, previous)
    conn.execute("DELETE FROM snapshots WHERE id = ?", (row["id"],))
    return {"ok": True, "label": row["label"]}


def redo(conn: sqlite3.Connection, limit: int = 40) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM snapshots WHERE kind = 'redo' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if row is None:
        return {"ok": False, "error": "Nothing to redo"}

    target = json.loads(row["payload"])
    current = capture(conn)
    push(conn, f"undo of {row['label']}", kind="undo", limit=limit, payload=current)
    _restore(conn, target)
    conn.execute("DELETE FROM snapshots WHERE id = ?", (row["id"],))
    return {"ok": True, "label": row["label"]}


def history(conn: sqlite3.Connection, limit: int = 30) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT id, at, label, kind FROM snapshots ORDER BY id DESC LIMIT ?", (max(1, limit),)
    ).fetchall()
    return [dict(row) for row in rows]


def clear(conn: sqlite3.Connection, kind: str | None = None) -> None:
    if kind:
        conn.execute("DELETE FROM snapshots WHERE kind = ?", (kind,))
    else:
        conn.execute("DELETE FROM snapshots")
