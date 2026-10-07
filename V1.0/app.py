"""
TaskArcade V1.0 — Flask application.

A self-contained time-planning arcade: virtual days, duration-proportional
timelines, a focus timer engine, insights and five complete interface themes.

Run:
    python app.py            # http://0.0.0.0:2231

The backend is intentionally dependency-light (Flask + stdlib + SQLite) and
serves the SPA from templates/index.html with static assets from static/.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Callable

from flask import Flask, Response, jsonify, render_template, request, send_from_directory
from werkzeug.exceptions import HTTPException

from core import db as database
from core import history as history_service
from core import services as svc
from core import stats as stats_service
from core import routines as routine_service
from core import projects as project_service
from core.config import APP_NAME, APP_TAGLINE, APP_VERSION, BASE_DIR, PALETTE, SHORTCUTS, THEMES, DESIGNS

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["JSON_SORT_KEYS"] = False
app.teardown_appcontext(database.close_db)

API_START = time.time()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def payload() -> dict[str, Any]:
    data = request.get_json(silent=True, force=True)
    return data if isinstance(data, dict) else {}


def body() -> dict[str, Any]:
    return payload()


def _bool_arg(name: str, default: bool = False) -> bool:
    raw = request.args.get(name)
    if raw is None:
        return default
    return str(raw).lower() in ("1", "true", "yes", "on")


def _int_arg(name: str, default: int = 0) -> int:
    try:
        return int(request.args.get(name, default))
    except (TypeError, ValueError):
        return default


def state_response(extra: dict[str, Any] | None = None, status: int = 200) -> Response:
    conn = database.get_db()
    data = svc.full_state(conn)
    if extra:
        data.update(extra)
    return jsonify(data), status


def guard(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a mutation: commit on success, surface domain errors as JSON."""

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        conn = database.get_db()
        try:
            result = fn(*args, **kwargs)
        except KeyError as exc:
            conn.rollback()
            return jsonify({"error": str(exc) or "Not found"}), 404
        except ValueError as exc:
            conn.rollback()
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:  # pragma: no cover - defensive
            conn.rollback()
            app.logger.exception("Unhandled error")
            return jsonify({"error": "Internal error", "detail": str(exc)}), 500
        conn.commit()
        if isinstance(result, tuple):
            return result
        if isinstance(result, Response):
            return result
        if isinstance(result, dict) and result.pop("__empty__", False):
            return ("", 204)
        return jsonify(result)

    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


def with_state(fn: Callable[..., dict[str, Any]]) -> Callable[..., Any]:
    """Like guard() but always answers with the full application state."""

    def inner(*args: Any, **kwargs: Any) -> Any:
        conn = database.get_db()
        result = fn(*args, **kwargs)
        conn.commit()
        data = svc.full_state(conn)
        if isinstance(result, dict):
            data.update(result)
        return jsonify(data)

    return inner


@app.errorhandler(HTTPException)
def handle_http_error(error: HTTPException):
    if request.path.startswith("/api/"):
        return jsonify({"error": error.description, "status": error.code}), error.code
    return error


@app.errorhandler(Exception)
def handle_error(error: Exception):  # pragma: no cover - defensive
    if isinstance(error, HTTPException):
        return handle_http_error(error)
    app.logger.exception("Unhandled error")
    return jsonify({"error": "Internal error", "detail": str(error)}), 500


# ---------------------------------------------------------------------------
# Pages & assets
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    legacy = database.legacy_summary()
    return render_template(
        "index.html",
        app_name=APP_NAME,
        app_tagline=APP_TAGLINE,
        app_version=APP_VERSION,
        themes=THEMES,
        designs=DESIGNS,
        palette=PALETTE,
        shortcuts=SHORTCUTS,
        legacy=legacy,
    )


@app.route("/favicon.svg")
def favicon():
    return send_from_directory(os.path.join(BASE_DIR, "static", "img"), "favicon.svg", mimetype="image/svg+xml")


@app.route("/manifest.webmanifest")
def manifest():
    manifest_data = {
        "name": APP_NAME,
        "short_name": APP_NAME,
        "description": APP_TAGLINE,
        "start_url": "/",
        "display": "standalone",
        "background_color": "#f4f6fb",
        "theme_color": "#4f46e5",
        "icons": [
            {"src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable"}
        ],
    }
    return Response(json.dumps(manifest_data), mimetype="application/manifest+json")


