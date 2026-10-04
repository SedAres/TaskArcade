"""
Cadence — a calm, premium time-chunk kanban calendar.

SETUP
-----
    python -m venv .venv
    source .venv/bin/activate      (Windows: .venv\\Scripts\\activate)
    pip install Flask
    python app.py

Then open http://127.0.0.1:5000 — a SQLite file `cadence.db` is created
automatically on first run (single shared workspace, no login).

Files: app.py, templates/index.html, templates/style.css, templates/script.js
"""
import json, math, sqlite3, uuid
from datetime import datetime, timedelta, timezone
from flask import Flask, g, render_template, request, jsonify

DB_PATH = "cadence.db"
app = Flask(__name__)

# ---------------------------------------------------------------- database
SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'task',
  name TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  effort INTEGER NOT NULL DEFAULT 5,
  estimate_min INTEGER,
  remaining_min INTEGER,
  plan_mode TEXT,
  plan_value INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duration_min INTEGER NOT NULL DEFAULT 25,
  done_sec INTEGER NOT NULL DEFAULT 0,
  day TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunk_nodes(
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  alloc_pct REAL NOT NULL DEFAULT 100,
  PRIMARY KEY (chunk_id, node_id)
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, type TEXT, payload TEXT
);
"""

DEFAULT_SETTINGS = {
    "theme": "midnight", "density": "cozy", "day_range": 7, "zoom": 64,
    "sidebar_default_open": True, "show_archived": False,
    "wagon_enabled": False, "wagon_base_url": "http://127.0.0.1:8787",
    "wagon_poll_seconds": 10, "language": "en",
}


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(_e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def meta_get(db, key, default=None):
    r = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def meta_set(db, key, value):
    db.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value)
    )


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    if meta_get(db, "settings") is None:
        meta_set(db, "settings", json.dumps(DEFAULT_SETTINGS))
    if meta_get(db, "mode") is None:
        meta_set(db, "mode", "free")
    if meta_get(db, "mode_src") is None:
        meta_set(db, "mode_src", "local")
    if meta_get(db, "last_tick") is None:
        meta_set(db, "last_tick", datetime.now(timezone.utc).isoformat())
    if meta_get(db, "workspace_id") is None:
        meta_set(db, "workspace_id", uuid.uuid4().hex[:8])
    db.commit()
    db.close()


# ---------------------------------------------------------------- helpers
def now_iso():
    return datetime.now(timezone.utc).isoformat()


def tz_offset():
    try:
        return int(request.headers.get("X-TZ", "0"))
    except (TypeError, ValueError):
        return 0


def today_str(off_min):
    local = datetime.now(timezone.utc) - timedelta(minutes=off_min)
    return local.date().isoformat()


def log_event(db, type_, payload):
    db.execute("INSERT INTO events(at,type,payload) VALUES(?,?,?)",
               (now_iso(), type_, json.dumps(payload)))


def renumber_day(db, day):
    rows = db.execute("SELECT id FROM chunks WHERE day IS ? ORDER BY order_index, id",
                       (day,)).fetchall()
    for i, r in enumerate(rows):
        db.execute("UPDATE chunks SET order_index=? WHERE id=?", (i, r["id"]))


def set_links(db, chunk_id, links):
    """links: dict {node_id(int): pct(float)} — replaces all links for a chunk."""
    db.execute("DELETE FROM chunk_nodes WHERE chunk_id=?", (chunk_id,))
    links = {int(k): float(v) for k, v in links.items() if v is not None}
    total = sum(max(0, v) for v in links.values())
    if not links:
        return
    if total <= 0:
        pct = 100.0 / len(links)
        for nid in links:
            db.execute("INSERT INTO chunk_nodes(chunk_id,node_id,alloc_pct) VALUES(?,?,?)",
                       (chunk_id, nid, pct))
    else:
        for nid, v in links.items():
            db.execute("INSERT INTO chunk_nodes(chunk_id,node_id,alloc_pct) VALUES(?,?,?)",
                       (chunk_id, nid, max(0, v) / total * 100.0))


def equal_links(node_ids):
    node_ids = [int(n) for n in node_ids][:10]
    if not node_ids:
        return {}
    pct = 100.0 / len(node_ids)
    return {n: pct for n in node_ids}


def tick(db):
    """Server-driven lazy tick: deduct elapsed seconds from today's chunks if mode=work."""
    mode = meta_get(db, "mode", "free")
    last = meta_get(db, "last_tick")
    try:
        last_dt = datetime.fromisoformat(last)
    except Exception:
        last_dt = datetime.now(timezone.utc)
    now_dt = datetime.now(timezone.utc)
    elapsed = (now_dt - last_dt).total_seconds()
    if elapsed > 0:
        if mode == "work":
            elapsed = min(elapsed, 6 * 3600)  # safety cap (sleep/awake gaps)
            today = today_str(tz_offset())
            rows = db.execute(
                "SELECT * FROM chunks WHERE day=? ORDER BY order_index, id", (today,)
            ).fetchall()
            remain = elapsed
            for r in rows:
                if remain <= 0:
                    break
                cap = r["duration_min"] * 60 - r["done_sec"]
                if cap <= 0:
                    continue
                take = min(remain, cap)
                db.execute("UPDATE chunks SET done_sec=done_sec+? WHERE id=?",
                           (int(round(take)), r["id"]))
                remain -= take
        meta_set(db, "last_tick", now_dt.isoformat())
        db.commit()


