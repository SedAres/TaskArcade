"""
Time-based Kanban / Timeline app (Flask + SQLite).

This is a self-contained backend that:
  - Initializes and manages a SQLite database (kanban.db) next to this file.
  - Serves the single-page frontend from templates/index.html
    (which in turn loads templates/style.css and templates/script.js
    as static-ish assets via dedicated routes).
  - Exposes a small JSON API used by script.js to manage settings, tags,
    tasks, day progression ("Finish Day"), reordering, skip/done, and
    persisted countdown ticking.

No real calendar dates are used anywhere. Days are purely virtual integer
indexes (1, 2, 3, ...) that only ever advance when the user presses
"Finish Day" in the UI.
"""

import os
import re
import sqlite3
from datetime import datetime, timezone

from flask import Flask, g, jsonify, render_template, request, Response

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "kanban.db")

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Color palette: 20 distinct, dark-theme-friendly colors for tags.
# ---------------------------------------------------------------------------
PALETTE = [
    "#FF6B6B", "#FFA94D", "#FFD43B", "#A9E34B", "#69DB7C",
    "#38D9A9", "#22B8CF", "#4DABF7", "#748FFC", "#9775FA",
    "#DA77F2", "#F783AC", "#FF8787", "#FFC078", "#FFE066",
    "#C0EB75", "#8CE99A", "#63E6BE", "#66D9E8", "#91A7FF",
]

DEFAULT_TAGS = [("c", PALETTE[0]), ("s", PALETTE[7]), ("f", PALETTE[4])]

DEFAULT_SAMPLE_TASKS = [
    ("Vacuum the house", "c", 3600),
    ("Study English", "s", 3600),
    ("Study Geography", "s", 5100),
    ("Do homework", "s", 10800),
    ("Watch a movie", "f", 8400),
]


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        db = g._database = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
    return db