@app.route("/sw.js")
def service_worker():
    script = """
const CACHE = 'taskarcade-v3';
const ASSETS = [
  '/', '/static/css/fonts.css', '/static/css/base.css',
  '/static/css/components.css', '/static/css/themes.css',
  '/static/css/responsive.css', '/static/css/rtl.css',
  '/static/css/history-calendar.css', '/static/css/polish.css',
  '/static/fonts/Vazirmatn-VF.woff2',
  '/static/fonts/Estedad-VF.woff2',
  '/static/fonts/NotoNaskhArabic-VF.ttf',
  '/static/fonts/Sahel-Light.woff2',
  '/static/fonts/Sahel-Regular.woff2',
  '/static/fonts/Sahel-SemiBold.woff2',
  '/static/fonts/Sahel-Bold.woff2',
  '/static/fonts/Sahel-Black.woff2',
  '/favicon.svg', '/manifest.webmanifest',
  '/static/js/api.js', '/static/js/app.js', '/static/js/calendar-utils.js',
  '/static/js/core.js', '/static/js/dnd.js', '/static/js/focus.js',
  '/static/js/gestures.js', '/static/js/history-calendar.js', '/static/js/i18n.js',
  '/static/js/insights.js', '/static/js/library.js', '/static/js/now.js',
  '/static/js/palette.js', '/static/js/projects-ui.js', '/static/js/quickadd.js',
  '/static/js/refreshbus.js', '/static/js/routines-ui.js', '/static/js/settings.js',
  '/static/js/tasks.js', '/static/js/theme.js', '/static/js/ui.js'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => null));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => null);
      }
      return response;
    }).catch(() => cached))
  );
});
"""
    return Response(script, mimetype="application/javascript")


@app.route("/api/health")
def api_health():
    conn = database.get_db()
    counts = {
        table: conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
        for table in ["tasks", "projects", "tags", "tag_aliases", "subtasks", "events", "sessions", "templates", "routines", "routine_runs"]
    }
    return jsonify(
        {
            "status": "ok",
            "app": APP_NAME,
            "version": APP_VERSION,
            "uptime_seconds": round(time.time() - API_START, 1),
            "counts": counts,
            "time": svc.now_iso(),
        }
    )


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
@app.route("/api/state")
def api_state():
    return state_response()


@app.route("/api/bootstrap")
def api_bootstrap():
    """Smaller payload used for fast first paint (no meta block)."""
    conn = database.get_db()
    return jsonify(svc.full_state(conn, include_meta=True))


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
@app.route("/api/settings", methods=["GET", "POST", "PATCH"])
@guard
def api_settings():
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"settings": svc.get_settings(conn)})
    data = payload()
    if "reset" in data and data["reset"]:
        from core.config import DEFAULT_SETTINGS

        return {
            "__empty__": False,
            "settings": svc.update_settings(conn, dict(DEFAULT_SETTINGS)),
            "reset": True,
        }
    settings = svc.update_settings(conn, data)
    return {"settings": settings, "ok": True}


@app.route("/api/palette")
def api_palette():
    return jsonify({"palette": PALETTE, "themes": THEMES, "shortcuts": SHORTCUTS})


# ---------------------------------------------------------------------------
# Tags & aliases
# ---------------------------------------------------------------------------
@app.route("/api/tags", methods=["GET", "POST"])
@guard
def api_tags():
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"tags": svc.list_tags(conn, include_archived=_bool_arg("archived"))})
    result = svc.upsert_tag(conn, payload())
    return {"tag": result, "tags": svc.list_tags(conn), "aliases": svc.alias_map(conn)}


@app.route("/api/tags/<tag_name>", methods=["GET", "PATCH", "DELETE"])
@guard
def api_tag(tag_name: str):
    conn = database.get_db()
    if request.method == "GET":
        row = conn.execute("SELECT * FROM tags WHERE tag_name = ?", (tag_name.lower(),)).fetchone()
        if row is None:
            raise KeyError("Tag not found")
        aliases = [r["alias"] for r in conn.execute(
            "SELECT alias FROM tag_aliases WHERE tag_name = ?", (tag_name.lower(),)
        ).fetchall()]
        return jsonify({"tag": svc.serialize_tag(row, aliases)})
    if request.method == "DELETE":
        return {"result": svc.delete_tag(conn, tag_name), "tags": svc.list_tags(conn)}
    data = payload()
    data["name"] = tag_name
    svc.upsert_tag(conn, data)
    return {"tags": svc.list_tags(conn), "aliases": svc.alias_map(conn)}