def node_dict(r, progress):
    d = dict(r)
    d["progress_min"] = round(progress.get(r["id"], 0.0), 1)
    return d


def chunk_dict(db, r):
    links = db.execute(
        "SELECT node_id, alloc_pct FROM chunk_nodes WHERE chunk_id=? ORDER BY node_id",
        (r["id"],)).fetchall()
    d = dict(r)
    d["links"] = [{"node_id": l["node_id"], "pct": round(l["alloc_pct"], 2)} for l in links]
    return d


def build_state(db):
    off = tz_offset()
    progress = {}
    for row in db.execute(
        "SELECT cn.node_id nid, SUM(c.done_sec*cn.alloc_pct/100.0) s "
        "FROM chunk_nodes cn JOIN chunks c ON c.id=cn.chunk_id GROUP BY cn.node_id"
    ):
        progress[row["nid"]] = (row["s"] or 0) / 60.0

    nodes = [node_dict(r, progress) for r in
              db.execute("SELECT * FROM nodes ORDER BY order_index, id").fetchall()]
    chunks = [chunk_dict(db, r) for r in
               db.execute("SELECT * FROM chunks ORDER BY day, order_index, id").fetchall()]

    today = today_str(off)
    missed_rows = db.execute(
        "SELECT * FROM chunks WHERE day IS NOT NULL AND day<? AND done_sec<duration_min*60 "
        "ORDER BY day, order_index", (today,)).fetchall()
    missed = []
    for r in missed_rows:
        cd = chunk_dict(db, r)
        names = []
        for l in cd["links"]:
            nrow = db.execute("SELECT name, icon FROM nodes WHERE id=?", (l["node_id"],)).fetchone()
            if nrow:
                names.append({"name": nrow["name"], "icon": nrow["icon"]})
        cd["node_names"] = names
        missed.append(cd)

    settings = json.loads(meta_get(db, "settings", json.dumps(DEFAULT_SETTINGS)))
    return {
        "nodes": nodes, "chunks": chunks, "settings": settings,
        "mode": meta_get(db, "mode", "free"), "mode_src": meta_get(db, "mode_src", "local"),
        "today": today, "workspace_id": meta_get(db, "workspace_id"),
        "missed": missed, "server_time": now_iso(),
    }


# ---------------------------------------------------------------- pages
@app.route("/")
def index():
    db = get_db()
    settings = json.loads(meta_get(db, "settings", json.dumps(DEFAULT_SETTINGS)))
    return render_template("index.html", settings_json=json.dumps(settings))


@app.route("/style.css")
def style_css():
    return app.response_class(render_template("style.css"), mimetype="text/css")


@app.route("/script.js")
def script_js():
    return app.response_class(render_template("script.js"), mimetype="application/javascript")


