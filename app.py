"""
Cadence — a calm, premium time-chunk kanban calendar.

SETUP
-----
    python -m venv .venv
    source .venv/bin/activate      (Windows: .venv\\Scripts\\activate)
    pip install Flask
    python app.py

Then open http://127.0.0.1:5000 — a SQLite file `cadence.db` is created
automatically next to app.py on first run (single shared workspace, no login).

Optional env vars: CADENCE_DB (db path), HOST (default 0.0.0.0 — so the
workspace link also works from your phone), PORT (default 5000),
CADENCE_DEBUG=0 to disable the auto-reloader.

Files: app.py, templates/index.html, templates/style.css, templates/script.js
"""
import json, math, os, sqlite3, uuid
from datetime import datetime, timedelta, timezone
from flask import Flask, g, jsonify, render_template, request, send_from_directory

DB_PATH = os.environ.get("CADENCE_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "cadence.db")
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
# keep in sync with THEMES / I18N in templates/script.js
THEMES = ("midnight", "obsidian", "forest", "plum", "ember", "arctic")
LANGUAGES = ("en",)


def connect():
    """One place for connection options — every handle must use sqlite3.Row,
    otherwise row['value'] lookups blow up with a TypeError (tuple indices)."""
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")  # several devices poll at once
    return db


def get_db():
    if "db" not in g:
        g.db = connect()
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
    db = connect()
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


init_db()  # idempotent; also makes `flask run` / WSGI imports work


# ---------------------------------------------------------------- helpers
def now_iso():
    return datetime.now(timezone.utc).isoformat()


def parse_iso(s):
    """ISO timestamp -> aware datetime, or None if missing/garbage."""
    try:
        d = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def to_int(v, default, lo=None, hi=None):
    """Tolerant int coercion — a cleared number input must not 500 the API."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = default
    return clamp(n, lo, hi)


def clamp(n, lo=None, hi=None):
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def tz_offset():
    return to_int(request.headers.get("X-TZ"), 0, -1440, 1440)


def today_str(off_min):
    """Local 'today' for the caller. JS sends getTimezoneOffset() = UTC - local."""
    local = datetime.now(timezone.utc) - timedelta(minutes=off_min)
    return local.date().isoformat()


def payload():
    """JSON body or {} — never raises on a missing/blank/invalid body."""
    return request.get_json(force=True, silent=True) or {}


def get_settings(db):
    """Stored settings merged over the defaults — survives a corrupt/partial blob
    and picks up new keys without a migration."""
    try:
        raw = json.loads(meta_get(db, "settings") or "{}")
        if not isinstance(raw, dict):
            raise ValueError("settings must be an object")
    except (ValueError, TypeError):
        raw = {}
    return {**DEFAULT_SETTINGS, **{k: v for k, v in raw.items() if k in DEFAULT_SETTINGS}}


def list_of(d, key):
    """A list from the payload, or [] — a wrong shape must never 500 an endpoint."""
    v = d.get(key)
    return v if isinstance(v, list) else []


def creates_cycle(db, nid, parent_id):
    """True if making parent_id the parent of nid would close a loop."""
    seen = set()
    while parent_id is not None and parent_id not in seen:
        if parent_id == nid:
            return True
        seen.add(parent_id)
        row = db.execute("SELECT parent_id FROM nodes WHERE id=?", (parent_id,)).fetchone()
        parent_id = row["parent_id"] if row else None
    return False


def log_event(db, type_, data):
    db.execute("INSERT INTO events(at,type,payload) VALUES(?,?,?)",
               (now_iso(), type_, json.dumps(data, default=str)))


def renumber_day(db, day):
    rows = db.execute("SELECT id FROM chunks WHERE day IS ? ORDER BY order_index, id",
                       (day,)).fetchall()
    for i, r in enumerate(rows):
        db.execute("UPDATE chunks SET order_index=? WHERE id=?", (i, r["id"]))


def set_links(db, chunk_id, links):
    """links: dict {node_id(int): pct(float)} — replaces all links for a chunk."""
    db.execute("DELETE FROM chunk_nodes WHERE chunk_id=?", (chunk_id,))
    known = {}
    for k, v in (links or {}).items():
        try:
            nid, pct = int(k), float(v)
        except (TypeError, ValueError):
            continue
        if db.execute("SELECT 1 FROM nodes WHERE id=?", (nid,)).fetchone():
            known[nid] = pct  # skip unknown ids: they would trip the foreign key
    total = sum(max(0, v) for v in known.values())
    if not known:
        return
    if total <= 0:
        known = {nid: 100.0 / len(known) for nid in known}
        total = 100.0
    for nid, v in known.items():
        db.execute("INSERT INTO chunk_nodes(chunk_id,node_id,alloc_pct) VALUES(?,?,?)",
                   (chunk_id, nid, max(0, v) / total * 100.0))


def clean_day(v):
    """None (backlog) or a YYYY-MM-DD string — anything else would strand a chunk."""
    if v is None:
        return None
    try:
        return datetime.strptime(str(v)[:10], "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def equal_links(node_ids):
    ids = []
    for n in node_ids or []:
        try:
            ids.append(int(n))
        except (TypeError, ValueError):
            continue
    ids = ids[:10]
    if not ids:
        return {}
    pct = 100.0 / len(ids)
    return {n: pct for n in ids}


def tick(db):
    """Server-driven lazy tick: deduct elapsed seconds from today's chunks if mode=work."""
    mode = meta_get(db, "mode", "free")
    now_dt = datetime.now(timezone.utc)
    last_dt = parse_iso(meta_get(db, "last_tick"))
    elapsed = (now_dt - last_dt).total_seconds() if last_dt else 0.0
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
    elif last_dt is None or elapsed < 0:
        # unreadable stamp, or the clock moved backwards — resync instead of freezing
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

    settings = get_settings(db)
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
    settings = get_settings(db)
    # \u003c escaping keeps a stray "</script>" inside a setting from breaking the page
    return render_template("index.html",
                           settings_json=json.dumps(settings).replace("<", "\\u003c"))


@app.route("/style.css")
def style_css():
    # served raw (not through Jinja) so CSS braces can never be parsed as template tags
    return send_from_directory(app.template_folder, "style.css", mimetype="text/css")


@app.route("/script.js")
def script_js():
    return send_from_directory(app.template_folder, "script.js",
                               mimetype="application/javascript")


# ---------------------------------------------------------------- state
@app.route("/api/state")
def api_state():
    db = get_db()
    tick(db)
    return jsonify(build_state(db))


@app.route("/api/mode", methods=["POST"])
def api_mode():
    db = get_db()
    data = payload()
    mode = "work" if str(data.get("mode", "")).lower() == "work" else "free"
    src = "wagon" if str(data.get("src", "")).lower() == "wagon" else "local"
    tick(db)  # flush time under the previous mode first
    meta_set(db, "mode", mode)
    meta_set(db, "mode_src", src)
    log_event(db, "mode", {"mode": mode, "src": src})
    db.commit()
    return jsonify(build_state(db))


@app.route("/api/settings", methods=["PUT"])
def api_settings():
    db = get_db()
    data = payload()
    cur = get_settings(db)
    cur.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})
    for flag in ("sidebar_default_open", "show_archived", "wagon_enabled"):
        cur[flag] = bool(cur[flag])
    cur["day_range"] = to_int(cur["day_range"], DEFAULT_SETTINGS["day_range"])
    if cur["day_range"] not in (3, 7, 14):
        cur["day_range"] = DEFAULT_SETTINGS["day_range"]
    cur["zoom"] = to_int(cur["zoom"], DEFAULT_SETTINGS["zoom"], 28, 160)
    cur["wagon_poll_seconds"] = to_int(cur["wagon_poll_seconds"], 10, 3, 600)
    cur["wagon_base_url"] = str(cur["wagon_base_url"] or DEFAULT_SETTINGS["wagon_base_url"]).rstrip("/")
    cur["theme"] = cur["theme"] if cur["theme"] in THEMES else DEFAULT_SETTINGS["theme"]
    cur["density"] = cur["density"] if cur["density"] in ("cozy", "compact") else "cozy"
    cur["language"] = cur["language"] if cur["language"] in LANGUAGES else "en"
    meta_set(db, "settings", json.dumps(cur))
    db.commit()
    return jsonify({"ok": True, "settings": cur})