@app.route("/api/tags/merge", methods=["POST"])
@guard
def api_tag_merge():
    conn = database.get_db()
    data = payload()
    return {
        "result": svc.merge_tags(conn, data.get("source", ""), data.get("target", "")),
        "tags": svc.list_tags(conn),
    }


@app.route("/api/tags/reorder", methods=["POST"])
@guard
def api_tag_reorder():
    conn = database.get_db()
    svc.reorder_tags(conn, payload().get("order", []))
    return {"tags": svc.list_tags(conn)}


@app.route("/api/aliases", methods=["GET", "POST"])
@guard
def api_aliases():
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"aliases": svc.alias_map(conn), "tags": svc.list_tags(conn)})
    data = payload()
    result = svc.add_alias(conn, data.get("alias", ""), data.get("tag", ""))
    return {"result": result, "aliases": svc.alias_map(conn), "tags": svc.list_tags(conn)}


@app.route("/api/aliases/<alias>", methods=["DELETE"])
@guard
def api_alias_delete(alias: str):
    conn = database.get_db()
    svc.delete_alias(conn, alias)
    return {"aliases": svc.alias_map(conn), "tags": svc.list_tags(conn)}


@app.route("/api/aliases/bulk", methods=["POST"])
@guard
def api_alias_bulk():
    conn = database.get_db()
    data = payload()
    tag = data.get("tag", "")
    aliases = svc.set_aliases(conn, svc.ensure_tag(conn, tag), data.get("aliases", []))
    return {"aliases": aliases, "map": svc.alias_map(conn), "tags": svc.list_tags(conn)}


# ---------------------------------------------------------------------------
# Task parsing (live quick-add preview)
# ---------------------------------------------------------------------------
@app.route("/api/parse", methods=["POST"])
def api_parse():
    conn = database.get_db()
    ctx = svc.parse_context(conn)
    data = payload()
    text = str(data.get("text", ""))
    if data.get("bulk") or "\n" in text:
        good, bad = svc_parse_bulk(text, ctx)
        return jsonify(
            {
                "tasks": [
                    {
                        "title": item["title"],
                        "tag": item["tag"],
                        "tag_token": item["tag_token"],
                        "tag_alias": item["tag_alias"],
                        "seconds": item["seconds"],
                        "priority": item["priority"],
                        "scheduled_at": item["scheduled_at"],
                        "recurrence": item["recurrence"],
                        "recurrence_text": svc.describe_rule(item["recurrence"]),
                        "subtasks": item["subtasks"],
                        "notes": item["notes"],
                        "chips": svc.describe_chips(item),
                    }
                    for item in good
                ],
                "bad_lines": bad,
                "count": len(good),
            }
        )
    from core.parser import describe_parse, parse_line

    parsed = parse_line(text, ctx)
    return jsonify(
        {
            "parsed": parsed,
            "chips": describe_parse(parsed),
            "ok": parsed["ok"],
            "alias_map": list(ctx.aliases.items())[:200],
        }
    )


def svc_parse_bulk(text: str, ctx):
    from core.parser import parse_bulk

    return parse_bulk(text, ctx)


def svc_describe_rule(rule):
    from core.parser import humanize_rule

    return humanize_rule(rule)


def svc_describe_chips(parsed):
    from core.parser import describe_parse

    return describe_parse(parsed)


svc.describe_rule = svc_describe_rule
svc.describe_chips = svc_describe_chips



# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------
@app.route("/api/projects", methods=["GET", "POST"])
@guard
def api_projects():
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"projects": project_service.list_projects(conn)})
    project = project_service.create_project(conn, payload())
    return {"project": project, "projects": project_service.list_projects(conn)}