# ---------------------------------------------------------------- state
@app.route("/api/state")
def api_state():
    db = get_db()
    tick(db)
    return jsonify(build_state(db))


@app.route("/api/mode", methods=["POST"])
def api_mode():
    db = get_db()
    data = request.get_json(force=True) or {}
    tick(db)  # flush time under the previous mode first
    meta_set(db, "mode", data.get("mode", "free"))
    meta_set(db, "mode_src", data.get("src", "local"))
    db.commit()
    log_event(db, "mode", data)
    db.commit()
    return jsonify(build_state(db))


@app.route("/api/settings", methods=["PUT"])
def api_settings():
    db = get_db()
    data = request.get_json(force=True) or {}
    cur = json.loads(meta_get(db, "settings", json.dumps(DEFAULT_SETTINGS)))
    cur.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})
    meta_set(db, "settings", json.dumps(cur))
    db.commit()
    return jsonify({"ok": True, "settings": cur})


# ---------------------------------------------------------------- nodes
@app.route("/api/nodes", methods=["POST"])
def create_node():
    db = get_db()
    d = request.get_json(force=True) or {}
    parent_id = d.get("parent_id")
    row = db.execute("SELECT COALESCE(MAX(order_index),-1)+1 o FROM nodes WHERE parent_id IS ?",
                      (parent_id,)).fetchone()
    cur = db.execute(
        "INSERT INTO nodes(parent_id,type,name,icon,effort,estimate_min,remaining_min,"
        "plan_mode,plan_value,order_index,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (parent_id, d.get("type", "task"), d.get("name", "Untitled"), d.get("icon", ""),
         int(d.get("effort", 5)), d.get("estimate_min"), d.get("remaining_min"),
         d.get("plan_mode"), d.get("plan_value"), row["o"], now_iso()))
    db.commit()
    log_event(db, "node_create", d)
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})


@app.route("/api/nodes/<int:nid>", methods=["PATCH"])
def update_node(nid):
    db = get_db()
    d = request.get_json(force=True) or {}
    fields = ["parent_id", "type", "name", "icon", "effort", "estimate_min", "remaining_min",
              "plan_mode", "plan_value", "archived", "order_index"]
    sets, vals = [], []
    for f in fields:
        if f in d:
            sets.append(f"{f}=?")
            vals.append(d[f])
    if sets:
        vals.append(nid)
        db.execute(f"UPDATE nodes SET {','.join(sets)} WHERE id=?", vals)
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/nodes/reorder", methods=["POST"])
def reorder_nodes():
    db = get_db()
    d = request.get_json(force=True) or {}
    for u in d.get("updates", []):
        db.execute("UPDATE nodes SET parent_id=?, order_index=? WHERE id=?",
                   (u.get("parent_id"), u.get("order_index", 0), u["id"]))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/nodes/<int:nid>", methods=["DELETE"])
def delete_node(nid):
    db = get_db()
    db.execute("DELETE FROM nodes WHERE id=?", (nid,))
    db.execute("DELETE FROM chunks WHERE id NOT IN (SELECT chunk_id FROM chunk_nodes)")
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/nodes/<int:nid>/generate_chunks", methods=["POST"])
def generate_chunks(nid):
    db = get_db()
    d = request.get_json(force=True) or {}
    node = db.execute("SELECT * FROM nodes WHERE id=?", (nid,)).fetchone()
    if not node:
        return jsonify({"ok": False, "error": "not found"}), 404
    plan_mode = d.get("plan_mode", node["plan_mode"] or "count")
    plan_value = int(d.get("plan_value", node["plan_value"] or 4) or 1)
    remaining = node["remaining_min"] or node["estimate_min"] or 60
    remaining = max(1, int(remaining))
    if plan_mode == "size":
        size = max(1, plan_value)
        n = max(1, math.ceil(remaining / size))
        durations = [size] * (n - 1) + [remaining - size * (n - 1)]
    else:
        n = max(1, plan_value)
        base, rem = divmod(remaining, n)
        durations = [base + (1 if i < rem else 0) for i in range(n)]
    durations = [x for x in durations if x > 0]
    row = db.execute("SELECT COALESCE(MAX(order_index),-1)+1 o FROM chunks WHERE day IS NULL").fetchone()
    nextidx = row["o"]
    for dur in durations:
        cur = db.execute(
            "INSERT INTO chunks(duration_min,done_sec,day,order_index,created_at) VALUES(?,0,NULL,?,?)",
            (dur, nextidx, now_iso()))
        nextidx += 1
        set_links(db, cur.lastrowid, {nid: 100})
    db.execute("UPDATE nodes SET plan_mode=?, plan_value=? WHERE id=?", (plan_mode, plan_value, nid))
    db.commit()
    log_event(db, "generate_chunks", {"node_id": nid, "n": len(durations)})
    db.commit()
    return jsonify({"ok": True, "created": len(durations)})