# ---------------------------------------------------------------- nodes
def clean_node(d):
    """Normalise the node fields we accept from the client."""
    out = {}
    if "name" in d:
        out["name"] = str(d["name"]).strip()[:120] or "Untitled"
    if "type" in d:
        out["type"] = d["type"] if d["type"] in ("category", "project", "list", "task") else "task"
    if "icon" in d:
        out["icon"] = str(d["icon"]).strip()[:40]
    if "effort" in d:
        out["effort"] = to_int(d["effort"], 5, 1, 10)
    for f in ("estimate_min", "remaining_min"):
        if f in d:
            out[f] = None if d[f] is None else to_int(d[f], 0, 0, 24 * 60 * 366)
    if "plan_mode" in d:
        out["plan_mode"] = d["plan_mode"] if d["plan_mode"] in ("count", "size") else "count"
    if "plan_value" in d:
        out["plan_value"] = to_int(d["plan_value"], 4, 1, 500)
    if "archived" in d:
        out["archived"] = 1 if d["archived"] else 0
    if "order_index" in d:
        out["order_index"] = to_int(d["order_index"], 0, 0)
    if "parent_id" in d:
        out["parent_id"] = None if d["parent_id"] is None else to_int(d["parent_id"], None)
    return out


@app.route("/api/nodes", methods=["POST"])
def create_node():
    db = get_db()
    d = clean_node(payload())
    parent_id = d.get("parent_id")
    row = db.execute("SELECT COALESCE(MAX(order_index),-1)+1 o FROM nodes WHERE parent_id IS ?",
                      (parent_id,)).fetchone()
    cur = db.execute(
        "INSERT INTO nodes(parent_id,type,name,icon,effort,estimate_min,remaining_min,"
        "plan_mode,plan_value,order_index,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (parent_id, d.get("type", "task"), d.get("name", "Untitled"), d.get("icon", ""),
         d.get("effort", 5), d.get("estimate_min"), d.get("remaining_min"),
         d.get("plan_mode"), d.get("plan_value"), row["o"], now_iso()))
    log_event(db, "node_create", d)
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})