@app.route("/api/projects/<int:project_id>", methods=["GET", "PATCH", "DELETE"])
@guard
def api_project(project_id: int):
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"project": project_service.get_project(conn, project_id)})
    if request.method == "DELETE":
        result = project_service.delete_project(conn, project_id)
        return {"result": result, "projects": project_service.list_projects(conn)}
    project = project_service.update_project(conn, project_id, payload())
    return {"project": project, "projects": project_service.list_projects(conn)}


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------
@app.route("/api/tasks", methods=["GET", "POST"])
@guard
def api_tasks():
    conn = database.get_db()
    if request.method == "GET":
        day = _int_arg("day", 0)
        rows = conn.execute(
            "SELECT * FROM tasks WHERE archived = 0" + (" AND day_index = ?" if day else "") +
            " ORDER BY day_index ASC, done ASC, order_index ASC",
            ((day,) if day else ()),
        ).fetchall()
        return jsonify({"tasks": [svc.serialize_task(r, svc.subtasks_for(conn, r["id"])) for r in rows]})
    result = svc.create_task(conn, payload())
    return {"created": result, "tasks": [svc.serialize_task(r) for r in conn.execute("SELECT * FROM tasks").fetchall()]}


@app.route("/api/tasks/bulk", methods=["POST"])
@guard
def api_tasks_bulk():
    conn = database.get_db()
    data = payload()
    result = svc.bulk_create(conn, str(data.get("text", "")), data.get("day_index"))
    if result.get("error"):
        return {"result": result, "error": result["error"]}, 200
    return {"result": result}


@app.route("/api/tasks/<int:task_id>", methods=["GET", "PATCH", "DELETE"])
@guard
def api_task(task_id: int):
    conn = database.get_db()
    if request.method == "GET":
        row = svc.task_row(conn, task_id)
        if row is None:
            raise KeyError("Task not found")
        return jsonify({"task": svc.serialize_task(row, svc.subtasks_for(conn, task_id))})
    if request.method == "DELETE":
        return {"result": svc.delete_task(conn, task_id)}
    result = svc.update_task(conn, task_id, payload())
    return {"result": result}


@app.route("/api/tasks/<int:task_id>/done", methods=["POST", "DELETE"])
@guard
def api_task_done(task_id: int):
    conn = database.get_db()
    done = request.method == "POST"
    data = payload()
    if "done" in data:
        done = bool(data["done"])
    return {"result": svc.complete_task(conn, task_id, done)}


@app.route("/api/tasks/<int:task_id>/skip", methods=["POST"])
@guard
def api_task_skip(task_id: int):
    conn = database.get_db()
    return {"result": svc.skip_task(conn, task_id, to_end=bool(payload().get("to_end", True)))}


@app.route("/api/tasks/<int:task_id>/tick", methods=["POST"])
@guard
def api_task_tick(task_id: int):
    conn = database.get_db()
    data = payload()
    result = svc.tick_task(conn, task_id, data.get("remaining_seconds", 0), data.get("seconds_spent", 0))
    return {"result": result}


@app.route("/api/tasks/<int:task_id>/duplicate", methods=["POST"])
@guard
def api_task_duplicate(task_id: int):
    conn = database.get_db()
    return {"result": svc.duplicate_task(conn, task_id)}


@app.route("/api/tasks/<int:task_id>/split", methods=["POST"])
@guard
def api_task_split(task_id: int):
    conn = database.get_db()
    data = payload()
    return {"result": svc.split_task(conn, task_id, data.get("pieces", 2), data.get("titles"))}


@app.route("/api/tasks/<int:task_id>/pin", methods=["POST"])
@guard
def api_task_pin(task_id: int):
    conn = database.get_db()
    return {"result": svc.toggle_pinned(conn, task_id)}


@app.route("/api/tasks/<int:task_id>/move", methods=["POST"])
@guard
def api_task_move(task_id: int):
    conn = database.get_db()
    data = payload()
    return {"result": svc.move_task(conn, task_id, data.get("day_index", 1), data.get("order_index"))}


@app.route("/api/tasks/<int:task_id>/subtasks", methods=["POST"])
@guard
def api_subtask_add(task_id: int):
    conn = database.get_db()
    return {"result": svc.add_subtask(conn, task_id, payload().get("title", ""))}


@app.route("/api/subtasks/<int:subtask_id>", methods=["PATCH", "DELETE"])
@guard
def api_subtask(subtask_id: int):
    conn = database.get_db()
    if request.method == "DELETE":
        return {"result": svc.delete_subtask(conn, subtask_id)}
    data = payload()
    if "done" in data and len(data) == 1:
        return {"result": svc.toggle_subtask(conn, subtask_id, bool(data["done"]))}
    if "done" in data:
        svc.toggle_subtask(conn, subtask_id, bool(data["done"]))
    return {"result": svc.update_subtask(conn, subtask_id, data)}


