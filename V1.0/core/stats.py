"""
TaskArcade V1.0 — insights engine.

All numbers are derived from virtual days, not calendar dates, so the charts
stay meaningful for a user who works "day 12" of their own timeline.

Metrics produced here power:
  * the Insights sheet (heatmap, bars, tag split, focus totals)
  * the arcade theme's XP/level bar
  * the "streak" badge and capacity warnings
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .db import utc_now


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def _task_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM tasks WHERE archived = 0").fetchall()


def _session_rows(conn: sqlite3.Connection, days: int = 60) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM sessions ORDER BY id DESC LIMIT ?", (max(10, days * 20),)
    ).fetchall()


def per_day(conn: sqlite3.Connection, limit: int = 30) -> list[dict[str, Any]]:
    rows = _task_rows(conn)
    buckets: dict[int, dict[str, Any]] = defaultdict(
        lambda: {
            "day_index": 0,
            "planned_seconds": 0,
            "remaining_seconds": 0,
            "done_seconds": 0,
            "tasks": 0,
            "done": 0,
            "focus_seconds": 0,
            "tags": defaultdict(int),
        }
    )
    for row in rows:
        day = _safe_int(row["day_index"], 1)
        bucket = buckets[day]
        bucket["day_index"] = day
        total = _safe_int(row["total_seconds"])
        remaining = 0 if row["done"] else _safe_int(row["remaining_seconds"])
        elapsed = max(0, _safe_int(row["elapsed_seconds"])) if "elapsed_seconds" in row.keys() else max(0, total - remaining)
        bucket["planned_seconds"] += total
        bucket["remaining_seconds"] += remaining
        bucket["done_seconds"] += elapsed
        bucket["tasks"] += 1
        bucket["done"] += 1 if row["done"] else 0
        if row["tag"]:
            bucket["tags"][row["tag"]] += total

    for row in conn.execute(
        "SELECT day_index, SUM(seconds) AS s FROM sessions WHERE kind = 'focus' GROUP BY day_index"
    ).fetchall():
        buckets[_safe_int(row["day_index"], 1)]["focus_seconds"] += _safe_int(row["s"])

    ordered = sorted(buckets.values(), key=lambda b: b["day_index"])
    for bucket in ordered:
        bucket["tags"] = dict(bucket["tags"])
        bucket["progress"] = (
            min(100.0, round((bucket["done_seconds"] / bucket["planned_seconds"]) * 100, 1))
            if bucket["planned_seconds"]
            else 0.0
        )
        bucket["completion"] = round((bucket["done"] / bucket["tasks"]) * 100, 1) if bucket["tasks"] else 0.0
    return ordered[-limit:]


def tag_breakdown(conn: sqlite3.Connection, start_day: int | None = None, end_day: int | None = None) -> list[dict[str, Any]]:
    where = ["t.archived = 0"]
    values: list[int] = []
    if start_day is not None:
        where.append("t.day_index >= ?")
        values.append(int(start_day))
    if end_day is not None:
        where.append("t.day_index <= ?")
        values.append(int(end_day))
    rows = conn.execute(
        "SELECT t.tag AS tag, tags.color AS color, tags.label AS label, "
        "COUNT(*) AS tasks, SUM(CASE WHEN t.done = 1 THEN 1 ELSE 0 END) AS done, "
        "SUM(t.total_seconds) AS planned, SUM(t.focus_seconds) AS focus "
        "FROM tasks t LEFT JOIN tags ON tags.tag_name = t.tag "
        "WHERE " + " AND ".join(where) + " GROUP BY t.tag ORDER BY planned DESC",
        values,
    ).fetchall()
    out = []
    for row in rows:
        planned = _safe_int(row["planned"])
        tasks = _safe_int(row["tasks"])
        out.append(
            {
                "tag": row["tag"] or "",
                "label": row["label"] or (row["tag"] or "Untagged"),
                "color": row["color"] or "#8D99AE",
                "tasks": tasks,
                "done": _safe_int(row["done"]),
                "planned_seconds": planned,
                "focus_seconds": _safe_int(row["focus"]),
                "completion": round((_safe_int(row["done"]) / tasks) * 100, 1) if tasks else 0.0,
            }
        )
    return out


def streaks(conn: sqlite3.Connection) -> dict[str, Any]:
    """A day counts toward the streak when at least one task was finished."""
    rows = per_day(conn, limit=400)
    current = _safe_int(
        conn.execute("SELECT current_day_index FROM settings WHERE id = 1").fetchone()["current_day_index"], 1
    )
    by_day = {row["day_index"]: row for row in rows}

    best = 0
    run = 0
    for day in sorted(by_day.keys()):
        if by_day[day]["done"] > 0:
            run += 1
            best = max(best, run)
        else:
            run = 0

    streak = 0
    cursor = current
    while cursor >= 1:
        row = by_day.get(cursor)
        if row and row["done"] > 0:
            streak += 1
            cursor -= 1
        else:
            break

    perfect = sum(1 for row in rows if row["tasks"] and row["done"] == row["tasks"])
    return {
        "current": streak,
        "best": max(best, streak),
        "perfect_days": perfect,
        "active_days": sum(1 for row in rows if row["tasks"]),
    }


def level(conn: sqlite3.Connection) -> dict[str, Any]:
    """XP is earned per finished task weighted by its planned length."""
    rows = _task_rows(conn)
    xp = 0
    for row in rows:
        if row["done"]:
            xp += 20 + min(80, _safe_int(row["total_seconds"]) // 60)
    xp += conn.execute(
        "SELECT COALESCE(SUM(seconds), 0) AS s FROM sessions WHERE kind = 'focus'"
    ).fetchone()["s"] // 120
    level_number = 1
    threshold = 200
    remaining = xp
    while remaining >= threshold and level_number < 99:
        remaining -= threshold
        level_number += 1
        threshold = int(threshold * 1.25)
    titles = [
        "Wanderer", "Apprentice", "Steady Hand", "Focused", "Deep Worker",
        "Time Smith", "Momentum", "Marathoner", "Architect", "Time Lord",
    ]
    return {
        "xp": xp,
        "level": level_number,
        "title": titles[min(len(titles) - 1, (level_number - 1) // 3)],
        "into_level": remaining,
        "next_level": threshold,
        "progress": round((remaining / threshold) * 100, 1) if threshold else 0.0,
    }


def velocity(conn: sqlite3.Connection, window: int = 7) -> dict[str, Any]:
    """Average planned/completed minutes across the last N active days."""
    rows = per_day(conn, limit=window)
    if not rows:
        return {"avg_planned_minutes": 0, "avg_done_minutes": 0, "avg_focus_minutes": 0, "sample": 0}
    sample = len(rows)
    return {
        "avg_planned_minutes": round(sum(r["planned_seconds"] for r in rows) / sample / 60, 1),
        "avg_done_minutes": round(sum(r["done_seconds"] for r in rows) / sample / 60, 1),
        "avg_focus_minutes": round(sum(r["focus_seconds"] for r in rows) / sample / 60, 1),
        "sample": sample,
    }


def best_hours(conn: sqlite3.Connection, start_day: int | None = None, end_day: int | None = None) -> list[dict[str, Any]]:
    """Focus minutes bucketed by the configured local hour a session started."""
    buckets: dict[int, int] = defaultdict(int)
    zone_row = conn.execute("SELECT timezone FROM settings WHERE id = 1").fetchone()
    configured_zone = str((zone_row["timezone"] if zone_row else "") or "").strip()
    try:
        display_zone = ZoneInfo(configured_zone) if configured_zone else datetime.now().astimezone().tzinfo
    except (ZoneInfoNotFoundError, ValueError):
        display_zone = datetime.now().astimezone().tzinfo
    if start_day is None and end_day is None:
        rows = _session_rows(conn, days=30)
    else:
        where = []
        values: list[int] = []
        if start_day is not None:
            where.append("day_index >= ?")
            values.append(int(start_day))
        if end_day is not None:
            where.append("day_index <= ?")
            values.append(int(end_day))
        rows = conn.execute("SELECT * FROM sessions WHERE " + " AND ".join(where) + " ORDER BY id DESC LIMIT 10000", values).fetchall()
    for row in rows:
        if (row["kind"] or "focus") != "focus":
            continue
        raw = row["started_at"] or ""
        try:
            when = datetime.fromisoformat(raw)
        except ValueError:
            continue
        if when.tzinfo is not None and display_zone is not None:
            when = when.astimezone(display_zone)
        buckets[when.hour] += _safe_int(row["seconds"])
    out = [{"hour": hour, "minutes": round(buckets.get(hour, 0) / 60, 1)} for hour in range(24)]
    return out


def heatmap(conn: sqlite3.Connection, weeks: int = 12) -> list[dict[str, Any]]:
    """Virtual-day heatmap: intensity 0-4 based on finished task count."""
    rows = per_day(conn, limit=weeks * 7)
    by_day = {row["day_index"]: row for row in rows}
    if not by_day:
        return []
    current = _safe_int(
        conn.execute("SELECT current_day_index FROM settings WHERE id = 1").fetchone()["current_day_index"], 1
    )
    span = min(weeks * 7, max(1, current))
    out = []
    for day in range(max(1, current - span + 1), current + 1):
        row = by_day.get(day)
        done = row["done"] if row else 0
        intensity = 0
        if done >= 1:
            intensity = 1
        if done >= 3:
            intensity = 2
        if done >= 5:
            intensity = 3
        if done >= 8:
            intensity = 4
        out.append(
            {
                "day": day,
                "done": done,
                "planned_minutes": round((row["planned_seconds"] if row else 0) / 60),
                "focus_minutes": round((row["focus_seconds"] if row else 0) / 60),
                "intensity": intensity,
            }
        )
    return out


def overview(conn: sqlite3.Connection) -> dict[str, Any]:
    tasks = _task_rows(conn)
    total_tasks = len(tasks)
    done_tasks = sum(1 for row in tasks if row["done"])
    planned = sum(_safe_int(row["total_seconds"]) for row in tasks)
    remaining = sum(0 if row["done"] else _safe_int(row["remaining_seconds"]) for row in tasks)
    finished_seconds = sum(_safe_int(row["total_seconds"]) for row in tasks if row["done"])
    focus_total = _safe_int(
        conn.execute("SELECT COALESCE(SUM(seconds), 0) AS s FROM sessions WHERE kind = 'focus'").fetchone()["s"]
    )
    break_total = _safe_int(
        conn.execute("SELECT COALESCE(SUM(seconds), 0) AS s FROM sessions WHERE kind = 'break'").fetchone()["s"]
    )
    session_count = _safe_int(conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()["c"])
    completed_sessions = _safe_int(
        conn.execute("SELECT COUNT(*) AS c FROM sessions WHERE completed = 1").fetchone()["c"]
    )
    overdue = sum(1 for row in tasks if not row["done"] and _safe_int(row["skipped_count"]) >= 3)
    subtask_total = _safe_int(conn.execute("SELECT COUNT(*) AS c FROM subtasks").fetchone()["c"])
    subtask_done = _safe_int(
        conn.execute("SELECT COUNT(*) AS c FROM subtasks WHERE done = 1").fetchone()["c"]
    )
    current_day = _safe_int(
        conn.execute("SELECT current_day_index FROM settings WHERE id = 1").fetchone()["current_day_index"], 1
    )

    return {
        "generated_at": utc_now(),
        "current_day": current_day,
        "total_tasks": total_tasks,
        "done_tasks": done_tasks,
        "open_tasks": total_tasks - done_tasks,
        "completion": round((done_tasks / total_tasks) * 100, 1) if total_tasks else 0.0,
        "planned_seconds": planned,
        "remaining_seconds": remaining,
        "elapsed_seconds": sum(max(0, _safe_int(row["elapsed_seconds"])) for row in tasks),
        "finished_seconds": finished_seconds,
        "focus_seconds": focus_total,
        "break_seconds": break_total,
        "focus_ratio": round(focus_total / (focus_total + break_total) * 100, 1) if (focus_total + break_total) else 0.0,
        "sessions": session_count,
        "sessions_completed": completed_sessions,
        "session_completion": round((completed_sessions / session_count) * 100, 1) if session_count else 0.0,
        "overdue_tasks": overdue,
        "subtasks": subtask_total,
        "subtasks_done": subtask_done,
        "subtask_completion": round((subtask_done / subtask_total) * 100, 1) if subtask_total else 0.0,
        "tags": tag_breakdown(conn),
        "days": per_day(conn, limit=30),
        "streaks": streaks(conn),
        "level": level(conn),
        "velocity": velocity(conn),
        "hours": best_hours(conn),
        "heatmap": heatmap(conn),
    }


def _safe_ratio(numerator: float, denominator: float) -> float:
    return round((numerator / denominator) * 100, 1) if denominator else 0.0


def _period_totals(conn: sqlite3.Connection, start_day: int, end_day: int) -> dict[str, Any]:
    tasks = conn.execute(
        "SELECT * FROM tasks WHERE archived = 0 AND day_index BETWEEN ? AND ?", (start_day, end_day)
    ).fetchall()
    sessions = conn.execute(
        "SELECT * FROM sessions WHERE day_index BETWEEN ? AND ?", (start_day, end_day)
    ).fetchall()
    planned = sum(_safe_int(row["total_seconds"]) for row in tasks)
    done = sum(1 for row in tasks if row["done"])
    remaining = sum(0 if row["done"] else _safe_int(row["remaining_seconds"]) for row in tasks)
    elapsed = sum(max(0, _safe_int(row["elapsed_seconds"])) for row in tasks)
    focus = sum(_safe_int(row["seconds"]) for row in sessions if (row["kind"] or "focus") == "focus")
    breaks = sum(_safe_int(row["seconds"]) for row in sessions if (row["kind"] or "focus") == "break")
    completed_sessions = sum(1 for row in sessions if row["completed"])
    task_focus = sum(_safe_int(row["focus_seconds"]) for row in tasks)
    estimate_sample = [row for row in tasks if _safe_int(row["focus_seconds"]) > 0 and _safe_int(row["total_seconds"]) > 0]
    accuracy = (
        sum(max(0.0, 100.0 - abs(_safe_int(row["focus_seconds"]) - _safe_int(row["total_seconds"])) / _safe_int(row["total_seconds"]) * 100) for row in estimate_sample) / len(estimate_sample)
        if estimate_sample else 0.0
    )
    return {
        "total_tasks": len(tasks),
        "done_tasks": done,
        "open_tasks": len(tasks) - done,
        "completion": _safe_ratio(done, len(tasks)),
        "planned_seconds": planned,
        "remaining_seconds": remaining,
        "elapsed_seconds": elapsed,
        "finished_seconds": sum(_safe_int(row["total_seconds"]) for row in tasks if row["done"]),
        "focus_seconds": focus,
        "task_focus_seconds": task_focus,
        "break_seconds": breaks,
        "focus_ratio": _safe_ratio(focus, focus + breaks),
        "sessions": len(sessions),
        "sessions_completed": completed_sessions,
        "session_completion": _safe_ratio(completed_sessions, len(sessions)),
        "estimate_accuracy": round(accuracy, 1),
        "estimate_sample": len(estimate_sample),
        "focus_goal_days": 0,
        "days_with_tasks": len({int(row["day_index"]) for row in tasks}),
    }


def dashboard(conn: sqlite3.Connection, days: int = 30) -> dict[str, Any]:
    """Range-aware analytics dashboard with a gap-free daily series.

    ``days`` may be 7, 30, 90, 365 or 0 for all available virtual history.
    Future scheduled work is excluded from retrospective analytics.
    """
    settings = conn.execute("SELECT current_day_index, daily_goal_minutes, calendar_start_date FROM settings WHERE id = 1").fetchone()
    current = max(1, _safe_int(settings["current_day_index"], 1))
    requested = _safe_int(days, 30)
    if requested not in (0, 7, 30, 90, 365):
        requested = 30
    window = min(current, requested if requested else max(current, 1), 4000)
    start = max(1, current - window + 1)
    all_rows = per_day(conn, limit=4000)
    by_day = {int(row["day_index"]): row for row in all_rows if start <= int(row["day_index"]) <= current}
    series = []
    for day_index in range(start, current + 1):
        row = by_day.get(day_index, {})
        series.append({
            "day_index": day_index,
            "planned_seconds": _safe_int(row.get("planned_seconds")),
            "remaining_seconds": _safe_int(row.get("remaining_seconds")),
            "done_seconds": _safe_int(row.get("done_seconds")),
            "focus_seconds": _safe_int(row.get("focus_seconds")),
            "tasks": _safe_int(row.get("tasks")),
            "done": _safe_int(row.get("done")),
            "completion": _safe_int(row.get("completion")),
            "progress": _safe_int(row.get("progress")),
            "tags": row.get("tags", {}),
        })
    period = _period_totals(conn, start, current)
    goal = max(0, _safe_int(settings["daily_goal_minutes"], 240)) * 60
    period["focus_goal_days"] = sum(1 for row in series if goal > 0 and row["focus_seconds"] >= goal)
    period["avg_focus_seconds_per_day"] = round(period["focus_seconds"] / max(1, len(series)))
    period["avg_done_tasks_per_day"] = round(period["done_tasks"] / max(1, len(series)), 2)
    period["daily_goal_minutes"] = goal // 60
    period["period_start_day"] = start
    period["period_end_day"] = current
    period["period_days"] = len(series)

    previous_end = start - 1
    previous_start = max(1, previous_end - window + 1)
    previous = _period_totals(conn, previous_start, previous_end) if previous_end >= previous_start else {}
    compare = {}
    for key in ("focus_seconds", "done_tasks", "planned_seconds", "completion"):
        before = _safe_int(previous.get(key))
        after = _safe_int(period.get(key))
        compare[key] = {
            "current": after, "previous": before,
            "change": after - before,
            "change_percent": round(((after - before) / abs(before)) * 100, 1) if before else (100.0 if after else 0.0),
        }

    weekday_focus: dict[int, int] = defaultdict(int)
    anchor = str(settings["calendar_start_date"] or "")[:10]
    if anchor:
        try:
            from datetime import date, timedelta
            base = date.fromisoformat(anchor)
            for row in conn.execute("SELECT day_index, seconds FROM sessions WHERE day_index BETWEEN ? AND ? AND kind = 'focus'", (start, current)).fetchall():
                weekday = (base + timedelta(days=_safe_int(row["day_index"], 1) - 1)).weekday()
                weekday_focus[weekday] += _safe_int(row["seconds"])
        except (TypeError, ValueError, OverflowError):
            weekday_focus = defaultdict(int)

    return {
        "overview": {**period, "current_day": current, "overdue_tasks": overview(conn)["overdue_tasks"]},
        "lifetime": overview(conn),
        "days": series,
        "series": series,
        "range": {"days": requested, "start_day": start, "end_day": current, "count": len(series)},
        "comparison": compare,
        "tags": tag_breakdown(conn, start, current),
        "heatmap": heatmap(conn, weeks=max(1, min(52, (len(series) + 6) // 7))),
        "hours": best_hours(conn, start, current),
        "weekday_focus": [{"weekday": day, "seconds": weekday_focus.get(day, 0)} for day in range(7)],
        "streaks": streaks(conn),
        "level": level(conn),
        "velocity": {
            "avg_planned_minutes": round(sum(r["planned_seconds"] for r in series) / max(1, len(series)) / 60, 1),
            "avg_done_minutes": round(sum(r["done_seconds"] for r in series) / max(1, len(series)) / 60, 1),
            "avg_focus_minutes": round(sum(r["focus_seconds"] for r in series) / max(1, len(series)) / 60, 1),
            "sample": len(series),
        },
        "daily_goal_minutes": _safe_int(settings["daily_goal_minutes"], 240),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "trend": [{
            "label": "focused time",
            "recent": round(period["focus_seconds"] / 60, 1),
            "previous": round(_safe_int(previous.get("focus_seconds")) / 60, 1),
            "delta": round((period["focus_seconds"] - _safe_int(previous.get("focus_seconds"))) / 60, 1),
            "direction": "up" if period["focus_seconds"] > _safe_int(previous.get("focus_seconds")) else ("down" if period["focus_seconds"] < _safe_int(previous.get("focus_seconds")) else "flat"),
        }],
    }


def _trend(conn: sqlite3.Connection, window: int = 7) -> list[dict[str, Any]]:
    rows = per_day(conn, limit=window * 2)
    if len(rows) < 2:
        return []
    recent = rows[-window:]
    previous = rows[:-window] or recent
    recent_minutes = sum(r["done_seconds"] for r in recent) / 60
    previous_minutes = sum(r["done_seconds"] for r in previous) / 60
    delta = recent_minutes - previous_minutes
    return [
        {
            "label": "completed minutes",
            "recent": round(recent_minutes, 1),
            "previous": round(previous_minutes, 1),
            "delta": round(delta, 1),
            "direction": "up" if delta > 0 else ("down" if delta < 0 else "flat"),
        }
    ]


def minutes_to_human(minutes: float) -> str:
    minutes = int(round(minutes))
    hours, mins = divmod(minutes, 60)
    if hours and mins:
        return f"{hours}h {mins}m"
    if hours:
        return f"{hours}h"
    return f"{mins}m"


def relative_time(iso_string: str) -> str:
    try:
        when = datetime.fromisoformat(iso_string)
    except (TypeError, ValueError):
        return ""
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - when
    seconds = int(delta.total_seconds())
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    if seconds < 86400:
        return f"{seconds // 3600}h ago"
    if seconds < 604800:
        return f"{seconds // 86400}d ago"
    return when.strftime("%b %d")


def day_label(day_index: int, current: int) -> str:
    offset = day_index - current
    if offset == 0:
        return "Today"
    if offset == 1:
        return "Tomorrow"
    if offset == -1:
        return "Yesterday"
    if offset > 1:
        return f"In {offset} days"
    return f"{abs(offset)} days ago"


def week_window(day_index: int, week_start: int = 1) -> tuple[int, int]:
    offset = (day_index - 1) % 7
    start = day_index - offset
    return start, start + 6


def project_finish(remaining_seconds: int, velocity_seconds_per_day: float, current_day: int) -> int | None:
    if velocity_seconds_per_day <= 0 or remaining_seconds <= 0:
        return None
    return current_day + int(remaining_seconds // velocity_seconds_per_day) + 1


def sparkline(values: list[float], width: int = 40) -> str:
    """Tiny unicode sparkline for the terminal theme."""
    if not values:
        return ""
    blocks = "▁▂▃▄▅▆▇█"
    low, high = min(values), max(values)
    span = (high - low) or 1
    return "".join(blocks[min(7, int((v - low) / span * 7))] for v in values[-width:])


def budget_verdict(planned_seconds: int, capacity_seconds: int) -> dict[str, Any]:
    if capacity_seconds <= 0:
        return {"status": "unknown", "label": "No capacity set", "ratio": 0.0}
    ratio = planned_seconds / capacity_seconds
    if ratio <= 0.75:
        status, label = "light", "Room to spare"
    elif ratio <= 1.0:
        status, label = "full", "Day is full"
    elif ratio <= 1.4:
        status, label = "over", "Slightly over capacity"
    else:
        status, label = "critical", "Way over capacity"
    return {"status": status, "label": label, "ratio": round(ratio * 100, 1)}


def tag_totals(rows: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for row in rows:
        for tag, seconds in (row.get("tags") or {}).items():
            totals[tag] = totals.get(tag, 0) + int(seconds)
    return totals


def upcoming(conn: sqlite3.Connection, limit: int = 8) -> list[dict[str, Any]]:
    """The next few scheduled tasks across the whole timeline."""
    current = _safe_int(
        conn.execute("SELECT current_day_index FROM settings WHERE id = 1").fetchone()["current_day_index"], 1
    )
    rows = conn.execute(
        "SELECT * FROM tasks WHERE archived = 0 AND done = 0 AND scheduled_at != '' "
        "AND day_index >= ? ORDER BY day_index ASC, scheduled_at ASC LIMIT ?",
        (current, max(1, limit)),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "tag": row["tag"] or "",
            "day_index": _safe_int(row["day_index"], 1),
            "day_label": day_label(_safe_int(row["day_index"], 1), current),
            "scheduled_at": row["scheduled_at"],
            "remaining_seconds": _safe_int(row["remaining_seconds"]),
        }
        for row in rows
    ]


def week_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    current = _safe_int(
        conn.execute("SELECT current_day_index FROM settings WHERE id = 1").fetchone()["current_day_index"], 1
    )
    start, end = week_window(current)
    rows = per_day(conn, limit=400)
    window = [row for row in rows if start <= row["day_index"] <= end]
    return {
        "start": start,
        "end": end,
        "planned_seconds": sum(row["planned_seconds"] for row in window),
        "done_seconds": sum(row["done_seconds"] for row in window),
        "focus_seconds": sum(row["focus_seconds"] for row in window),
        "days": window,
    }


def cleanup_stats(conn: sqlite3.Connection) -> dict[str, Any]:
    archived = _safe_int(conn.execute("SELECT COUNT(*) AS c FROM tasks WHERE archived = 1").fetchone()["c"])
    events = _safe_int(conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"])
    snapshots = _safe_int(conn.execute("SELECT COUNT(*) AS c FROM snapshots").fetchone()["c"])
    oldest = conn.execute("SELECT MIN(at) AS m FROM events").fetchone()["m"] or ""
    return {
        "archived_tasks": archived,
        "events": events,
        "snapshots": snapshots,
        "oldest_event": oldest,
        "generated_at": utc_now(),
        "window_start": (datetime.now(timezone.utc) - timedelta(days=30)).isoformat(timespec="seconds"),
    }