@app.route("/api/nodes/<int:nid>", methods=["PATCH"])
def update_node(nid):
    db = get_db()
    d = clean_node(payload())
    if "parent_id" in d and creates_cycle(db, nid, d["parent_id"]):
        return jsonify({"ok": False, "error": "A node cannot be moved inside itself"}), 409
    sets, vals = [], []
    for f, v in d.items():
        sets.append(f"{f}=?")
        vals.append(v)
    if sets:
        vals.append(nid)
        db.execute(f"UPDATE nodes SET {','.join(sets)} WHERE id=?", vals)
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/nodes/reorder", methods=["POST"])
def reorder_nodes():
    db = get_db()
    d = payload()
    for u in list_of(d, "updates"):
        if not isinstance(u, dict):
            continue
        nid, parent_id = to_int(u.get("id"), 0), u.get("parent_id")
        parent_id = None if parent_id is None else to_int(parent_id, None)
        if not nid or creates_cycle(db, nid, parent_id):
            continue  # skip the move that would close a loop, keep the rest
        db.execute("UPDATE nodes SET parent_id=?, order_index=? WHERE id=?",
                   (parent_id, to_int(u.get("order_index"), 0, 0), nid))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/nodes/<int:nid>", methods=["DELETE"])
def delete_node(nid):
    db = get_db()
    linked = {r["chunk_id"] for r in db.execute("SELECT DISTINCT chunk_id FROM chunk_nodes")}
    db.execute("DELETE FROM nodes WHERE id=?", (nid,))  # cascades to children + links
    days = set()
    # drop only chunks this deletion left with no node at all — never unrelated ones
    for cid in linked:
        if db.execute("SELECT 1 FROM chunk_nodes WHERE chunk_id=?", (cid,)).fetchone():
            continue
        row = db.execute("SELECT day FROM chunks WHERE id=?", (cid,)).fetchone()
        db.execute("DELETE FROM chunks WHERE id=?", (cid,))
        if row:
            days.add(row["day"])
    for day in days:
        renumber_day(db, day)
    log_event(db, "node_delete", {"id": nid})
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/nodes/<int:nid>/generate_chunks", methods=["POST"])
def generate_chunks(nid):
    db = get_db()
    d = payload()
    node = db.execute("SELECT * FROM nodes WHERE id=?", (nid,)).fetchone()
    if not node:
        return jsonify({"ok": False, "error": "not found"}), 404
    plan_mode = d.get("plan_mode") or node["plan_mode"] or "count"
    if plan_mode not in ("count", "size"):
        plan_mode = "count"
    plan_value = to_int(d.get("plan_value") or node["plan_value"], 4, 1, 500)
    remaining = to_int(node["remaining_min"] or node["estimate_min"] or 60, 60, 1)
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
    log_event(db, "generate_chunks", {"node_id": nid, "n": len(durations)})
    db.commit()
    return jsonify({"ok": True, "created": len(durations)})