@app.route("/api/subtasks/<int:subtask_id>/toggle", methods=["POST"])
@guard
def api_subtask_toggle(subtask_id: int):
    conn = database.get_db()
    return {"result": svc.toggle_subtask(conn, subtask_id)}


@app.route("/api/tasks/reorder", methods=["POST"])
@guard
def api_tasks_reorder():
    conn = database.get_db()
    data = payload()
    return {"result": svc.reorder_tasks(conn, data.get("order", []), data.get("day_index"))}


@app.route("/api/tasks/bulk-action", methods=["POST"])
@guard
def api_tasks_bulk_action():
    conn = database.get_db()
    data = payload()
    return {
        "result": svc.bulk_action(
            conn,
            str(data.get("action", "")),
            data.get("ids", []),
            day_index=data.get("day_index"),
            tag=data.get("tag"),
            priority=data.get("priority"),
            duration_text=data.get("duration_text"),
        )
    }


@app.route("/api/tasks/purge", methods=["POST"])
@guard
def api_tasks_purge():
    conn = database.get_db()
    data = payload()
    return {"result": svc.purge_done(conn, data.get("day_index"), int(data.get("older_than_days", 0) or 0))}


@app.route("/api/tasks/<int:task_id>/restore", methods=["POST"])
@guard
def api_task_restore(task_id: int):
    conn = database.get_db()
    return {"result": svc.unarchive(conn, task_id)}


@app.route("/api/tasks/archived")
def api_tasks_archived():
    conn = database.get_db()
    rows = conn.execute("SELECT * FROM tasks WHERE archived = 1 ORDER BY updated_at DESC LIMIT 200").fetchall()
    return jsonify({"tasks": [svc.serialize_task(row) for row in rows]})


# ---------------------------------------------------------------------------
# Day progression
# ---------------------------------------------------------------------------
@app.route("/api/day/<int:day_index>")
def api_day_detail(day_index: int):
    """Complete editable record set for a historical or current virtual day."""
    return jsonify(svc.day_detail(database.get_db(), day_index))


@app.route("/api/day/summary")
def api_day_summary():
    conn = database.get_db()
    day = _int_arg("day", svc.get_settings(conn).get("current_day_index", 1))
    return jsonify(
        {
            "summary": svc.day_summary(conn, day),
            "queue": svc.build_focus_queue(conn, day),
            "day_logs": svc.list_day_logs(conn, limit=30),
        }
    )


@app.route("/api/day/finish", methods=["POST"])
@guard
def api_day_finish():
    conn = database.get_db()
    data = payload()
    return {
        "result": svc.finish_day(conn, data.get("note", ""), data.get("mood", ""), data.get("carry")),
        "next_day": svc.get_settings(conn).get("current_day_index"),
    }


@app.route("/api/day/reopen", methods=["POST"])
@guard
def api_day_reopen():
    conn = database.get_db()
    return {"result": svc.reopen_day(conn)}


@app.route("/api/day/log", methods=["POST"])
@guard
def api_day_log():
    conn = database.get_db()
    data = payload()
    return {"result": svc.log_day(conn, data.get("day_index", 0), data)}


@app.route("/api/day/logs")
def api_day_logs():
    conn = database.get_db()
    return jsonify({"day_logs": svc.list_day_logs(conn, limit=_int_arg("limit", 60))})


@app.route("/api/day/queue")
def api_day_queue():
    conn = database.get_db()
    return jsonify({"queue": svc.build_focus_queue(conn, _int_arg("day", 0) or None)})


# ---------------------------------------------------------------------------
# Recurrences
# ---------------------------------------------------------------------------
@app.route("/api/recurrences", methods=["GET", "POST"])
@guard
def api_recurrences():
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"recurrences": svc.list_recurrences(conn)})
    return {"result": svc.create_recurrence(conn, payload()), "recurrences": svc.list_recurrences(conn)}


@app.route("/api/recurrences/<int:recurrence_id>", methods=["PATCH", "DELETE"])
@guard
def api_recurrence(recurrence_id: int):
    conn = database.get_db()
    if request.method == "DELETE":
        return {"result": svc.delete_recurrence(conn, recurrence_id), "recurrences": svc.list_recurrences(conn)}
    return {"result": svc.update_recurrence(conn, recurrence_id, payload()), "recurrences": svc.list_recurrences(conn)}