# ---------------------------------------------------------------- chunks
@app.route("/api/chunks", methods=["POST"])
def create_chunk():
    db = get_db()
    d = request.get_json(force=True) or {}
    day = d.get("day")
    duration = int(d.get("duration_min", 25))
    node_ids = d.get("node_ids", [])
    row = db.execute("SELECT COALESCE(MAX(order_index),-1)+1 o FROM chunks WHERE day IS ?",
                      (day,)).fetchone()
    cur = db.execute(
        "INSERT INTO chunks(duration_min,done_sec,day,order_index,created_at) VALUES(?,0,?,?,?)",
        (duration, day, row["o"], now_iso()))
    set_links(db, cur.lastrowid, equal_links(node_ids))
    db.commit()
    log_event(db, "chunk_create", d)
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})


@app.route("/api/chunks/<int:cid>", methods=["PATCH"])
def update_chunk(cid):
    db = get_db()
    d = request.get_json(force=True) or {}
    row = db.execute("SELECT * FROM chunks WHERE id=?", (cid,)).fetchone()
    if not row:
        return jsonify({"ok": False, "error": "not found"}), 404
    old_day = row["day"]
    duration = int(d.get("duration_min", row["duration_min"]))
    done_sec = row["done_sec"]
    if "complete" in d:
        done_sec = duration * 60 if d["complete"] else 0
    if "done_sec" in d:
        done_sec = int(d["done_sec"])
    if "add_sec" in d:
        done_sec = row["done_sec"] + int(d["add_sec"])
    done_sec = max(0, min(duration * 60, done_sec))
    new_day = d["day"] if "day" in d else old_day
    if "order_index" in d:
        order_index = d["order_index"]
    elif new_day != old_day:
        r2 = db.execute("SELECT COALESCE(MAX(order_index),-1)+1 o FROM chunks WHERE day IS ?",
                         (new_day,)).fetchone()
        order_index = r2["o"]
    else:
        order_index = row["order_index"]
    db.execute("UPDATE chunks SET duration_min=?, done_sec=?, day=?, order_index=? WHERE id=?",
               (duration, done_sec, new_day, order_index, cid))
    if "links" in d:
        set_links(db, cid, d["links"])
    db.commit()
    if new_day != old_day:
        renumber_day(db, old_day)
        renumber_day(db, new_day)
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/chunks/<int:cid>", methods=["DELETE"])
def delete_chunk(cid):
    db = get_db()
    row = db.execute("SELECT day FROM chunks WHERE id=?", (cid,)).fetchone()
    db.execute("DELETE FROM chunks WHERE id=?", (cid,))
    if row:
        renumber_day(db, row["day"])
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/chunks/reorder", methods=["POST"])
def reorder_chunks():
    db = get_db()
    d = request.get_json(force=True) or {}
    days = set()
    for u in d.get("updates", []):
        db.execute("UPDATE chunks SET day=?, order_index=? WHERE id=?",
                   (u.get("day"), u.get("order_index", 0), u["id"]))
        days.add(u.get("day"))
    db.commit()
    for day in days:
        renumber_day(db, day)
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/chunks/<int:cid>/split", methods=["POST"])
def split_chunk(cid):
    db = get_db()
    d = request.get_json(force=True) or {}
    mode, value = d.get("mode", "equal"), int(d.get("value", 2))
    c = db.execute("SELECT * FROM chunks WHERE id=?", (cid,)).fetchone()
    if not c:
        return jsonify({"ok": False, "error": "not found"}), 404
    links = db.execute("SELECT node_id, alloc_pct FROM chunk_nodes WHERE chunk_id=?", (cid,)).fetchall()
    link_map = {l["node_id"]: l["alloc_pct"] for l in links}
    spent, total_min, day, order_index = c["done_sec"], c["duration_min"], c["day"], c["order_index"]
    kept = max(1, math.ceil(spent / 60)) if spent > 0 else 0
    remaining_min = max(0, total_min - kept)
    if mode == "size":
        size = max(1, value)
        n = math.ceil(remaining_min / size) if remaining_min > 0 else 0
        durations = [size] * (n - 1) + [remaining_min - size * (n - 1)] if n > 0 else []
    else:
        n = max(1, value)
        base, rem = divmod(remaining_min, n)
        durations = [base + (1 if i < rem else 0) for i in range(n)]
    durations = [x for x in durations if x > 0]
    if kept > 0:
        db.execute("UPDATE chunks SET duration_min=?, done_sec=? WHERE id=?", (kept, spent, cid))
    else:
        db.execute("DELETE FROM chunks WHERE id=?", (cid,))
    for i, dur in enumerate(durations):
        cur = db.execute(
            "INSERT INTO chunks(duration_min,done_sec,day,order_index,created_at) VALUES(?,0,?,?,?)",
            (dur, day, order_index + i + 1, now_iso()))
        if link_map:
            set_links(db, cur.lastrowid, link_map)
    db.commit()
    renumber_day(db, day)
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- rollover
@app.route("/api/rollover", methods=["POST"])
def rollover():
    db = get_db()
    d = request.get_json(force=True) or {}
    ids = d.get("ids", [])
    action = d.get("action")
    target_day = d.get("target") or None
    if target_day == "today":
        target_day = today_str(tz_offset())
    elif target_day == "backlog":
        target_day = None
    affected_days = set()
    for cid in ids:
        c = db.execute("SELECT * FROM chunks WHERE id=?", (cid,)).fetchone()
        if not c:
            continue
        affected_days.add(c["day"])
        if action == "move_today":
            new_day = today_str(tz_offset())
            db.execute("UPDATE chunks SET day=? WHERE id=?", (new_day, cid))
            affected_days.add(new_day)
        elif action == "not_done":
            db.execute("UPDATE chunks SET day=NULL WHERE id=?", (cid,))
            affected_days.add(None)
        elif action == "done":
            db.execute("UPDATE chunks SET done_sec=duration_min*60 WHERE id=?", (cid,))
        elif action == "keep_split":
            spent = c["done_sec"]
            remaining_sec = c["duration_min"] * 60 - spent
            if remaining_sec <= 0:
                db.execute("UPDATE chunks SET done_sec=duration_min*60 WHERE id=?", (cid,))
                continue
            kept_min = max(1, math.ceil(spent / 60)) if spent > 0 else 0
            new_min = max(1, math.ceil(remaining_sec / 60))
            dest = target_day if target_day is not None else None
            if kept_min > 0:
                db.execute("UPDATE chunks SET duration_min=?, done_sec=? WHERE id=?",
                           (kept_min, spent, cid))
                links = db.execute("SELECT node_id, alloc_pct FROM chunk_nodes WHERE chunk_id=?",
                                    (cid,)).fetchall()
                link_map = {l["node_id"]: l["alloc_pct"] for l in links}
                row = db.execute("SELECT COALESCE(MAX(order_index),-1)+1 o FROM chunks WHERE day IS ?",
                                  (dest,)).fetchone()
                cur = db.execute(
                    "INSERT INTO chunks(duration_min,done_sec,day,order_index,created_at) VALUES(?,0,?,?,?)",
                    (new_min, dest, row["o"], now_iso()))
                if link_map:
                    set_links(db, cur.lastrowid, link_map)
            else:
                db.execute("UPDATE chunks SET day=? WHERE id=?", (dest, cid))
            affected_days.add(dest)
    db.commit()
    for day in affected_days:
        renumber_day(db, day)
    db.commit()
    log_event(db, "rollover", d)
    db.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    app.run(debug=True)
