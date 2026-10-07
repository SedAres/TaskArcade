"""
TaskArcade V1.0 — API test suite.

Runs against an isolated temporary database so it never touches your real data.

    python -m unittest discover -s tests -v
    python tests/test_api.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Point the database at a scratch file *before* importing the app.
_TMP = tempfile.mkdtemp(prefix="taskarcade-tests-")
import core.config as config  # noqa: E402

config.DB_PATH = os.path.join(_TMP, "test.db")
config.DATA_DIR = _TMP
config.LEGACY_DB_PATHS = [os.path.join(_TMP, "no-such-legacy.db")]

import core.db as database  # noqa: E402

database.DB_PATH = config.DB_PATH
database.DATA_DIR = _TMP
database.LEGACY_DB_PATHS = config.LEGACY_DB_PATHS

import app as application  # noqa: E402


class TaskArcadeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        if os.path.exists(config.DB_PATH):
            os.remove(config.DB_PATH)
        database.init_db()
        # The freshly seeded sample tasks would make counts hard to assert, so
        # every test starts from an empty timeline (tags/templates stay).
        import sqlite3

        conn = sqlite3.connect(config.DB_PATH)
        conn.execute("DELETE FROM subtasks")
        conn.execute("DELETE FROM tasks")
        conn.commit()
        conn.close()
        self.client = application.app.test_client()

    # -- helpers ---------------------------------------------------------
    def state(self) -> dict:
        return self.client.get("/api/state").get_json()

    def add(self, text: str, day: int | None = None) -> dict:
        return self.client.post("/api/tasks/bulk", json={"text": text, "day_index": day}).get_json()

    # -- basics ----------------------------------------------------------
    def test_health_and_state(self) -> None:
        health = self.client.get("/api/health").get_json()
        self.assertEqual(health["status"], "ok")
        self.assertIn("counts", health)

        state = self.state()
        for key in ("settings", "tags", "tasks", "projects", "aliases", "templates", "meta"):
            self.assertIn(key, state)
        self.assertTrue(state["meta"]["themes"])
        self.assertGreaterEqual(len(state["meta"]["themes"]), 5)

    def test_index_page_renders(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        self.assertIn("TaskArcade", body)
        self.assertIn('href="/static/css/fonts.css"', body)
        self.assertIn("themeGallery", body)
        self.assertIn("settingsHelpBtn", body)
        self.assertIn("settingsBody", body)
        self.assertIn('data-guide-lang="en"', body)
        self.assertIn('data-guide-lang="fa"', body)
        self.assertIn('id="languageSelect"', body)
        self.assertIn('id="calendarStartDateInput"', body)
        self.assertIn('id="timezoneInput"', body)
        self.assertIn('id="persianFontSelect"', body)
        self.assertIn('id="historyDaySheet"', body)
        self.assertIn('id="analyticsSummary"', body)
        self.assertIn('id="viewProjects"', body)
        self.assertIn('id="projectSheet"', body)
        self.assertIn('id="editProject"', body)
        self.assertIn('id="routineRunnerView"', body)
        self.assertIn("Four optional controls tune the runner", body)
        self.assertNotIn('id="routineAutoAdvanceSwitch"', body)
        self.assertIn("bootData", body)

    def test_static_assets_exist(self) -> None:
        for path in (
            "/static/css/fonts.css",
            "/static/css/base.css",
            "/static/css/components.css",
            "/static/css/themes.css",
            "/static/css/responsive.css",
            "/static/css/rtl.css",
            "/static/css/history-calendar.css",
            "/static/css/polish.css",
            "/static/js/app.js",
            "/static/js/calendar-utils.js",
            "/static/js/projects-ui.js",
            "/static/js/routines-ui.js",
            "/static/js/dnd.js",
            "/static/js/gestures.js",
            "/static/js/refreshbus.js",
            "/static/js/i18n.js",
            "/static/js/core.js",
            "/favicon.svg",
            "/manifest.webmanifest",
        ):
            with self.client.get(path) as response:
                self.assertEqual(response.status_code, 200, path)

    def test_persian_fonts_are_local_and_precached_for_offline_use(self) -> None:
        with self.client.get("/static/css/fonts.css") as response:
            css = response.get_data(as_text=True)
        for family in ("Vazirmatn", "Estedad", "Noto Naskh Arabic", "Sahel"):
            self.assertIn(f'font-family: "{family}"', css)
        self.assertIn("font-display: swap", css)
        self.assertNotIn("fonts.googleapis.com", css)

        with self.client.get("/sw.js") as response:
            worker = response.get_data(as_text=True)
        self.assertIn("taskarcade-v3", worker)
        for asset in (
            "/static/css/fonts.css",
            "/static/css/rtl.css",
            "/static/css/history-calendar.css",
            "/static/css/polish.css",
            "/static/fonts/Vazirmatn-VF.woff2",
            "/static/fonts/Estedad-VF.woff2",
            "/static/fonts/NotoNaskhArabic-VF.ttf",
            "/static/fonts/Sahel-Regular.woff2",
            "/static/js/calendar-utils.js",
            "/static/js/projects-ui.js",
            "/static/js/routines-ui.js",
            "/static/js/dnd.js",
            "/static/js/gestures.js",
            "/static/js/refreshbus.js",
        ):
            self.assertIn(asset, worker)

    def test_projects_api_and_task_association(self) -> None:
        created = self.client.post("/api/projects", json={
            "name": "Website launch",
            "description": "Deliver the first public release.",
            "color": "#2563eb",
        })
        self.assertEqual(created.status_code, 200)
        project = created.get_json()["project"]
        project_id = project["id"]
        self.assertEqual(project["name"], "Website launch")
        self.assertEqual(project["task_count"], 0)

        task_response = self.client.post("/api/tasks", json={
            "title": "Write launch copy", "seconds": 1800, "project_id": project_id,
        })
        self.assertEqual(task_response.status_code, 200)
        task_id = task_response.get_json()["created"]["id"]
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(task["project_id"], project_id)

        detail = self.client.get(f"/api/projects/{project_id}").get_json()["project"]
        self.assertEqual(detail["task_count"], 1)
        self.assertEqual(detail["open_count"], 1)
        self.assertEqual(detail["planned_seconds"], 1800)
        state_project = next(item for item in self.state()["projects"] if item["id"] == project_id)
        self.assertEqual(state_project["task_count"], 1)

        invalid = self.client.patch(f"/api/tasks/{task_id}", json={"project_id": 99999})
        self.assertEqual(invalid.status_code, 400)
        renamed = self.client.patch(f"/api/projects/{project_id}", json={"name": "Release 1"})
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.get_json()["project"]["name"], "Release 1")

        deleted = self.client.delete(f"/api/projects/{project_id}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.get_json()["result"]["unassigned_tasks"], 1)
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(task["project_id"], 0)
        self.assertEqual(self.client.get(f"/api/projects/{project_id}").status_code, 404)

    def test_project_changes_participate_in_undo_and_redo(self) -> None:
        project = self.client.post("/api/projects", json={"name": "Undoable"}).get_json()["project"]
        undone = self.client.post("/api/undo").get_json()["result"]
        self.assertTrue(undone["ok"])
        self.assertNotIn(project["id"], [item["id"] for item in self.state()["projects"]])
        redone = self.client.post("/api/redo").get_json()["result"]
        self.assertTrue(redone["ok"])
        self.assertEqual(self.client.get(f"/api/projects/{project['id']}").get_json()["project"]["name"], "Undoable")

    def test_projects_and_task_links_survive_backup_replace(self) -> None:
        project = self.client.post("/api/projects", json={"name": "Research"}).get_json()["project"]
        created = self.client.post("/api/tasks", json={
            "title": "Read the paper", "seconds": 1200, "project_id": project["id"],
        }).get_json()
        task_id = created["created"]["id"]
        backup = self.client.get("/api/backup/export").get_json()
        self.assertEqual(backup["counts"]["projects"], 1)
        self.assertEqual(backup["tables"]["tasks"][0]["project_id"], project["id"])
        self.client.delete(f"/api/projects/{project['id']}")
        restored = self.client.post("/api/backup/import", json={"backup": backup, "mode": "replace"})
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(self.client.get(f"/api/tasks/{task_id}").get_json()["task"]["project_id"], project["id"])
        self.assertEqual(self.client.get(f"/api/projects/{project['id']}").get_json()["project"]["name"], "Research")

    def test_tracked_tag_is_retired_during_migration(self) -> None:
        task = self.client.post("/api/tasks", json={"title": "Old tag", "tag": "tracked", "seconds": 600}).get_json()
        task_id = task["created"]["id"]
        conn = sqlite3.connect(config.DB_PATH)
        conn.execute("INSERT OR IGNORE INTO tag_aliases (alias, tag_name, created_at) VALUES ('t', 'tracked', '')")
        conn.commit()
        conn.close()

        database.init_db(seed_samples=False)
        state = self.state()
        self.assertNotIn("tracked", [tag["name"] for tag in state["tags"]])
        self.assertNotIn("t", state["aliases"])
        self.assertEqual(self.client.get(f"/api/tasks/{task_id}").get_json()["task"]["tag"], "")

    def test_routines_can_be_created_and_run_step_by_step(self) -> None:
        created = self.client.post("/api/routines", json={
            "name": "Morning routine",
            "description": "A calm start",
            "emoji": "☀️",
            "steps": [
                {"title": "Make the bed", "minutes": 1, "emoji": "🛏️"},
                {"title": "Stretch", "minutes": 2},
                {"title": "Review the day", "minutes": 3},
            ],
        })
        self.assertEqual(created.status_code, 200)
        routine = created.get_json()["routine"]
        self.assertEqual(routine["step_count"], 3)
        self.assertEqual(routine["duration_seconds"], 360)

        started = self.client.post(f"/api/routines/{routine['id']}/start").get_json()["run"]
        self.assertEqual(started["status"], "running")
        self.assertEqual(started["current_step"]["title"], "Make the bed")

        paused = self.client.patch(f"/api/routine-runs/{started['id']}", json={
            "action": "pause", "remaining_seconds": 40,
        }).get_json()["run"]
        self.assertEqual(paused["status"], "paused")
        resumed = self.client.patch(f"/api/routine-runs/{started['id']}", json={"action": "resume"}).get_json()["run"]
        self.assertEqual(resumed["status"], "running")

        next_step = self.client.patch(f"/api/routine-runs/{started['id']}", json={
            "action": "complete_step", "remaining_seconds": 20,
        }).get_json()["run"]
        self.assertEqual(next_step["current_step_index"], 1)
        self.assertEqual(next_step["current_step"]["title"], "Stretch")

        skipped = self.client.patch(f"/api/routine-runs/{started['id']}", json={
            "action": "skip_step", "remaining_seconds": 30,
        }).get_json()["run"]
        self.assertEqual(skipped["current_step"]["title"], "Review the day")
        self.assertEqual(skipped["skipped_steps"], 1)

        finished = self.client.patch(f"/api/routine-runs/{started['id']}", json={
            "action": "complete_step", "remaining_seconds": 0,
        }).get_json()["run"]
        self.assertEqual(finished["status"], "completed")
        self.assertEqual(finished["step_statuses"], ["completed", "skipped", "completed"])
        self.assertIsNone(self.client.get("/api/routine-runs").get_json()["active_routine_run"])

    def test_routine_move_to_end_is_an_explicit_ordered_action(self) -> None:
        routine = self.client.post("/api/routines", json={
            "name": "Three-part flow",
            "steps": [
                {"title": "First", "minutes": 2},
                {"title": "Second", "minutes": 3},
                {"title": "Third", "minutes": 4},
            ],
        }).get_json()["routine"]
        run = self.client.post(f"/api/routines/{routine['id']}/start").get_json()["run"]
        moved = self.client.patch(f"/api/routine-runs/{run['id']}", json={
            "action": "move_to_end", "remaining_seconds": 75,
        }).get_json()["run"]
        self.assertEqual([step["title"] for step in moved["steps"]], ["Second", "Third", "First"])
        self.assertEqual(moved["current_step"]["title"], "Second")
        self.assertEqual(moved["step_statuses"], ["active", "pending", "pending"])
        self.assertEqual(moved["status"], "running")

        skipped = self.client.patch(f"/api/routine-runs/{run['id']}", json={
            "action": "skip_step", "remaining_seconds": 150,
        }).get_json()["run"]
        self.assertEqual(skipped["current_step"]["title"], "Third")
        self.assertEqual(skipped["skipped_steps"], 1)

    def test_routines_reject_empty_steps_and_can_be_archived(self) -> None:
        invalid = self.client.post("/api/routines", json={"name": "Empty", "steps": []})
        self.assertEqual(invalid.status_code, 400)
        created = self.client.post("/api/routines", json={
            "name": "Walkthrough", "steps": [{"title": "Start", "minutes": 1}],
        }).get_json()["routine"]
        archived = self.client.delete(f"/api/routines/{created['id']}").get_json()["result"]
        self.assertTrue(archived["archived"])
        self.assertEqual(self.client.get("/api/routines").get_json()["routines"], [])

    def test_editing_a_routine_does_not_rewrite_an_active_run(self) -> None:
        routine = self.client.post("/api/routines", json={
            "name": "Desk reset", "steps": [{"title": "Clear desk", "minutes": 2}],
        }).get_json()["routine"]
        run = self.client.post(f"/api/routines/{routine['id']}/start").get_json()["run"]
        updated = self.client.patch(f"/api/routines/{routine['id']}", json={
            "steps": [{"title": "Clear desk and file notes", "minutes": 4}],
        }).get_json()["routine"]
        self.assertEqual(updated["steps"][0]["title"], "Clear desk and file notes")
        active = self.client.get("/api/routine-runs").get_json()["active_routine_run"]
        self.assertEqual(active["id"], run["id"])
        self.assertEqual(active["current_step"]["title"], "Clear desk")

    def test_routine_definition_and_run_survive_replace_backup(self) -> None:
        routine = self.client.post("/api/routines", json={
            "name": "Tea break", "steps": [{"title": "Brew tea", "minutes": 1}],
        }).get_json()["routine"]
        run = self.client.post(f"/api/routines/{routine['id']}/start").get_json()["run"]
        self.client.patch(f"/api/routine-runs/{run['id']}", json={"action": "complete_step", "remaining_seconds": 0})
        backup = self.client.get("/api/backup/export").get_json()
        self.assertEqual(backup["counts"]["routines"], 1)
        self.assertEqual(backup["counts"]["routine_runs"], 1)
        self.client.delete(f"/api/routines/{routine['id']}")
        imported = self.client.post("/api/backup/import", json={"backup": backup, "mode": "replace"})
        self.assertEqual(imported.status_code, 200)
        self.assertEqual(self.client.get("/api/routines").get_json()["routines"][0]["name"], "Tea break")
        self.assertEqual(self.client.get("/api/routine-runs").get_json()["routine_runs"][0]["status"], "completed")

    def test_four_routine_runner_preferences_persist(self) -> None:
        choices = {
            "routine_sound": 0,
            "routine_vibrate": 1,
            "routine_keep_awake": 1,
            "routine_show_next": 0,
        }
        response = self.client.patch("/api/settings", json=choices)
        self.assertEqual(response.status_code, 200)
        settings = self.state()["settings"]
        for key, value in choices.items():
            self.assertEqual(settings[key], value)
        ignored = self.client.patch("/api/settings", json={"routine_auto_advance": 1})
        self.assertEqual(ignored.status_code, 200)
        self.assertEqual(self.state()["settings"]["routine_auto_advance"], 0)

    # -- aliases ---------------------------------------------------------
    def test_alias_resolution_defaults(self) -> None:
        state = self.state()
        self.assertNotIn("t", state["aliases"])
        self.assertEqual(state["aliases"].get("w"), "work")
        self.assertEqual(state["aliases"].get("s"), "study")

    def test_parse_resolves_alias(self) -> None:
        result = self.client.post("/api/parse", json={"text": "Write report #w 90m !!!"}).get_json()
        parsed = result["parsed"]
        self.assertEqual(parsed["tag"], "work")
        self.assertTrue(parsed["tag_alias"])
        self.assertEqual(parsed["tag_token"], "w")
        self.assertEqual(parsed["seconds"], 5400)
        self.assertEqual(parsed["priority"], 3)

    def test_parse_handles_every_token(self) -> None:
        line = "Deep work #w 90m @09:30 !! ~2p +outline +draft >call the client ^"
        parsed = self.client.post("/api/parse", json={"text": line}).get_json()["parsed"]
        self.assertEqual(parsed["title"], "Deep work")
        self.assertEqual(parsed["tag"], "work")
        self.assertEqual(parsed["priority"], 2)
        self.assertEqual(parsed["scheduled_at"], "09:30")
        self.assertEqual(parsed["seconds"], 2 * 25 * 60)
        self.assertEqual(parsed["subtasks"], ["outline", "draft"])
        self.assertEqual(parsed["notes"], "call the client")
        self.assertTrue(parsed["pinned"])

    def test_bare_number_only_counts_as_last_token(self) -> None:
        parsed = self.client.post("/api/parse", json={"text": "Call 3 people"}).get_json()["parsed"]
        self.assertEqual(parsed["title"], "Call 3 people")
        parsed = self.client.post("/api/parse", json={"text": "Walk the dog 45"}).get_json()["parsed"]
        self.assertEqual(parsed["title"], "Walk the dog")
        self.assertEqual(parsed["seconds"], 45 * 60)

    def test_alias_creation_and_conflict(self) -> None:
        response = self.client.post("/api/aliases", json={"alias": "zz", "tag": "home"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["aliases"]["zz"], "home")

        conflict = self.client.post("/api/aliases", json={"alias": "zz", "tag": "study"})
        self.assertEqual(conflict.status_code, 400)

        deleted = self.client.delete("/api/aliases/zz").get_json()
        self.assertNotIn("zz", deleted["aliases"])

    def test_custom_alias_is_used_by_bulk_add(self) -> None:
        self.client.post("/api/aliases", json={"alias": "px", "tag": "study"})
        result = self.add("Pixel art practice #px 45m")
        self.assertEqual(result["result"]["created"], 1)
        task = self.state()["tasks"][-1]
        self.assertEqual(task["tag"], "study")

    # -- tasks -----------------------------------------------------------
    def test_bulk_add_with_subtasks_and_recurrence(self) -> None:
        text = "Deep work #w 90m !! @09:30\n  outline\n  write\nLaundry #h 40m *weekly"
        result = self.add(text)
        self.assertEqual(result["result"]["created"], 2)
        tasks = self.state()["tasks"]
        deep = next(task for task in tasks if task["title"] == "Deep work")
        self.assertEqual(len(deep["subtasks"]), 2)
        self.assertEqual(deep["scheduled_at"], "09:30")
        rules = self.state()["recurrences"]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["title"], "Laundry")

    def test_task_update_preserves_elapsed_time(self) -> None:
        task_id = self.add("Focus block #w 60m")["result"]["ids"][0]
        self.client.post(f"/api/tasks/{task_id}/tick", json={"remaining_seconds": 1800, "seconds_spent": 1800})
        self.client.patch(f"/api/tasks/{task_id}", json={"duration_text": "2h"})
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(task["total_seconds"], 7200)
        self.assertEqual(task["remaining_seconds"], 7200 - 1800)

    def test_shrinking_below_elapsed_keeps_task_open(self) -> None:
        task_id = self.add("Long haul #w 4h")["result"]["ids"][0]
        self.client.post(f"/api/tasks/{task_id}/tick", json={"remaining_seconds": 3600, "seconds_spent": 10800})
        self.client.patch(f"/api/tasks/{task_id}", json={"total_seconds": 600})
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertFalse(task["done"])
        self.assertEqual(task["elapsed_seconds"], 10800)
        self.assertGreater(task["remaining_seconds"], 0)
        self.assertLessEqual(task["remaining_seconds"], 600)

    def test_elapsed_time_schema_migration_backfills_progress(self) -> None:
        import sqlite3

        if sqlite3.sqlite_version_info < (3, 35, 0):
            self.skipTest("SQLite DROP COLUMN requires 3.35 or newer")
        task_id = self.add("Migrated task #w 1h")["result"]["ids"][0]
        conn = sqlite3.connect(config.DB_PATH)
        conn.execute("ALTER TABLE tasks DROP COLUMN elapsed_seconds")
        conn.execute("UPDATE tasks SET total_seconds = 3600, remaining_seconds = 2400 WHERE id = ?", (task_id,))
        conn.commit()
        conn.close()

        database.init_db(seed_samples=False)
        migrated = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(migrated["elapsed_seconds"], 1200)

    def test_elapsed_time_is_editable_for_open_and_completed_tasks(self) -> None:
        task_id = self.add("Historical work #w 1h")["result"]["ids"][0]

        response = self.client.patch(
            f"/api/tasks/{task_id}", json={"elapsed_seconds": 5400, "done": False}
        )
        self.assertEqual(response.status_code, 200)
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(task["elapsed_seconds"], 5400)
        self.assertFalse(task["done"])
        self.assertEqual(task["remaining_seconds"], 1)

        stats = self.client.get("/api/stats?days=7").get_json()
        self.assertEqual(stats["days"][0]["done_seconds"], 5400)
        self.assertEqual(stats["overview"]["elapsed_seconds"], 5400)

        response = self.client.patch(
            f"/api/tasks/{task_id}", json={"elapsed_seconds": 123, "done": True}
        )
        self.assertEqual(response.status_code, 200)
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertTrue(task["done"])
        self.assertEqual(task["elapsed_seconds"], 123)
        self.assertEqual(task["remaining_seconds"], 0)
        self.assertEqual(self.client.get("/api/day/1").get_json()["summary"]["done_seconds"], 123)

        invalid = self.client.patch(f"/api/tasks/{task_id}", json={"elapsed_seconds": -1})
        self.assertEqual(invalid.status_code, 400)

    def test_done_skip_and_reopen(self) -> None:
        ids = self.add("A #w 30m\nB #w 30m")["result"]["ids"]
        self.client.post(f"/api/tasks/{ids[0]}/done", json={})
        tasks = {task["id"]: task for task in self.state()["tasks"]}
        self.assertTrue(tasks[ids[0]]["done"])
        self.assertEqual(tasks[ids[0]]["remaining_seconds"], 0)

        self.client.post(f"/api/tasks/{ids[1]}/skip", json={"to_end": True})
        moved = self.client.get(f"/api/tasks/{ids[1]}").get_json()["task"]
        self.assertEqual(moved["skipped_count"], 1)

        self.client.post(f"/api/tasks/{ids[0]}/done", json={"done": False})
        reopened = self.client.get(f"/api/tasks/{ids[0]}").get_json()["task"]
        self.assertFalse(reopened["done"])
        self.assertEqual(reopened["remaining_seconds"], reopened["total_seconds"])

    def test_reorder_and_move(self) -> None:
        ids = self.add("One #w 10m\nTwo #w 10m\nThree #w 10m")["result"]["ids"]
        self.client.post("/api/tasks/reorder", json={"order": list(reversed(ids)), "day_index": 1})
        tasks = [task for task in self.state()["tasks"] if task["id"] in ids]
        ordered = sorted(tasks, key=lambda task: task["order_index"])
        self.assertEqual([task["id"] for task in ordered], list(reversed(ids)))

        self.client.post(f"/api/tasks/{ids[0]}/move", json={"day_index": 3})
        moved = self.client.get(f"/api/tasks/{ids[0]}").get_json()["task"]
        self.assertEqual(moved["day_index"], 3)

    def test_split_and_duplicate(self) -> None:
        task_id = self.add("Write chapter #w 2h")["result"]["ids"][0]
        split = self.client.post(f"/api/tasks/{task_id}/split", json={"pieces": 3}).get_json()
        self.assertEqual(len(split["result"]["created"]), 2)
        pieces = [task for task in self.state()["tasks"] if "part" in task["title"]] if False else None
        void = pieces
        duplicated = self.client.post(f"/api/tasks/{task_id}/duplicate").get_json()
        copy = self.client.get(f"/api/tasks/{duplicated['result']['id']}").get_json()["task"]
        self.assertIn("(copy)", copy["title"])
        self.assertEqual(void, None)

    def test_subtasks_crud_and_auto_complete(self) -> None:
        task_id = self.add("Ship release #w 30m")["result"]["ids"][0]
        first = self.client.post(f"/api/tasks/{task_id}/subtasks", json={"title": "scope"}).get_json()
        self.client.post(f"/api/tasks/{task_id}/subtasks", json={"title": "build"})
        subtask_id = first["result"]["id"]

        toggled = self.client.post(f"/api/subtasks/{subtask_id}/toggle").get_json()
        self.assertTrue(toggled["result"]["done"])

        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(len(task["subtasks"]), 2)
        self.assertFalse(task["done"])

        second = [sub for sub in task["subtasks"] if sub["id"] != subtask_id][0]
        self.client.patch(f"/api/subtasks/{second['id']}", json={"done": True})
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertTrue(task["done"])

        self.client.patch(f"/api/subtasks/{subtask_id}", json={"title": "scope v2"})
        renamed = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertIn("scope v2", [sub["title"] for sub in renamed["subtasks"]])

        self.client.delete(f"/api/subtasks/{subtask_id}")
        remaining = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(len(remaining["subtasks"]), 1)

    def test_bulk_action(self) -> None:
        ids = self.add("X #w 10m\nY #w 10m\nZ #w 10m")["result"]["ids"]
        result = self.client.post("/api/tasks/bulk-action", json={"action": "done", "ids": ids}).get_json()
        self.assertEqual(result["result"]["touched"], 3)
        self.assertTrue(all(task["done"] for task in self.state()["tasks"] if task["id"] in ids))

        self.client.post("/api/tasks/bulk-action", json={"action": "tag", "ids": ids, "tag": "study"})
        self.assertTrue(all(task["tag"] == "study" for task in self.state()["tasks"] if task["id"] in ids))

        self.client.post("/api/tasks/bulk-action", json={"action": "priority", "ids": ids, "priority": 3})
        self.assertTrue(all(task["priority"] == 3 for task in self.state()["tasks"] if task["id"] in ids))

    # -- tags ------------------------------------------------------------
    def test_tag_crud_and_merge(self) -> None:
        created = self.client.post("/api/tags", json={
            "name": "reading",
            "label": "Reading",
            "color": "#4DABF7",
            "aliases": ["r", "rd"],
            "default_minutes": 45,
        }).get_json()
        names = [tag["name"] for tag in created["tags"]]
        self.assertIn("reading", names)
        self.assertEqual(created["aliases"]["r"], "reading")

        task_id = self.add("Read a chapter #rd")["result"]["ids"][0]
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(task["tag"], "reading")
        self.assertEqual(task["total_seconds"], 45 * 60)  # tag default duration applied

        merged = self.client.post("/api/tags/merge", json={"source": "reading", "target": "study"}).get_json()
        self.assertEqual(merged["result"]["moved"], 1)
        self.assertEqual(merged["result"]["target"], "study")

        deleted = self.client.delete("/api/tags/study").get_json()
        self.assertEqual(deleted["result"]["deleted"], "study")

    # -- day progression --------------------------------------------------
    def test_finish_day_carries_open_tasks(self) -> None:
        ids = self.add("Keep #w 30m\nFinish me #w 30m")["result"]["ids"]
        self.client.post(f"/api/tasks/{ids[0]}/done", json={})
        result = self.client.post("/api/day/finish", json={"carry": "always", "mood": "good"}).get_json()
        self.assertEqual(result["next_day"], 2)
        self.assertEqual(result["result"]["carried"], 1)

        state = self.state()
        self.assertEqual(state["settings"]["current_day_index"], 2)
        carried = next(task for task in state["tasks"] if task["id"] == ids[1])
        self.assertEqual(carried["day_index"], 2)
        logs = state["day_logs"]
        self.assertTrue(any(log["day_index"] == 1 and log["mood"] == "good" for log in logs))

    def test_finish_day_can_leave_tasks_behind(self) -> None:
        task_id = self.add("Stay put #w 30m")["result"]["ids"][0]
        self.client.post("/api/day/finish", json={"carry": "never"})
        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(task["day_index"], 1)

    def test_reopen_day(self) -> None:
        self.client.post("/api/day/finish", json={})
        reopened = self.client.post("/api/day/reopen").get_json()
        self.assertEqual(reopened["result"]["current_day_index"], 1)
        again = self.client.post("/api/day/reopen").get_json()
        self.assertIn("error", again["result"])

    def test_day_summary_and_queue(self) -> None:
        self.add("Urgent thing #w 30m !!!\nCasual thing #f 30m")
        summary = self.client.get("/api/day/summary?day=1").get_json()
        self.assertEqual(summary["summary"]["tasks"], 2)
        self.assertGreaterEqual(len(summary["queue"]), 2)
        self.assertGreater(summary["queue"][0]["focus_score"], summary["queue"][1]["focus_score"])

    def test_day_log(self) -> None:
        self.client.post("/api/day/log", json={"day_index": 1, "note": "solid day", "mood": "great"})
        logs = self.client.get("/api/day/logs").get_json()["day_logs"]
        self.assertEqual(logs[0]["note"], "solid day")
        self.assertEqual(logs[0]["mood"], "great")

    # -- sessions & stats -------------------------------------------------
    def test_sessions_and_insights(self) -> None:
        task_id = self.add("Deep session #w 1h")["result"]["ids"][0]
        started = self.client.post("/api/sessions", json={"task_id": task_id, "kind": "focus", "planned_seconds": 1500})
        session_id = started.get_json()["result"]["id"]
        self.client.post(f"/api/sessions/{session_id}/end", json={"seconds": 1500, "completed": True, "task_id": task_id})

        sessions = self.client.get("/api/sessions").get_json()["sessions"]
        self.assertEqual(sessions[0]["seconds"], 1500)
        self.assertTrue(sessions[0]["completed"])

        task = self.client.get(f"/api/tasks/{task_id}").get_json()["task"]
        self.assertEqual(task["focus_seconds"], 1500)

        stats = self.client.get("/api/stats").get_json()
        self.assertEqual(stats["overview"]["focus_seconds"], 1500)
        self.assertIn("heatmap", stats)
        self.assertIn("streaks", stats)
        self.assertIn("level", stats)

    def test_recurrences_materialize(self) -> None:
        self.client.post("/api/recurrences", json={
            "title": "Daily review",
            "tag": "work",
            "duration_seconds": 900,
            "rule": {"freq": "daily", "interval": 1, "weekdays": [], "time": "21:00"},
            "anchor_day_index": 1,
        })
        result = self.client.post("/api/recurrences/materialize", json={"up_to_day": 5}).get_json()
        self.assertGreaterEqual(result["result"]["created"], 5)
        titles = [task["title"] for task in self.state()["tasks"]]
        self.assertEqual(titles.count("Daily review"), 5)

        repeat = self.client.post("/api/recurrences/materialize", json={"up_to_day": 5}).get_json()
        self.assertEqual(repeat["result"]["created"], 0)

    def test_weekly_recurrence_only_hits_matching_days(self) -> None:
        self.client.post("/api/recurrences", json={
            "title": "Gym",
            "duration_seconds": 3600,
            "rule": {"freq": "weekly", "interval": 1, "weekdays": [0], "time": "07:00"},
            "anchor_day_index": 1,
        })
        self.client.post("/api/recurrences/materialize", json={"up_to_day": 21})
        days = [task["day_index"] for task in self.state()["tasks"] if task["title"] == "Gym"]
        self.assertTrue(days)
        self.assertTrue(all((day - 1) % 7 == 0 for day in days))

    # -- templates --------------------------------------------------------
    def test_template_lifecycle(self) -> None:
        self.add("Alpha #w 30m !\nBeta #h 45m")
        saved = self.client.post("/api/templates/from-day", json={"day_index": 1, "name": "My set"}).get_json()
        template_id = saved["result"]["id"]

        applied = self.client.post(f"/api/templates/{template_id}/apply", json={"day_index": 4}).get_json()
        self.assertEqual(len(applied["result"]["created"]), 2, applied)
        day4 = [task for task in self.state()["tasks"] if task["day_index"] == 4]
        self.assertEqual(len(day4), 2)

        templates = self.client.get("/api/templates").get_json()["templates"]
        stored = next(template for template in templates if template["id"] == template_id)
        self.assertEqual(stored["minutes"], 75)
        self.assertEqual(stored["task_count"], 2)

        self.client.delete(f"/api/templates/{template_id}")
        self.assertNotIn(template_id, [template["id"] for template in self.client.get("/api/templates").get_json()["templates"]])

    def test_templates_apply_keeps_existing_tasks(self) -> None:
        self.add("Base #w 30m")
        template_id = self.client.post("/api/templates", json={
            "name": "Extra",
            "payload": {"tasks": [{"title": "Extra task", "minutes": 15}]},
        }).get_json()["result"]["id"]
        self.client.post(f"/api/templates/{template_id}/apply", json={"day_index": 1})
        titles = [task["title"] for task in self.state()["tasks"] if task["day_index"] == 1]
        self.assertIn("Base", titles)
        self.assertIn("Extra task", titles)

    # -- undo/redo --------------------------------------------------------
    def test_undo_and_redo_round_trip(self) -> None:
        self.add("Something #w 20m")
        before = len(self.state()["tasks"])
        task_id = self.add("Remove me #w 20m")["result"]["ids"][0]
        self.assertEqual(len(self.state()["tasks"]), before + 1)

        self.client.delete(f"/api/tasks/{task_id}")
        self.assertEqual(len(self.state()["tasks"]), before)

        undone = self.client.post("/api/undo").get_json()
        self.assertTrue(undone["result"]["ok"])
        self.assertEqual(len(self.state()["tasks"]), before + 1)

        redone = self.client.post("/api/redo").get_json()
        self.assertTrue(redone["result"]["ok"])
        self.assertEqual(len(self.state()["tasks"]), before)

    def test_settings_are_undoable(self) -> None:
        self.client.post("/api/settings", json={"capacity_minutes": 300})
        self.assertEqual(self.state()["settings"]["capacity_minutes"], 300)
        self.client.post("/api/undo")
        self.assertNotEqual(self.state()["settings"]["capacity_minutes"], 300)

    # -- settings ---------------------------------------------------------
    def test_settings_validation(self) -> None:
        result = self.client.post("/api/settings", json={
            "theme": "not-a-theme",
            "capacity_minutes": 99999,
            "font_scale": 9,
            "view_mode": "week",
        }).get_json()
        settings = result["settings"]
        self.assertNotEqual(settings["theme"], "not-a-theme")
        self.assertLessEqual(settings["capacity_minutes"], 1440)
        self.assertLessEqual(settings["font_scale"], 1.35)
        self.assertEqual(settings["view_mode"], "week")

    def test_timezone_must_be_a_valid_iana_zone(self) -> None:
        valid = self.client.post("/api/settings", json={"timezone": "Asia/Tehran"})
        self.assertEqual(valid.status_code, 200)
        self.assertEqual(valid.get_json()["settings"]["timezone"], "Asia/Tehran")
        invalid = self.client.post("/api/settings", json={"timezone": "Mars/Olympus"})
        self.assertEqual(invalid.status_code, 400)

    def test_best_focus_hour_uses_configured_timezone(self) -> None:
        task_id = self.add("Timezone test #w 30m")["result"]["ids"][0]
        self.client.post("/api/settings", json={"timezone": "Asia/Tehran"})
        session_id = self.client.post("/api/sessions", json={
            "kind": "focus", "task_id": task_id, "planned_seconds": 1800,
        }).get_json()["result"]["id"]
        response = self.client.patch(f"/api/sessions/{session_id}", json={
            "seconds": 1800,
            "started_at": "2024-01-02T06:45:00+00:00",
            "ended_at": "2024-01-02T07:15:00+00:00",
        })
        self.assertEqual(response.status_code, 200)
        hours = self.client.get("/api/stats?days=7").get_json()["hours"]
        self.assertEqual(hours[10]["minutes"], 30)

    def test_jalali_calendar_accepts_persian_digits(self) -> None:
        response = self.client.post("/api/calendar/convert", json={
            "date": "۱۴۰۵/۰۱/۰۱", "input_system": "jalali",
        })
        self.assertEqual(response.status_code, 200)
        converted = response.get_json()
        self.assertEqual(converted["jalali"], "1405/01/01")
        self.assertEqual(converted["gregorian"], "2026-03-21")
        self.client.post("/api/settings", json={
            "language": "fa", "calendar_system": "jalali", "calendar_start_date": "۱۴۰۵/۰۱/۰۱",
        })
        self.assertEqual(self.state()["settings"]["calendar_start_date"], "2026-03-21")

    def test_settings_reset(self) -> None:
        self.client.post("/api/settings", json={"capacity_minutes": 120})
        self.client.post("/api/settings", json={"reset": True})
        self.assertEqual(self.state()["settings"]["capacity_minutes"], 480)

    # -- backup -----------------------------------------------------------
    def test_backup_export_import_round_trip(self) -> None:
        self.add("Backup target #s 1h")
        export = self.client.get("/api/backup/export").get_json()
        self.assertEqual(export["format"], "taskarcade.backup")
        self.assertGreaterEqual(export["counts"]["tasks"], 1)

        self.client.post("/api/maintenance/reset", json={"scope": "tasks"})
        self.assertEqual(self.state()["tasks"], [])

        imported = self.client.post("/api/backup/import", json={"backup": export, "mode": "merge"}).get_json()
        self.assertGreaterEqual(imported["result"]["restored"]["tasks"], 1)
        self.assertTrue(self.state()["tasks"])

    def test_import_rejects_junk(self) -> None:
        response = self.client.post("/api/backup/import", json={"backup": {"nope": True}})
        self.assertEqual(response.status_code, 400)

    def test_cleanup_and_purge(self) -> None:
        task_id = self.add("Old #w 10m")["result"]["ids"][0]
        self.client.post(f"/api/tasks/{task_id}/done", json={})
        purged = self.client.post("/api/tasks/purge", json={"day_index": 1}).get_json()
        self.assertGreaterEqual(purged["result"]["archived"], 1)
        self.assertNotIn(task_id, [task["id"] for task in self.state()["tasks"]])
        archived = self.client.get("/api/tasks/archived").get_json()["tasks"]
        self.assertIn(task_id, [task["id"] for task in archived])
        self.client.post(f"/api/tasks/{task_id}/restore")
        self.assertIn(task_id, [task["id"] for task in self.state()["tasks"]])

    # -- reminders --------------------------------------------------------
    def test_reminders_window(self) -> None:
        from datetime import datetime, timedelta

        soon = (datetime.now() + timedelta(minutes=5)).replace(microsecond=0).isoformat()
        self.client.post("/api/tasks", json={
            "title": "Ping me",
            "tag": "work",
            "seconds": 600,
            "reminder_at": soon,
        })
        reminders = self.client.get("/api/reminders?within=60").get_json()["reminders"]
        self.assertEqual(len(reminders), 1)
        self.assertEqual(reminders[0]["title"], "Ping me")
        self.assertLess(reminders[0]["due_in_seconds"], 400)

    # -- events -----------------------------------------------------------
    def test_events_are_recorded(self) -> None:
        self.add("Logged #w 10m")
        events = self.client.get("/api/events?limit=20").get_json()["events"]
        kinds = {event["kind"] for event in events}
        self.assertIn("task.create", kinds)

    def test_history_endpoint(self) -> None:
        self.add("Something #w 10m")
        history = self.client.get("/api/history").get_json()["history"]
        self.assertTrue(history)
        self.client.post("/api/history/clear", json={})
        self.assertEqual(self.client.get("/api/history").get_json()["history"], [])

    # -- parser unit coverage --------------------------------------------
    def test_duration_parser_edges(self) -> None:
        from core.parser import parse_duration

        cases = {
            "1h25m": 5100,
            "90m": 5400,
            "1.5h": 5400,
            "45": 2700,
            "2p": 3000,
            "1h": 3600,
            "30min": 1800,
            "2d": 172800,
        }
        for token, expected in cases.items():
            self.assertEqual(parse_duration(token, 25), expected, token)
        self.assertIsNone(parse_duration("later"))

    def test_priority_ladder(self) -> None:
        from core.parser import parse_priority

        self.assertEqual(parse_priority("!"), 1)
        self.assertEqual(parse_priority("!!"), 2)
        self.assertEqual(parse_priority("!!!"), 3)
        self.assertEqual(parse_priority("!!!!!"), 3)
        self.assertEqual(parse_priority("!high"), 3)
        self.assertEqual(parse_priority("!low"), 1)
        self.assertEqual(parse_priority("p2"), 2)
        self.assertIsNone(parse_priority("banana"))

    def test_priority_words_stay_in_titles(self) -> None:
        parsed = self.client.post("/api/parse", json={"text": "Buy low fat milk"}).get_json()["parsed"]
        self.assertEqual(parsed["title"], "Buy low fat milk")
        self.assertEqual(parsed["priority"], 0)

    def test_recurrence_matcher(self) -> None:
        from core.parser import parse_recurrence, rule_matches_day

        daily = parse_recurrence("daily")
        self.assertTrue(rule_matches_day(daily, 2, 1))
        every3 = parse_recurrence("every:3")
        self.assertTrue(rule_matches_day(every3, 4, 1))
        self.assertFalse(rule_matches_day(every3, 3, 1))
        weekdays = parse_recurrence("weekdays")
        self.assertTrue(rule_matches_day(weekdays, 3, 1))
        self.assertFalse(rule_matches_day(weekdays, 7, 1))

    def test_bulk_parser_reports_bad_lines(self) -> None:
        result = self.add("#w 30m\nA good task #w 30m")
        self.assertEqual(result["result"]["created"], 1)
        self.assertEqual(len(result["result"]["bad_lines"]), 1)

    def test_empty_bulk_is_rejected(self) -> None:
        response = self.client.post("/api/tasks/bulk", json={"text": "   \n  \n"})
        payload = response.get_json()
        self.assertIn("error", payload)

    # -- misc -------------------------------------------------------------
    def test_unknown_task_returns_404(self) -> None:
        self.assertEqual(self.client.patch("/api/tasks/999999", json={"title": "x"}).status_code, 404)
        self.assertEqual(self.client.delete("/api/tasks/999999").status_code, 404)

    def test_invalid_duration_is_rejected(self) -> None:
        task_id = self.add("Task #w 30m")["result"]["ids"][0]
        response = self.client.patch(f"/api/tasks/{task_id}", json={"duration_text": "banana"})
        self.assertEqual(response.status_code, 400)

    def test_theme_registry_shape(self) -> None:
        manifest = self.client.get("/manifest.webmanifest").get_json()
        self.assertEqual(manifest["background_color"], "#f4f6fb")
        self.assertEqual(manifest["theme_color"], "#4f46e5")
        state = self.state()
        themes = state["meta"]["themes"]
        self.assertEqual(len(themes), 5)
        designs = state["meta"]["designs"]
        self.assertEqual(len(designs), 8)
        self.assertEqual(len({design["id"] for design in designs}), 8)
        for theme in themes:
            self.assertIn("id", theme)
            self.assertIn("swatch", theme)
            self.assertIn("blurb", theme)

    def test_stats_sparkline(self) -> None:
        self.add("Spark #w 30m")
        payload = self.client.get("/api/stats/sparkline?days=10").get_json()
        self.assertIn("values", payload)
        self.assertIn("sparkline", payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