@app.route("/api/recurrences/materialize", methods=["POST"])
@guard
def api_recurrences_materialize():
    conn = database.get_db()
    data = payload()
    target = int(data.get("up_to_day", 0) or 0)
    if target <= 0:
        settings = svc.get_settings(conn)
        target = int(settings.get("current_day_index", 1)) + int(data.get("horizon", 7))
    return {"result": svc.materialize_recurrences(conn, target)}


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------
@app.route("/api/templates", methods=["GET", "POST"])
@guard
def api_templates():
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"templates": svc.list_templates(conn)})
    return {"result": svc.save_template(conn, payload()), "templates": svc.list_templates(conn)}


@app.route("/api/templates/<int:template_id>", methods=["DELETE"])
@guard
def api_template_delete(template_id: int):
    conn = database.get_db()
    return {"result": svc.delete_template(conn, template_id), "templates": svc.list_templates(conn)}


@app.route("/api/templates/<int:template_id>/apply", methods=["POST"])
@guard
def api_template_apply(template_id: int):
    conn = database.get_db()
    data = payload()
    return {
        "result": svc.apply_template(conn, template_id, data.get("day_index", 0), int(data.get("shift_minutes", 0) or 0)),
        "templates": svc.list_templates(conn),
    }


@app.route("/api/templates/from-day", methods=["POST"])
@guard
def api_template_from_day():
    conn = database.get_db()
    data = payload()
    return {
        "result": svc.template_from_day(conn, data.get("day_index", 0), data.get("name", ""), data.get("description", "")),
        "templates": svc.list_templates(conn),
    }


# ---------------------------------------------------------------------------
# Guided routines
# ---------------------------------------------------------------------------
@app.route("/api/routines", methods=["GET", "POST"])
@guard
def api_routines():
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({
            "routines": routine_service.list_routines(conn, include_archived=_bool_arg("archived")),
            "active_routine_run": routine_service.active_run(conn),
            "routine_runs": routine_service.list_runs(conn, limit=_int_arg("limit", 12)),
        })
    routine = routine_service.create_routine(conn, payload())
    return {"routine": routine, "routines": routine_service.list_routines(conn)}


@app.route("/api/routines/<int:routine_id>", methods=["GET", "PATCH", "DELETE"])
@guard
def api_routine(routine_id: int):
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"routine": routine_service.get_routine(conn, routine_id)})
    if request.method == "DELETE":
        return {"result": routine_service.archive_routine(conn, routine_id), "routines": routine_service.list_routines(conn)}
    routine = routine_service.update_routine(conn, routine_id, payload())
    return {"routine": routine, "routines": routine_service.list_routines(conn)}


@app.route("/api/routines/<int:routine_id>/start", methods=["POST"])
@guard
def api_routine_start(routine_id: int):
    conn = database.get_db()
    run = routine_service.start_run(conn, routine_id)
    return {"run": run, "active_routine_run": routine_service.active_run(conn)}


@app.route("/api/routine-runs", methods=["GET"])
def api_routine_runs():
    conn = database.get_db()
    return jsonify({
        "active_routine_run": routine_service.active_run(conn),
        "routine_runs": routine_service.list_runs(conn, limit=_int_arg("limit", 20)),
    })


@app.route("/api/routine-runs/<int:run_id>", methods=["PATCH"])
@guard
def api_routine_run(run_id: int):
    conn = database.get_db()
    run = routine_service.command_run(conn, run_id, payload())
    return {"run": run, "active_routine_run": routine_service.active_run(conn)}


# ---------------------------------------------------------------------------
# Focus sessions
# ---------------------------------------------------------------------------
@app.route("/api/sessions", methods=["GET", "POST"])
@guard
def api_sessions():
    conn = database.get_db()
    if request.method == "GET":
        return jsonify({"sessions": svc.recent_sessions(conn, _int_arg("limit", 40), _int_arg("day", 0) or None)})
    data = payload()
    return {
        "result": svc.start_session(
            conn, data.get("task_id", 0), data.get("kind", "focus"), int(data.get("planned_seconds", 0) or 0)
        )
    }