@app.teardown_appcontext
def close_connection(exception):  # noqa: ARG001
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            server_url TEXT NOT NULL DEFAULT '',
            current_day_index INTEGER NOT NULL DEFAULT 1,
            view_mode TEXT NOT NULL DEFAULT 'today',
            view_days INTEGER NOT NULL DEFAULT 3
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tags (
            tag_name TEXT PRIMARY KEY,
            color TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_index INTEGER NOT NULL,
            title TEXT NOT NULL,
            tag TEXT NOT NULL DEFAULT '',
            total_seconds INTEGER NOT NULL,
            remaining_seconds INTEGER NOT NULL,
            order_index INTEGER NOT NULL,
            done INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()

    if conn.execute("SELECT COUNT(*) AS c FROM settings").fetchone()["c"] == 0:
        conn.execute(
            "INSERT INTO settings (id, server_url, current_day_index, view_mode, view_days) "
            "VALUES (1, '', 1, 'today', 3)"
        )

    if conn.execute("SELECT COUNT(*) AS c FROM tags").fetchone()["c"] == 0:
        for name, color in DEFAULT_TAGS:
            conn.execute("INSERT INTO tags (tag_name, color) VALUES (?, ?)", (name, color))

    if conn.execute("SELECT COUNT(*) AS c FROM tasks").fetchone()["c"] == 0:
        now = datetime.now(timezone.utc).isoformat()
        for i, (title, tag, secs) in enumerate(DEFAULT_SAMPLE_TASKS):
            conn.execute(
                "INSERT INTO tasks "
                "(day_index, title, tag, total_seconds, remaining_seconds, order_index, done, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
                (1, title, tag, secs, secs, i, now),
            )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------
DURATION_RE = re.compile(r"^(?:(\d+)h)?(?:(\d+)m)?$", re.IGNORECASE)


def parse_duration_token(token):
    """Parse a duration token like '1h25m', '60m', '1h', '2h0m' into seconds."""
    token = token.strip().lower()
    match = DURATION_RE.match(token)
    if not match or (match.group(1) is None and match.group(2) is None):
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    return hours * 3600 + minutes * 60


def parse_bulk_text(text):
    """
    Parse multi-line bulk task text. Each line:
        <Task Title> #<Tag> <Duration>
    Returns a list of dicts: {title, tag, total_seconds}
    Lines that cannot be parsed are skipped (kept out of result), but
    we record them in `errors` for the caller to report back.
    """
    results = []
    errors = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        tokens = line.split()
        if len(tokens) < 3:
            errors.append(raw_line)
            continue

        duration_seconds = parse_duration_token(tokens[-1])
        if duration_seconds is None or duration_seconds <= 0:
            errors.append(raw_line)
            continue

        tag_token = None
        tag_index = None
        for idx, tok in enumerate(tokens[:-1]):
            if tok.startswith("#") and len(tok) > 1:
                tag_token = tok[1:]
                tag_index = idx
                break

        if tag_token is None:
            errors.append(raw_line)
            continue

        title_tokens = [t for i, t in enumerate(tokens[:-1]) if i != tag_index]
        title = " ".join(title_tokens).strip()
        if not title:
            errors.append(raw_line)
            continue

        results.append({"title": title, "tag": tag_token, "total_seconds": duration_seconds})

    return results, errors


def ensure_tag_exists(db, tag_name):
    if not tag_name:
        return
    row = db.execute("SELECT 1 FROM tags WHERE tag_name = ?", (tag_name,)).fetchone()
    if row is None:
        used_colors = {r["color"] for r in db.execute("SELECT color FROM tags").fetchall()}
        color = next((c for c in PALETTE if c not in used_colors), None)
        if color is None:
            count = db.execute("SELECT COUNT(*) AS c FROM tags").fetchone()["c"]
            color = PALETTE[count % len(PALETTE)]
        db.execute("INSERT INTO tags (tag_name, color) VALUES (?, ?)", (tag_name, color))


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------
def serialize_settings(row):
    return {
        "server_url": row["server_url"] or "",
        "current_day_index": row["current_day_index"],
        "view_mode": row["view_mode"],
        "view_days": row["view_days"],
    }


def serialize_tag(row):
    return {"name": row["tag_name"], "color": row["color"]}


def serialize_task(row):
    return {
        "id": row["id"],
        "day_index": row["day_index"],
        "title": row["title"],
        "tag": row["tag"],
        "total_seconds": row["total_seconds"],
        "remaining_seconds": row["remaining_seconds"],
        "order_index": row["order_index"],
        "done": bool(row["done"]),
    }


def full_state():
    db = get_db()
    settings = serialize_settings(db.execute("SELECT * FROM settings WHERE id = 1").fetchone())
    tags = [serialize_tag(r) for r in db.execute("SELECT * FROM tags ORDER BY tag_name").fetchall()]
    tasks = [
        serialize_task(r)
        for r in db.execute(
            "SELECT * FROM tasks ORDER BY day_index ASC, done ASC, order_index ASC"
        ).fetchall()
    ]
    return {"settings": settings, "tags": tags, "tasks": tasks, "palette": PALETTE}


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/style.css")
def style_css():
    path = os.path.join(BASE_DIR, "templates", "style.css")
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    return Response(content, mimetype="text/css")


@app.route("/script.js")
def script_js():
    path = os.path.join(BASE_DIR, "templates", "script.js")
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    return Response(content, mimetype="application/javascript")


# ---------------------------------------------------------------------------
# API: full state
# ---------------------------------------------------------------------------
@app.route("/api/state")
def api_state():
    return jsonify(full_state())


# ---------------------------------------------------------------------------
# API: settings
# ---------------------------------------------------------------------------
@app.route("/api/settings", methods=["POST"])
def api_update_settings():
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    fields = []
    values = []

    if "server_url" in data:
        fields.append("server_url = ?")
        values.append(str(data["server_url"]).strip())

    if "view_mode" in data and data["view_mode"] in ("today", "3days", "week", "custom"):
        fields.append("view_mode = ?")
        values.append(data["view_mode"])

    if "view_days" in data:
        try:
            view_days = max(1, min(30, int(data["view_days"])))
            fields.append("view_days = ?")
            values.append(view_days)
        except (TypeError, ValueError):
            pass

    if fields:
        values.append(1)
        db.execute(f"UPDATE settings SET {', '.join(fields)} WHERE id = ?", values)
        db.commit()

    return jsonify(full_state())


# ---------------------------------------------------------------------------
# API: tags
# ---------------------------------------------------------------------------
@app.route("/api/tags", methods=["POST"])
def api_add_or_update_tag():
    data = request.get_json(force=True, silent=True) or {}
    name = str(data.get("name", "")).strip().lstrip("#")
    if not name:
        return jsonify({"error": "Tag name is required"}), 400

    db = get_db()
    color = data.get("color")
    existing = db.execute("SELECT * FROM tags WHERE tag_name = ?", (name,)).fetchone()

    if color:
        if existing:
            db.execute("UPDATE tags SET color = ? WHERE tag_name = ?", (color, name))
        else:
            db.execute("INSERT INTO tags (tag_name, color) VALUES (?, ?)", (name, color))
    else:
        if not existing:
            ensure_tag_exists(db, name)
    db.commit()
    return jsonify(full_state())


@app.route("/api/tags/<tag_name>", methods=["DELETE"])
def api_delete_tag(tag_name):
    db = get_db()
    db.execute("DELETE FROM tags WHERE tag_name = ?", (tag_name,))
    db.commit()
    return jsonify(full_state())


# ---------------------------------------------------------------------------
# API: tasks
# ---------------------------------------------------------------------------
@app.route("/api/tasks/bulk", methods=["POST"])
def api_bulk_add_tasks():
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("text", "")
    db = get_db()

    try:
        day_index = int(data.get("day_index", 0))
    except (TypeError, ValueError):
        day_index = 0

    if day_index <= 0:
        day_index = db.execute("SELECT current_day_index FROM settings WHERE id = 1").fetchone()[
            "current_day_index"
        ]

    parsed, errors = parse_bulk_text(text)
    if not parsed:
        return jsonify({"error": "No valid task lines found", "bad_lines": errors}), 400

    max_order_row = db.execute(
        "SELECT COALESCE(MAX(order_index), -1) AS m FROM tasks WHERE day_index = ?", (day_index,)
    ).fetchone()
    next_order = max_order_row["m"] + 1
    now = datetime.now(timezone.utc).isoformat()

    for item in parsed:
        ensure_tag_exists(db, item["tag"])
        db.execute(
            "INSERT INTO tasks "
            "(day_index, title, tag, total_seconds, remaining_seconds, order_index, done, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
            (day_index, item["title"], item["tag"], item["total_seconds"], item["total_seconds"], next_order, now),
        )
        next_order += 1

    db.commit()
    result = full_state()
    result["bad_lines"] = errors
    return jsonify(result)


@app.route("/api/tasks/<int:task_id>", methods=["PATCH"])
def api_update_task(task_id):
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    task = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if task is None:
        return jsonify({"error": "Task not found"}), 404

    title = task["title"]
    tag = task["tag"]
    total_seconds = task["total_seconds"]
    remaining_seconds = task["remaining_seconds"]

    if "title" in data and str(data["title"]).strip():
        title = str(data["title"]).strip()

    if "tag" in data and str(data["tag"]).strip():
        tag = str(data["tag"]).strip().lstrip("#")
        ensure_tag_exists(db, tag)

    if "duration_text" in data and str(data["duration_text"]).strip():
        new_total = parse_duration_token(str(data["duration_text"]).strip())
        if new_total is None or new_total <= 0:
            return jsonify({"error": "Invalid duration format"}), 400
        elapsed = max(0, task["total_seconds"] - task["remaining_seconds"])
        total_seconds = new_total
        remaining_seconds = max(0, new_total - elapsed)
    elif "total_seconds" in data:
        try:
            new_total = int(data["total_seconds"])
            if new_total <= 0:
                raise ValueError
            elapsed = max(0, task["total_seconds"] - task["remaining_seconds"])
            total_seconds = new_total
            remaining_seconds = max(0, new_total - elapsed)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid total_seconds"}), 400

    done = 1 if remaining_seconds <= 0 else 0

    db.execute(
        "UPDATE tasks SET title = ?, tag = ?, total_seconds = ?, remaining_seconds = ?, done = ? WHERE id = ?",
        (title, tag, total_seconds, remaining_seconds, done, task_id),
    )
    db.commit()
    return jsonify(full_state())


@app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
def api_delete_task(task_id):
    db = get_db()
    db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    db.commit()
    return jsonify(full_state())


@app.route("/api/tasks/<int:task_id>/done", methods=["POST"])
def api_task_done(task_id):
    db = get_db()
    task = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if task is None:
        return jsonify({"error": "Task not found"}), 404
    db.execute("UPDATE tasks SET done = 1, remaining_seconds = 0 WHERE id = ?", (task_id,))
    db.commit()
    return jsonify(full_state())


@app.route("/api/tasks/<int:task_id>/skip", methods=["POST"])
def api_task_skip(task_id):
    db = get_db()
    task = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if task is None:
        return jsonify({"error": "Task not found"}), 404

    max_order_row = db.execute(
        "SELECT COALESCE(MAX(order_index), -1) AS m FROM tasks WHERE day_index = ?", (task["day_index"],)
    ).fetchone()
    new_order = max_order_row["m"] + 1
    db.execute("UPDATE tasks SET order_index = ? WHERE id = ?", (new_order, task_id))
    db.commit()
    return jsonify(full_state())


@app.route("/api/tasks/<int:task_id>/tick", methods=["POST"])
def api_task_tick(task_id):
    """Persist the current remaining_seconds for a task (called periodically by the client)."""
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    task = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if task is None:
        return jsonify({"error": "Task not found"}), 404

    try:
        remaining = float(data.get("remaining_seconds"))
    except (TypeError, ValueError):
        return jsonify({"error": "remaining_seconds is required"}), 400

    remaining = max(0, min(task["total_seconds"], round(remaining)))
    done = 1 if remaining <= 0 else 0
    db.execute("UPDATE tasks SET remaining_seconds = ?, done = ? WHERE id = ?", (remaining, done, task_id))
    db.commit()
    return jsonify(full_state())


@app.route("/api/tasks/reorder", methods=["POST"])
def api_reorder_tasks():
    data = request.get_json(force=True, silent=True) or {}
    order = data.get("order", [])
    if not isinstance(order, list) or not order:
        return jsonify({"error": "order must be a non-empty list of task ids"}), 400

    db = get_db()
    for idx, task_id in enumerate(order):
        try:
            tid = int(task_id)
        except (TypeError, ValueError):
            continue
        db.execute("UPDATE tasks SET order_index = ? WHERE id = ?", (idx, tid))
    db.commit()
    return jsonify(full_state())


# ---------------------------------------------------------------------------
# API: day progression ("Finish Day")
# ---------------------------------------------------------------------------
@app.route("/api/day/finish", methods=["POST"])
def api_finish_day():
    db = get_db()
    settings = db.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    current_day = settings["current_day_index"]
    next_day = current_day + 1

    unfinished = db.execute(
        "SELECT * FROM tasks WHERE day_index = ? AND done = 0 ORDER BY order_index ASC", (current_day,)
    ).fetchall()

    max_order_row = db.execute(
        "SELECT COALESCE(MAX(order_index), -1) AS m FROM tasks WHERE day_index = ?", (next_day,)
    ).fetchone()
    next_order = max_order_row["m"] + 1

    for task in unfinished:
        db.execute(
            "UPDATE tasks SET day_index = ?, order_index = ? WHERE id = ?",
            (next_day, next_order, task["id"]),
        )
        next_order += 1

    db.execute("UPDATE settings SET current_day_index = ? WHERE id = 1", (next_day,))
    db.commit()
    return jsonify(full_state())


# ---------------------------------------------------------------------------
# Health check (useful for quick manual diagnostics)
# ---------------------------------------------------------------------------
@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok"})


init_db()


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=2231)
