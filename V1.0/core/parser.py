"""
TaskArcade V1.0 — the quick-add parsing engine.

A single line of text can describe a lot:

    Deep work #w 90m @09:30 !! ~2p +outline +draft *daily >client call

Grammar (all tokens optional except a title):

    #tag | #alias     tag, or a short alias that resolves to a real tag
    @HH:MM | @now     scheduled clock time, "now", or "+15m" relative offset
    ! !! !!!          priority low / medium / high
    ~90m ~2h ~3p      explicit estimate (p = pomodoro = 25m by default)
    *daily *weekly    recurrence rule
    +item             subtask line
    >text             inline note
    ^                 pin the task
    last token        bare duration ("Clean room 45m")

Alias resolution is case-insensitive and can be constrained with a prefix
characters rule set by the user (for example, `#w` → `#work`).
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

from .config import DURATION_UNITS, PRIORITY_WORDS, RECURRENCE_FREQS
from .calendar import normalize_digits

DURATION_TOKEN_RE = re.compile(r"^(\d+(?:\.\d+)?)(?:([^\W\d_]+)|([\u2300-\u27bf]+))?$", re.UNICODE)
CLOCK_RE = re.compile(r"^(\d{1,2})(?::(\d{2}))?(am|pm)?$")
RELATIVE_RE = re.compile(r"^\+(\d+)([^\W\d_\s]*)$", re.UNICODE)
RECUR_RE = re.compile(r"^(\*|every:?)(.+)$", re.IGNORECASE)
WEEKDAY_NAMES = {
    "mon": 0, "monday": 0, "tue": 1, "tues": 1, "tuesday": 1,
    "wed": 2, "weds": 2, "wednesday": 2, "thu": 3, "thur": 3, "thurs": 3, "thursday": 3,
    "fri": 4, "friday": 4, "sat": 5, "saturday": 5, "sun": 6, "sunday": 6,
    "شنبه": 5, "یکشنبه": 6, "يکشنبه": 6, "دوشنبه": 0, "سهشنبه": 1,
    "چهارشنبه": 2, "پنجشنبه": 3, "جمعه": 4,
}


# ---------------------------------------------------------------------------
# Durations
# ---------------------------------------------------------------------------
def parse_duration(token: str, pomodoro_minutes: int = 25) -> int | None:
    """Parse '1h25m', '90m', '1.5h', '2p', '45' (bare minutes) into seconds."""
    if token is None:
        return None
    if isinstance(token, (int, float)):
        return int(float(token) * 60) if float(token) < 1000 else int(token)

    text = normalize_digits(token).strip().lower().replace(",", "").replace(" ", "").replace("٬", "")
    if not text:
        return None

    # pure number => minutes
    if text.isdigit():
        return int(text) * 60

    if text in DURATION_UNITS:
        return DURATION_UNITS[text] * 1

    # compound form: sequences of <number><unit>
    compound = re.compile(r"(\d+(?:\.\d+)?)([^\W\d_\s\.]+|[\u2300-\u27bf]+)", re.UNICODE)
    matches = compound.findall(text)
    if matches:
        total = 0
        consumed = 0
        for amount, unit in matches:
            unit_key = unit.rstrip("s") if unit not in DURATION_UNITS else unit
            factor = DURATION_UNITS.get(unit) or DURATION_UNITS.get(unit_key)
            if factor is None:
                if unit in ("p", "pom", "pomo"):
                    factor = pomodoro_minutes * 60
                else:
                    return None
            total += float(amount) * factor
            consumed += len(amount) + len(unit)
        if consumed == len(text) and total > 0:
            return int(round(total))
        if total > 0:
            return int(round(total))

    match = DURATION_TOKEN_RE.match(text)
    if match and not (match.group(2) or match.group(3) or ""):
        return int(float(match.group(1)) * 60)
    return None


def parse_pomodoro_estimate(token: str, pomodoro_minutes: int = 25) -> int | None:
    """'2p' / '3pom' → number of pomodoros."""
    normalized = normalize_digits(token).strip().lower()
    match = re.match(r"^(\d+)\s*(p|pom|pomo|pomodoro|🍅|پ|پوم|پومودورو)$", normalized)
    if not match:
        return None
    return int(match.group(1))


# ---------------------------------------------------------------------------
# Clock times / relative offsets
# ---------------------------------------------------------------------------
def parse_clock(token: str, day_start_hour: int = 4) -> str | None:
    """Return 'HH:MM' for a clock token, or None."""
    text = normalize_digits(token).strip().lower()
    match = CLOCK_RE.match(text)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    meridiem = match.group(3)
    if meridiem == "pm" and hour < 12:
        hour += 12
    if meridiem == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


def parse_relative_offset(token: str, now: datetime | None = None) -> str | None:
    """'+15m' / '+2h' → absolute ISO datetime."""
    match = RELATIVE_RE.match(normalize_digits(token).strip().lower())
    if not match:
        return None
    seconds = parse_duration(match.group(1) + (match.group(2) or "m"))
    if seconds is None:
        return None
    base = now or datetime.now()
    return (base + timedelta(seconds=seconds)).replace(microsecond=0).isoformat()


def parse_when(token: str, day_start_hour: int = 4, now: datetime | None = None) -> str | None:
    """Any temporal token: '09:30', '9am', 'now', '+20m'."""
    text = normalize_digits(token).strip().lower().lstrip("@")
    if not text:
        return None
    if text in ("now", "start", "asap"):
        return (now or datetime.now()).replace(microsecond=0).isoformat()
    if text.startswith("+"):
        return parse_relative_offset(text, now)
    clock = parse_clock(text, day_start_hour)
    if clock:
        return clock
    return None


# ---------------------------------------------------------------------------
# Priority
# ---------------------------------------------------------------------------
def parse_priority(token: str) -> int | None:
    """
    Bangs form a ladder: ! low, !! medium, !!! (or more) high.
    Word aliases ("high", "med", "someday", "p2" …) work too.
    """
    text = normalize_digits(token).strip().lower()
    if text in PRIORITY_WORDS:
        return PRIORITY_WORDS[text]
    bangs = text.count("!")
    if bangs and set(text) == {"!"}:
        return min(3, bangs)
    body = text.lstrip("!")
    if body in PRIORITY_WORDS:
        return PRIORITY_WORDS[body]
    return None


# ---------------------------------------------------------------------------
# Recurrence
# ---------------------------------------------------------------------------
def parse_recurrence(token: str) -> dict[str, Any] | None:
    """
    Accepts: daily, weekdays, weekends, weekly, every:2, every_n_days:3,
    mon,wed,fri, *3d, monthly, weekdays@08:00.
    """
    text = normalize_digits(token).strip().lower().replace("\u200c", "").lstrip("*")
    text = text.replace("روزانه", "daily").replace("هرروز", "daily")
    text = text.replace("هفتگی", "weekly").replace("هفته", "weekly")
    text = text.replace("ماهانه", "monthly").replace("روزهای کاری", "weekdays")
    text = text.replace("آخرهفته", "weekends")
    if not text or text in ("none", "off", "never"):
        return None

    time_part = ""
    if "@" in text:
        text, _, time_part = text.partition("@")
        text = text.strip()
        time_part = parse_clock(time_part) or ""

    if text.startswith("every:"):
        # "every:3" → a task that reappears every 3 days.
        rest = text.split(":", 1)[1].strip()
        if rest.isdigit():
            return {"freq": "every_n_days", "interval": max(1, int(rest)), "weekdays": [], "time": ""}
        text = rest
        if text.isdigit():
            return {"freq": "every_n_days", "interval": max(1, int(text)), "weekdays": [], "time": time_part}
        if not text:
            return None
    if text in RECURRENCE_FREQS:
        rule = {"freq": text, "interval": 1, "weekdays": [0, 1, 2, 3, 4], "time": time_part}
        if text == "weekdays":
            rule["freq"] = "weekly"
            rule["weekdays"] = [0, 1, 2, 3, 4]
        if text == "weekends":
            rule["freq"] = "weekly"
            rule["weekdays"] = [5, 6]
        return rule

    match = re.match(r"^(\d+)\s*d$", text)
    if match:
        return {"freq": "every_n_days", "interval": int(match.group(1)), "weekdays": [], "time": time_part}

    match = re.match(r"^every(\d+)$", text)
    if match:
        return {"freq": "every_n_days", "interval": int(match.group(1)), "weekdays": [], "time": time_part}

    days = []
    for part in re.split(r"[,\s/|]+", text):
        part = part.strip()
        if part in WEEKDAY_NAMES:
            days.append(WEEKDAY_NAMES[part])
            continue
        if part.isdigit() and 0 <= int(part) <= 6:
            days.append(int(part))
            continue
        if part:
            days = []
            break
    if days:
        return {"freq": "weekly", "interval": 1, "weekdays": sorted(set(days)), "time": time_part}

    return None


def rule_matches_day(rule: dict[str, Any], day_index: int, anchor: int = 1, calendar_start_date: str = "") -> bool:
    """Virtual-day recurrence matcher (day_index 1 == anchor day)."""
    freq = rule.get("freq", "daily")
    interval = max(1, int(rule.get("interval", 1) or 1))
    offset = day_index - anchor

    if freq == "daily":
        return offset % interval == 0
    if freq == "every_n_days":
        return offset % interval == 0
    if freq == "weekly":
        weekdays = rule.get("weekdays") or [0, 1, 2, 3, 4]
        if interval > 1 and (offset // 7) % interval != 0:
            return False
        if calendar_start_date:
            try:
                from datetime import date, timedelta
                weekday = (date.fromisoformat(str(calendar_start_date)[:10]) + timedelta(days=day_index - 1)).weekday()
                return weekday in weekdays
            except (TypeError, ValueError, OverflowError):
                pass
        # Legacy timelines without a calendar anchor behave as if day 1 were Monday.
        return (offset % 7) in weekdays
    if freq == "monthly":
        return offset % 30 == 0
    return False


def humanize_rule(rule: dict[str, Any] | None) -> str:
    if not rule:
        return "Once"
    freq = rule.get("freq", "daily")
    interval = int(rule.get("interval", 1) or 1)
    time_part = rule.get("time") or ""
    suffix = f" @{time_part}" if time_part else ""
    if freq == "daily":
        return (f"Every {interval} days" if interval > 1 else "Every day") + suffix
    if freq == "every_n_days":
        return f"Every {interval} days" + suffix
    if freq == "monthly":
        return (f"Monthly ×{interval}" if interval > 1 else "Monthly") + suffix
    if freq == "weekly":
        names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        days = rule.get("weekdays") or [0, 1, 2, 3, 4]
        if days == [0, 1, 2, 3, 4]:
            return "Weekdays" + suffix
        if days == [5, 6]:
            return "Weekends" + suffix
        return "Every " + ", ".join(names[d] for d in days if 0 <= d <= 6) + suffix
    return "Custom" + suffix


# ---------------------------------------------------------------------------
# Master line parser
# ---------------------------------------------------------------------------
class ParseContext:
    """Everything the parser needs to resolve tags and defaults."""

    def __init__(
        self,
        aliases: dict[str, str] | None = None,
        tag_defaults: dict[str, int] | None = None,
        default_duration_minutes: int = 30,
        pomodoro_minutes: int = 25,
        day_start_hour: int = 4,
    ) -> None:
        self.aliases = {k.lower(): v for k, v in (aliases or {}).items()}
        self.tag_defaults = {k.lower(): v for k, v in (tag_defaults or {}).items()}
        self.default_duration_minutes = default_duration_minutes
        self.pomodoro_minutes = pomodoro_minutes
        self.day_start_hour = day_start_hour

    def resolve_tag(self, raw: str) -> tuple[str, bool, str]:
        """
        Resolve a typed tag token against known aliases.
        Returns (canonical_tag, was_alias, typed_token).
        """
        token = str(raw or "").strip().lstrip("#").lower()
        if not token:
            return "", False, ""
        if token in self.aliases:
            return self.aliases[token], token != self.aliases[token], token
        return token, False, token


def parse_line(line: str, ctx: ParseContext) -> dict[str, Any]:
    """
    Parse one quick-add line.
    Returns dict with keys: ok, error, title, tag, tag_token, tag_alias,
    priority, seconds, scheduled_at, recurrence, subtasks, notes, pinned, raw
    """
    raw = line
    result: dict[str, Any] = {
        "ok": False,
        "error": "",
        "raw": raw,
        "title": "",
        "tag": "",
        "tag_token": "",
        "tag_alias": False,
        "priority": 0,
        "seconds": None,
        "scheduled_at": "",
        "recurrence": None,
        "subtasks": [],
        "notes": "",
        "pinned": False,
        "explicit_duration": False,
    }

    text = (line or "").strip()
    if not text:
        result["error"] = "Empty line"
        return result

    # inline note takes everything after '>' on the line
    if ">" in text:
        text, _, note = text.partition(">")
        note = note.strip()
        # A pin marker that landed inside the note still pins the task.
        if note.endswith("^"):
            result["pinned"] = True
            note = note[:-1].strip()
        result["notes"] = note
        text = text.strip()

    tokens = text.split()
    title_tokens: list[str] = []
    tag_found = False
    # After a "+subtask" token, following plain words keep extending that
    # subtask ("+pay online" → "pay online") until the next marker appears.
    open_subtask: int | None = None

    for index, token in enumerate(tokens):
        stripped = token.strip()
        lower = normalize_digits(stripped).lower()
        is_last = index == len(tokens) - 1

        if not stripped:
            continue

        if stripped == "^":
            result["pinned"] = True
            continue

        if stripped.startswith("#") and len(stripped) > 1:
            canonical, was_alias, typed = ctx.resolve_tag(stripped)
            if not tag_found:
                result["tag"] = canonical
                result["tag_token"] = typed
                result["tag_alias"] = was_alias
                tag_found = True
                continue
            # a second #tag becomes a plain word (keeps titles readable)
            title_tokens.append(stripped)
            continue

        if stripped.startswith("+") and len(stripped) > 1:
            result["subtasks"].append(stripped[1:].replace("-", " ").strip())
            open_subtask = len(result["subtasks"]) - 1
            continue

        if stripped.startswith("@"):
            when = parse_when(stripped, ctx.day_start_hour)
            if when:
                result["scheduled_at"] = when
                continue
            title_tokens.append(stripped)
            continue

        if stripped.startswith("~") or stripped.startswith("="):
            body = stripped[1:]
            pomos = parse_pomodoro_estimate(body, ctx.pomodoro_minutes)
            if pomos:
                result["seconds"] = pomos * ctx.pomodoro_minutes * 60
                result["explicit_duration"] = True
                continue
            seconds = parse_duration(body, ctx.pomodoro_minutes)
            if seconds:
                result["seconds"] = seconds
                result["explicit_duration"] = True
                continue
            title_tokens.append(stripped)
            continue

        # Priority is only recognised in explicit forms — "!", "!!", "!!!",
        # "!high", or "p2" — so ordinary words like "low" stay in the title.
        is_priority_token = stripped.startswith("!") or re.match(r"^p[0-3]$", lower) is not None
        if is_priority_token:
            priority = parse_priority(stripped)
            if priority is not None:
                result["priority"] = priority
                continue
            title_tokens.append(stripped)
            continue

        if stripped.startswith("*") and len(stripped) > 1:
            rule = parse_recurrence(stripped)
            if rule:
                result["recurrence"] = rule
                continue
            title_tokens.append(stripped)
            continue

        if lower.startswith("every:"):
            rule = parse_recurrence(lower)
            if rule:
                result["recurrence"] = rule
                continue

        if is_last and result["seconds"] is None:
            seconds = parse_duration(stripped, ctx.pomodoro_minutes)
            if seconds:
                result["seconds"] = seconds
                result["explicit_duration"] = True
                continue

        # A unit-bearing duration may appear anywhere ("Deep work #w 90m @09:30").
        # Bare numbers are only honoured as the final token so that titles like
        # "Call 3 people" survive untouched.
        if open_subtask is not None and index > 0:
            result["subtasks"][open_subtask] = (
                result["subtasks"][open_subtask] + " " + stripped
            ).strip()
            continue

        if result["seconds"] is None and re.match(r"^\d+(?:\.\d+)?[^\W\d_\s]+$", normalize_digits(stripped), re.UNICODE):
            seconds = parse_duration(stripped, ctx.pomodoro_minutes)
            if seconds:
                result["seconds"] = seconds
                result["explicit_duration"] = True
                continue

        title_tokens.append(stripped)

    title = " ".join(title_tokens).strip(" -–—")
    if not title:
        result["error"] = "No task title found"
        return result

    result["title"] = title
    if result["seconds"] is None:
        if not result["explicit_duration"]:
            tag_default = ctx.tag_defaults.get(result["tag"], 0)
            if tag_default:
                result["seconds"] = tag_default * 60
            else:
                result["seconds"] = ctx.default_duration_minutes * 60
    result["ok"] = bool(result["title"])
    return result


def parse_bulk(text: str, ctx: ParseContext) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """
    Parse a multi-line block. Lines starting with whitespace or '-' are
    treated as subtasks of the previous task.
    Returns (good, bad).
    """
    good: list[dict[str, Any]] = []
    bad: list[dict[str, Any]] = []
    for raw_line in (text or "").splitlines():
        if not raw_line.strip():
            continue
        is_child = raw_line[:1].isspace() or raw_line.lstrip().startswith(("-", "*", "+"))
        line = raw_line.strip().lstrip("-").strip() if is_child else raw_line.strip()
        if not line:
            continue
        if is_child and good:
            child = line.lstrip("+").strip()
            if child:
                good[-1]["subtasks"].append(child)
            continue
        parsed = parse_line(line, ctx)
        if parsed["ok"]:
            good.append(parsed)
        else:
            bad.append({"line": raw_line, "reason": parsed["error"]})
    return good, bad


def describe_parse(parsed: dict[str, Any]) -> list[dict[str, str]]:
    """Human-readable breakdown rendered by the live quick-add preview."""
    chips: list[dict[str, str]] = []
    if parsed.get("tag"):
        label = f"#{parsed['tag']}"
        if parsed.get("tag_alias"):
            label += f"  (from #{parsed['tag_token']})"
        chips.append({"kind": "tag", "text": label})
    if parsed.get("seconds"):
        chips.append({"kind": "time", "text": humanize_seconds(parsed["seconds"])})
    if parsed.get("priority"):
        names = {1: "Low", 2: "Medium", 3: "High"}
        chips.append({"kind": "priority", "text": names.get(parsed["priority"], "None")})
    if parsed.get("scheduled_at"):
        chips.append({"kind": "schedule", "text": parsed["scheduled_at"].replace("T", " ")})
    if parsed.get("recurrence"):
        chips.append({"kind": "recur", "text": humanize_rule(parsed["recurrence"])})
    if parsed.get("subtasks"):
        chips.append({"kind": "sub", "text": f"{len(parsed['subtasks'])} subtask(s)"})
    if parsed.get("notes"):
        chips.append({"kind": "note", "text": "note"})
    if parsed.get("pinned"):
        chips.append({"kind": "pin", "text": "pinned"})
    return chips


def humanize_seconds(seconds: int) -> str:
    seconds = int(seconds or 0)
    hours, rem = divmod(seconds, 3600)
    minutes = rem // 60
    if hours and minutes:
        return f"{hours}h {minutes}m"
    if hours:
        return f"{hours}h"
    if minutes:
        return f"{minutes}m"
    return f"{seconds}s"


# ---------------------------------------------------------------------------
# Natural-language "when" helpers used for reminder suggestions
# ---------------------------------------------------------------------------
def next_occurrence_after(rule: dict[str, Any], from_day: int, anchor: int = 1, horizon: int = 400) -> int:
    for offset in range(1, horizon + 1):
        if rule_matches_day(rule, from_day + offset, anchor):
            return from_day + offset
    return from_day + 1


def rule_to_human_short(rule: dict[str, Any] | None) -> str:
    if not rule:
        return ""
    text = humanize_rule(rule)
    return text.replace("Every day", "daily")