@app.route("/api/sessions/<int:session_id>", methods=["PATCH", "DELETE"])
@guard
def api_session(session_id: int):
    conn = database.get_db()
    if request.method == "DELETE":
        return {"result": svc.delete_session(conn, session_id)}
    return {"result": svc.update_session(conn, session_id, payload())}


@app.route("/api/sessions/<int:session_id>/end", methods=["POST"])
@guard
def api_session_end(session_id: int):
    conn = database.get_db()
    data = payload()
    return {
        "result": svc.end_session(
            conn, session_id, int(data.get("seconds", 0) or 0), bool(data.get("completed", False)), data.get("task_id", 0)
        )
    }


# ---------------------------------------------------------------------------
# Insights / stats
# ---------------------------------------------------------------------------
@app.route("/api/stats")
def api_stats():
    conn = database.get_db()
    return jsonify(stats_service.dashboard(conn, days=_int_arg("days", 30)))


@app.route("/api/stats/overview")
def api_stats_overview():
    conn = database.get_db()
    return jsonify(stats_service.overview(conn))


@app.route("/api/stats/heatmap")
def api_stats_heatmap():
    conn = database.get_db()
    return jsonify({"heatmap": stats_service.heatmap(conn, weeks=_int_arg("weeks", 12))})


@app.route("/api/stats/upcoming")
def api_stats_upcoming():
    conn = database.get_db()
    return jsonify({"upcoming": stats_service.upcoming(conn, _int_arg("limit", 8))})


@app.route("/api/stats/week")
def api_stats_week():
    conn = database.get_db()
    return jsonify(stats_service.week_summary(conn))


@app.route("/api/stats/sparkline")
def api_stats_sparkline():
    conn = database.get_db()
    days = stats_service.per_day(conn, limit=_int_arg("days", 21))
    values = [round(day["done_seconds"] / 60, 1) for day in days]
    return jsonify({"values": values, "sparkline": stats_service.sparkline(values)})


@app.route("/api/calendar/convert", methods=["POST"])
def api_calendar_convert():
    """Convert a Persian or Gregorian date without exposing locale-dependent behavior."""
    from core.calendar import format_date, parse_calendar_date

    data = payload()
    try:
        value = parse_calendar_date(data.get("date", ""), str(data.get("input_system", "auto")))
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({
        "gregorian": value.isoformat(),
        "jalali": format_date(value, "jalali"),
        "input_system": data.get("input_system", "auto"),
    })


# ---------------------------------------------------------------------------
# History / undo / redo / events
# ---------------------------------------------------------------------------
@app.route("/api/events")
def api_events():
    conn = database.get_db()
    return jsonify(
        {
            "events": svc.list_events(
                conn, limit=_int_arg("limit", 60), kind=request.args.get("kind", ""), task_id=_int_arg("task", 0)
            )
        }
    )


@app.route("/api/history")
def api_history():
    conn = database.get_db()
    return jsonify({"history": history_service.history(conn, limit=_int_arg("limit", 30))})


@app.route("/api/undo", methods=["POST"])
@guard
def api_undo():
    conn = database.get_db()
    settings = svc.get_settings(conn)
    result = history_service.undo(conn, int(settings.get("undo_limit", 40)))
    if result.get("ok"):
        svc.log_event(conn, "undo", title=str(result.get("label", "")))
    return {"result": result}


@app.route("/api/redo", methods=["POST"])
@guard
def api_redo():
    conn = database.get_db()
    settings = svc.get_settings(conn)
    result = history_service.redo(conn, int(settings.get("undo_limit", 40)))
    if result.get("ok"):
        svc.log_event(conn, "redo", title=str(result.get("label", "")))
    return {"result": result}


@app.route("/api/history/clear", methods=["POST"])
@guard
def api_history_clear():
    conn = database.get_db()
    history_service.clear(conn, payload().get("kind"))
    return {"cleared": True}


# ---------------------------------------------------------------------------
# Reminders
# ---------------------------------------------------------------------------
@app.route("/api/reminders")
def api_reminders():
    conn = database.get_db()
    return jsonify({"reminders": svc.due_reminders(conn, within_minutes=_int_arg("within", 60))})


