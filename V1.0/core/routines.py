"""Persistent routine definitions and guided routine-run state."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from .db import utc_now
from . import history

MAX_STEPS = 80
MAX_STEP_SECONDS = 6 * 60 * 60
MAX_ROUTINE_SECONDS = 24 * 60 * 60


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _json(raw: str | None, fallback: Any) -> Any:
    try:
        value = json.loads(raw or "")
        return value if isinstance(value, type(fallback)) else fallback
    except (TypeError, ValueError):
        return fallback


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _seconds_since(value: Any) -> int:
    try:
        stamp = datetime.fromisoformat(str(value or ""))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return max(0, int((datetime.now(timezone.utc) - stamp).total_seconds()))
    except (TypeError, ValueError):
        return 0


def _emit(conn: sqlite3.Connection, kind: str, *, title: str = "", routine_id: int = 0, meta: dict | None = None) -> None:
    # Kept local to avoid a services ↔ routines import cycle.
    from .services import log_event

    log_event(conn, kind, title=title, task_id=0, day_index=0, meta={"routine_id": routine_id, **(meta or {})})


def normalize_steps(raw_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ValueError("A routine needs at least one step")
    if len(raw_steps) > MAX_STEPS:
        raise ValueError(f"A routine can have at most {MAX_STEPS} steps")

    steps: list[dict[str, Any]] = []
    total = 0
    for index, raw in enumerate(raw_steps):
        if not isinstance(raw, dict):
            raise ValueError(f"Step {index + 1} must be an object")
        title = str(raw.get("title", "") or "").strip()
        if not title:
            raise ValueError(f"Step {index + 1} needs a name")
        if len(title) > 160:
            raise ValueError(f"Step {index + 1} name is too long")
        duration = _int(raw.get("duration_seconds"), 0)
        if duration <= 0:
            minutes = _int(raw.get("minutes"), 0)
            duration = minutes * 60
        duration = max(10, min(duration, MAX_STEP_SECONDS))
        total += duration
        steps.append({
            "title": title,
            "duration_seconds": duration,
            "emoji": str(raw.get("emoji", "") or "").strip()[:12],
            "notes": str(raw.get("notes", "") or "").strip()[:800],
        })
    if total > MAX_ROUTINE_SECONDS:
        raise ValueError("A routine cannot be longer than 24 hours")
    return steps


def serialize_routine(row: sqlite3.Row) -> dict[str, Any]:
    steps = _json(row["steps_json"], [])
    steps = normalize_steps(steps) if steps else []
    duration = sum(_int(step.get("duration_seconds")) for step in steps)
    return {
        "id": _int(row["id"]),
        "name": row["name"] or "",
        "description": row["description"] or "",
        "emoji": row["emoji"] or "✨",
        "color": row["color"] or "#7b8db8",
        "steps": steps,
        "step_count": len(steps),
        "duration_seconds": duration,
        "sort_order": _int(row["sort_order"]),
        "archived": bool(row["archived"]),
        "created_at": row["created_at"] or "",
        "updated_at": row["updated_at"] or "",
    }


def list_routines(conn: sqlite3.Connection, *, include_archived: bool = False) -> list[dict[str, Any]]:
    query = "SELECT * FROM routines" + ("" if include_archived else " WHERE archived = 0")
    query += " ORDER BY sort_order ASC, id ASC"
    return [serialize_routine(row) for row in conn.execute(query).fetchall()]


def get_routine(conn: sqlite3.Connection, routine_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM routines WHERE id = ? AND archived = 0", (_int(routine_id),)).fetchone()
    if row is None:
        raise KeyError("Routine not found")
    return serialize_routine(row)


def _routine_values(data: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
    existing = existing or {}
    name = str(data.get("name", existing.get("name", "")) or "").strip()
    if not name:
        raise ValueError("A routine needs a name")
    if len(name) > 100:
        raise ValueError("Routine name is too long")
    steps = normalize_steps(data.get("steps", existing.get("steps", [])))
    return {
        "name": name,
        "description": str(data.get("description", existing.get("description", "")) or "").strip()[:1200],
        "emoji": str(data.get("emoji", existing.get("emoji", "✨")) or "✨").strip()[:12],
        "color": str(data.get("color", existing.get("color", "#7b8db8")) or "#7b8db8").strip()[:32],
        "steps_json": json.dumps(steps, ensure_ascii=False),
    }


def create_routine(conn: sqlite3.Connection, data: dict[str, Any]) -> dict[str, Any]:
    values = _routine_values(data)
    now = utc_now()
    history.push(conn, f"create routine: {values['name']}")
    order = _int(conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM routines").fetchone()["n"])
    cursor = conn.execute(
        "INSERT INTO routines (name, description, emoji, color, steps_json, sort_order, archived, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        (values["name"], values["description"], values["emoji"], values["color"], values["steps_json"], order, now, now),
    )
    routine_id = int(cursor.lastrowid)
    _emit(conn, "routine.create", title=values["name"], routine_id=routine_id, meta={"steps": len(json.loads(values["steps_json"]))})
    return get_routine(conn, routine_id)


def update_routine(conn: sqlite3.Connection, routine_id: int, data: dict[str, Any]) -> dict[str, Any]:
    existing = get_routine(conn, routine_id)
    values = _routine_values(data, existing)
    history.push(conn, f"update routine: {existing['name']}")
    conn.execute(
        "UPDATE routines SET name = ?, description = ?, emoji = ?, color = ?, steps_json = ?, updated_at = ? WHERE id = ?",
        (values["name"], values["description"], values["emoji"], values["color"], values["steps_json"], utc_now(), _int(routine_id)),
    )
    _emit(conn, "routine.update", title=values["name"], routine_id=_int(routine_id))
    return get_routine(conn, routine_id)


def archive_routine(conn: sqlite3.Connection, routine_id: int) -> dict[str, Any]:
    existing = get_routine(conn, routine_id)
    history.push(conn, f"archive routine: {existing['name']}")
    conn.execute("UPDATE routines SET archived = 1, updated_at = ? WHERE id = ?", (utc_now(), _int(routine_id)))
    _emit(conn, "routine.archive", title=existing["name"], routine_id=_int(routine_id))
    return {"id": _int(routine_id), "archived": True}


def serialize_run(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    steps = _json(data.get("steps_snapshot"), [])
    statuses = _json(data.get("step_statuses_json"), ["pending"] * len(steps))
    index = max(0, min(_int(data.get("current_step_index")), max(0, len(steps) - 1)))
    current = steps[index] if steps and index < len(steps) else None
    stored_elapsed = max(0, _int(data.get("elapsed_seconds")))
    stored_remaining = max(0, _int(data.get("remaining_seconds")))
    is_running = (data.get("status") or "") == "running"
    live_elapsed = min(stored_remaining, _seconds_since(data.get("updated_at"))) if is_running else 0
    remaining = max(0, stored_remaining - live_elapsed)
    elapsed = stored_elapsed + live_elapsed
    unfinished_seconds = sum(
        _int(steps[i].get("duration_seconds"))
        for i in range(index + 1, len(steps))
        if i < len(statuses) and statuses[i] == "pending"
    )
    return {
        "id": _int(data.get("id")),
        "routine_id": _int(data.get("routine_id")),
        "name": data.get("name_snapshot") or "Routine",
        "steps": steps,
        "step_statuses": statuses,
        "status": data.get("status") or "stopped",
        "current_step_index": index,
        "current_step": current,
        "remaining_seconds": remaining,
        "planned_seconds": _int(data.get("planned_seconds")),
        "elapsed_seconds": elapsed,
        "remaining_total_seconds": remaining + unfinished_seconds,
        "completed_steps": _int(data.get("completed_steps")),
        "skipped_steps": _int(data.get("skipped_steps")),
        "day_index": _int(data.get("day_index"), 1),
        "started_at": data.get("started_at") or "",
        "paused_at": data.get("paused_at") or "",
        "ended_at": data.get("ended_at") or "",
        "updated_at": data.get("updated_at") or "",
    }


def active_run(conn: sqlite3.Connection) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM routine_runs WHERE status IN ('running', 'paused') ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return serialize_run(row) if row else None


def list_runs(conn: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM routine_runs ORDER BY id DESC LIMIT ?", (max(1, min(_int(limit, 20), 100)),)
    ).fetchall()
    return [serialize_run(row) for row in rows]


def start_run(conn: sqlite3.Connection, routine_id: int) -> dict[str, Any]:
    routine = get_routine(conn, routine_id)
    current = active_run(conn)
    if current:
        if current["routine_id"] == _int(routine_id):
            return current
        raise ValueError("Finish or stop the active routine before starting another")
    steps = routine["steps"]
    statuses = ["pending"] * len(steps)
    statuses[0] = "active"
    now = _now()
    day = 1
    try:
        from .services import get_setting
        day = max(1, _int(get_setting(conn, "current_day_index", 1), 1))
    except Exception:
        pass
    cursor = conn.execute(
        "INSERT INTO routine_runs (routine_id, name_snapshot, steps_snapshot, step_statuses_json, status, "
        "current_step_index, remaining_seconds, planned_seconds, elapsed_seconds, completed_steps, skipped_steps, "
        "day_index, started_at, paused_at, ended_at, updated_at) VALUES (?, ?, ?, ?, 'running', 0, ?, ?, 0, 0, 0, ?, ?, '', '', ?)",
        (routine["id"], routine["name"], json.dumps(steps, ensure_ascii=False), json.dumps(statuses),
         steps[0]["duration_seconds"], routine["duration_seconds"], day, now, now),
    )
    run_id = int(cursor.lastrowid)
    _emit(conn, "routine.run.start", title=routine["name"], routine_id=routine["id"], meta={"run_id": run_id})
    row = conn.execute("SELECT * FROM routine_runs WHERE id = ?", (run_id,)).fetchone()
    return serialize_run(row)


def command_run(conn: sqlite3.Connection, run_id: int, data: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM routine_runs WHERE id = ?", (_int(run_id),)).fetchone()
    if row is None:
        raise KeyError("Routine run not found")
    run = serialize_run(row)
    action = str(data.get("action", "") or "").strip().lower().replace("-", "_")
    if action not in {"checkpoint", "pause", "resume", "complete_step", "skip_step", "move_to_end", "stop"}:
        raise ValueError("Unknown routine action")
    if run["status"] not in ("running", "paused"):
        raise ValueError("This routine is no longer active")
    now = _now()
    remaining = max(0, min(_int(data.get("remaining_seconds"), run["remaining_seconds"]), run["remaining_seconds"], MAX_STEP_SECONDS))
    elapsed_after = run["elapsed_seconds"] + max(0, run["remaining_seconds"] - remaining)

    if action == "checkpoint":
        conn.execute("UPDATE routine_runs SET remaining_seconds = ?, elapsed_seconds = ?, updated_at = ? WHERE id = ?", (remaining, elapsed_after, now, run["id"]))
    elif action == "pause":
        if run["status"] != "running":
            return run
        conn.execute(
            "UPDATE routine_runs SET status = 'paused', remaining_seconds = ?, elapsed_seconds = ?, paused_at = ?, updated_at = ? WHERE id = ?",
            (remaining, elapsed_after, now, now, run["id"]),
        )
    elif action == "resume":
        if run["status"] == "running":
            return run
        conn.execute("UPDATE routine_runs SET status = 'running', paused_at = '', updated_at = ? WHERE id = ?", (now, run["id"]))
    elif action == "stop":
        conn.execute(
            "UPDATE routine_runs SET status = 'stopped', remaining_seconds = ?, elapsed_seconds = ?, ended_at = ?, updated_at = ? WHERE id = ?",
            (remaining, elapsed_after, now, now, run["id"]),
        )
        _emit(conn, "routine.run.stop", title=run["name"], routine_id=run["routine_id"], meta={"run_id": run["id"]})
    elif action == "move_to_end":
        step_index = run["current_step_index"]
        steps = list(run["steps"])
        statuses = list(run["step_statuses"])
        if step_index >= len(steps) - 1:
            raise ValueError("This step is already at the end of the routine")
        step = steps.pop(step_index)
        statuses.pop(step_index)
        steps.append(step)
        statuses.append("pending")
        next_index = next((i for i, status in enumerate(statuses) if status == "pending"), None)
        if next_index is None or next_index == len(steps) - 1:
            raise ValueError("There is no later step to move ahead of")
        statuses[next_index] = "active"
        new_status = "paused" if run["status"] == "paused" else "running"
        next_remaining = _int(steps[next_index].get("duration_seconds"))
        conn.execute(
            "UPDATE routine_runs SET steps_snapshot = ?, step_statuses_json = ?, status = ?, current_step_index = ?, "
            "remaining_seconds = ?, elapsed_seconds = ?, ended_at = '', paused_at = ?, updated_at = ? WHERE id = ?",
            (json.dumps(steps, ensure_ascii=False), json.dumps(statuses), new_status, next_index, next_remaining,
             elapsed_after, now if new_status == "paused" else "", now, run["id"]),
        )
        _emit(conn, "routine.step.move_end", title=step.get("title", ""), routine_id=run["routine_id"],
              meta={"run_id": run["id"], "step_index": step_index, "new_index": len(steps) - 1})
    else:
        step_index = run["current_step_index"]
        statuses = list(run["step_statuses"])
        step = run["current_step"]
        if step is None:
            raise ValueError("This routine has no current step")
        step_status = "completed" if action == "complete_step" else "skipped"
        statuses[step_index] = step_status
        completed = _int(run["completed_steps"]) + (1 if step_status == "completed" else 0)
        skipped = _int(run["skipped_steps"]) + (1 if step_status == "skipped" else 0)
        next_index = next((i for i in range(step_index + 1, len(statuses)) if statuses[i] == "pending"), None)
        if next_index is None:
            new_status = "completed"
            next_index = step_index
            next_remaining = 0
            ended_at = now
        else:
            new_status = "paused" if run["status"] == "paused" else "running"
            next_remaining = _int(run["steps"][next_index].get("duration_seconds"))
            ended_at = ""
            statuses[next_index] = "active"
        conn.execute(
            "UPDATE routine_runs SET step_statuses_json = ?, status = ?, current_step_index = ?, remaining_seconds = ?, "
            "elapsed_seconds = ?, completed_steps = ?, skipped_steps = ?, ended_at = ?, paused_at = ?, updated_at = ? WHERE id = ?",
            (json.dumps(statuses), new_status, next_index, next_remaining, elapsed_after, completed, skipped,
             ended_at, now if new_status == "paused" else "", now, run["id"]),
        )
        _emit(
            conn,
            "routine.step.done" if step_status == "completed" else "routine.step.skip",
            title=step.get("title", ""), routine_id=run["routine_id"],
            meta={"run_id": run["id"], "step_index": step_index},
        )
        if new_status == "completed":
            _emit(conn, "routine.run.finish", title=run["name"], routine_id=run["routine_id"], meta={"run_id": run["id"]})

    fresh = conn.execute("SELECT * FROM routine_runs WHERE id = ?", (run["id"],)).fetchone()
    return serialize_run(fresh)