# ---------------------------------------------------------------- chunks
@app.route("/api/chunks", methods=["POST"])
def create_chunk():
    db = get_db()
    d = payload()
    day = clean_day(d.get("day"))
    duration = to_int(d.get("duration_min"), 25, 1, 24 * 60)
    node_ids = list_of(d, "node_ids")
    links = d.get("links") if isinstance(d.get("links"), dict) else None
    row = db.execute("SELECT COALESCE(MAX(order_index),-1)+1 o FROM chunks WHERE day IS ?",
                      (day,)).fetchone()
    cur = db.execute(
        "INSERT INTO chunks(duration_min,done_sec,day,order_index,created_at) VALUES(?,0,?,?,?)",
        (duration, day, row["o"], now_iso()))
    # explicit allocations win; otherwise split equally over node_ids
    set_links(db, cur.lastrowid, links or equal_links(node_ids))
    log_event(db, "chunk_create", {"duration_min": duration, "day": day, "node_ids": node_ids})
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})


@app.route("/api/chunks/<int:cid>", methods=["PATCH"])
def update_chunk(cid):
    db = get_db()
    d = payload()
    tick(db)  # bank accrued work time before we touch done_sec
    row = db.execute("SELECT * FROM chunks WHERE id=?", (cid,)).fetchone()
    if not row:
        return jsonify({"ok": False, "error": "not found"}), 404
    old_day = row["day"]
    duration = to_int(d.get("duration_min"), row["duration_min"], 1, 24 * 60)
    done_sec = row["done_sec"]
    if "complete" in d:
        done_sec = duration * 60 if d["complete"] else 0
    if "done_sec" in d:
        done_sec = to_int(d["done_sec"], done_sec)
    if "add_sec" in d:
        done_sec = row["done_sec"] + to_int(d["add_sec"], 0)
    done_sec = clamp(done_sec, 0, duration * 60)
    new_day = clean_day(d["day"]) if "day" in d else old_day
    if "order_index" in d:
        order_index = to_int(d["order_index"], row["order_index"], 0)
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
    d = payload()
    days = set()
    for u in list_of(d, "updates"):
        if not isinstance(u, dict):
            continue
        cid = to_int(u.get("id"), 0)
        if not cid:
            continue
        day = clean_day(u.get("day"))
        db.execute("UPDATE chunks SET day=?, order_index=? WHERE id=?",
                   (day, to_int(u.get("order_index"), 0, 0), cid))
        days.add(day)
    db.commit()
    for day in days:
        renumber_day(db, day)
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/chunks/<int:cid>/split", methods=["POST"])
def split_chunk(cid):
    db = get_db()
    d = payload()
    mode = "size" if d.get("mode") == "size" else "equal"
    value = to_int(d.get("value"), 25 if mode == "size" else 2, 1, 500)
    tick(db)  # spent time must be current before we split around it
    c = db.execute("SELECT * FROM chunks WHERE id=?", (cid,)).fetchone()
    if not c:
        return jsonify({"ok": False, "error": "not found"}), 404
    links = db.execute("SELECT node_id, alloc_pct FROM chunk_nodes WHERE chunk_id=?", (cid,)).fetchall()
    link_map = {l["node_id"]: l["alloc_pct"] for l in links}
    spent, total_min, day, order_index = c["done_sec"], c["duration_min"], c["day"], c["order_index"]
    kept = max(1, math.ceil(spent / 60)) if spent > 0 else 0
    remaining_min = max(0, total_min - kept)
    if mode == "size":
        size = value
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
    db.execute("UPDATE chunks SET order_index=order_index+? WHERE day IS ? AND order_index>?",
               (len(durations), day, order_index))  # make room: parts stay next to the original
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
    d = payload()
    tick(db)
    ids = list_of(d, "ids")
    action = d.get("action")
    target = d.get("target") or None
    if target == "today":
        target_day = today_str(tz_offset())
    else:
        target_day = None if target in (None, "backlog") else clean_day(target)
    affected_days = set()
    for cid in ids:
        c = db.execute("SELECT * FROM chunks WHERE id=?", (to_int(cid, 0),)).fetchone()
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
    log_event(db, "rollover", {"ids": ids, "action": action, "target": target})
    db.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = to_int(os.environ.get("PORT"), 5000, 1, 65535)
    print(f"Cadence is ready  ->  http://127.0.0.1:{port}   (db: {DB_PATH})")
    app.run(host=host, port=port, debug=os.environ.get("CADENCE_DEBUG", "1") == "1")