# ---------------------------------------------------------------------------
# Backup / restore
# ---------------------------------------------------------------------------
@app.route("/api/backup/export")
def api_backup_export():
    conn = database.get_db()
    data = svc.export_backup(conn)
    as_file = _bool_arg("download")
    if as_file:
        stamp = svc.now_iso().replace(":", "").replace("-", "")
        return Response(
            json.dumps(data, indent=2),
            mimetype="application/json",
            headers={"Content-Disposition": f'attachment; filename="taskarcade-{stamp}.json"'},
        )
    return jsonify(data)


@app.route("/api/backup/import", methods=["POST"])
@guard
def api_backup_import():
    conn = database.get_db()
    data = payload()
    mode = str(data.get("mode", "merge"))
    payload_data = data.get("backup") if isinstance(data.get("backup"), dict) else data
    return {"result": svc.import_backup(conn, payload_data, mode)}


@app.route("/api/maintenance/cleanup", methods=["POST"])
@guard
def api_maintenance_cleanup():
    conn = database.get_db()
    data = payload()
    removed = svc.purge_events(conn, int(data.get("keep_events", 800) or 800))
    history_service.clear(conn, "redo")
    return {"result": {"events_removed": removed, "stats": stats_service.cleanup_stats(conn)}}


@app.route("/api/maintenance/legacy-import", methods=["POST"])
@guard
def api_maintenance_legacy():
    conn = database.get_db()
    result = database.import_legacy(payload().get("path"))
    svc.log_event(conn, "backup.import", meta={"legacy": result})
    return {"result": result}


@app.route("/api/maintenance/reset", methods=["POST"])
@guard
def api_maintenance_reset():
    conn = database.get_db()
    data = payload()
    history_service.push(conn, "factory reset", limit=40)
    scope = str(data.get("scope", "tasks"))
    if scope in ("tasks", "all"):
        conn.execute("DELETE FROM subtasks")
        conn.execute("DELETE FROM tasks")
    if scope == "all":
        conn.execute("DELETE FROM projects")
    if scope in ("tags", "all"):
        conn.execute("DELETE FROM tag_aliases")
        conn.execute("DELETE FROM tags")
    if scope in ("history", "all"):
        conn.execute("DELETE FROM events")
        conn.execute("DELETE FROM sessions")
        conn.execute("DELETE FROM day_logs")
    if scope == "all":
        conn.execute("UPDATE settings SET current_day_index = 1 WHERE id = 1")
    conn.commit()
    # Re-run migrations but never inject the starter samples again.
    database.init_db(seed_samples=False)
    return {"reset": scope}


# ---------------------------------------------------------------------------
# External work/free bridge (kept from V0.1 for backwards compatibility)
# ---------------------------------------------------------------------------
def external_request(path: str, method: str = "GET", body_payload: dict[str, Any] | None = None) -> Any:
    from urllib.error import HTTPError, URLError
    from urllib.parse import urlencode
    from urllib.request import Request, urlopen

    conn = database.get_db()
    base = (svc.get_settings(conn).get("server_url") or "").strip().rstrip("/")
    if not base or not base.startswith(("http://", "https://")):
        return jsonify({"error": "Configure a valid external server URL in Settings"}), 400
    data = json.dumps(body_payload).encode("utf-8") if body_payload is not None else None
    req = Request(
        base + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urlopen(req, timeout=5) as response:
            return Response(
                response.read(),
                status=response.status,
                mimetype=response.headers.get_content_type(),
            )
    except HTTPError as error:
        return Response(
            error.read(),
            status=error.code,
            mimetype=error.headers.get_content_type() or "application/json",
        )
    except (URLError, TimeoutError, OSError) as error:
        return jsonify({"error": "Could not reach external work/free service", "detail": str(error)}), 502


@app.route("/api/external/state")
def api_external_state():
    return external_request("/api/state")


@app.route("/api/external/mode", methods=["POST", "PUT"])
def api_external_mode():
    sid = request.args.get("s", "")
    if not sid or len(sid) > 200:
        return jsonify({"error": "A valid session id is required"}), 400
    from urllib.parse import urlencode

    return external_request(
        f"/api/sessions/099e95e6/mode?{urlencode({'s': sid})}",
        request.method,
        payload() or {},
    )


# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
# Initialise the schema as soon as the module is imported so that both
# `python app.py` and the Flask test client / a WSGI server behave the same.
BOOT_REPORT = database.init_db()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "2231"))
    debug = os.environ.get("TASKARCADE_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug, threaded=True)
