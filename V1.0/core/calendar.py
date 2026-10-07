"""Calendar helpers for Gregorian and Solar Hijri (Jalali/Shamsi) dates.

The application stores a stable Gregorian ISO anchor and virtual day numbers.
Keeping conversion in this small stdlib-only module makes the calendar reliable
in offline installations and avoids locale data differences between hosts.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

_PERSIAN_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


def normalize_digits(value: Any) -> str:
    """Convert Persian/Arabic-Indic digits and decimal separators to ASCII."""
    return str(value if value is not None else "").translate(_PERSIAN_DIGITS).replace("٫", ".").replace("٬", ",")


def _gregorian_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _jalali_leap(year: int) -> bool:
    """Return whether a Solar Hijri year has 366 days."""
    first = jalali_to_gregorian(year, 1, 1)
    following = jalali_to_gregorian(year + 1, 1, 1)
    return (following - first).days == 366


def jalali_month_length(year: int, month: int) -> int:
    if not 1 <= month <= 12:
        raise ValueError("Jalali month must be between 1 and 12")
    if month <= 6:
        return 31
    if month <= 11:
        return 30
    return 30 if _jalali_leap(year) else 29


def gregorian_to_jalali(gy: int, gm: int, gd: int) -> tuple[int, int, int]:
    """Convert a Gregorian date to (Jalali year, month, day)."""
    date(gy, gm, gd)  # validate the Gregorian input
    g_month_days = (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)
    if gy > 1600:
        jy = 979
        gy -= 1600
    else:
        jy = 0
        gy -= 621
    gy2 = gy + 1 if gm > 2 else gy
    days = (
        365 * gy
        + (gy2 + 3) // 4
        - (gy2 + 99) // 100
        + (gy2 + 399) // 400
        - 80
        + gd
        + g_month_days[gm - 1]
    )
    jy += 33 * (days // 12053)
    days %= 12053
    jy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        jy += (days - 1) // 365
        days = (days - 1) % 365
    if days < 186:
        jm = 1 + days // 31
        jd = 1 + days % 31
    else:
        jm = 7 + (days - 186) // 30
        jd = 1 + (days - 186) % 30
    return jy, jm, jd


def jalali_to_gregorian(jy: int, jm: int, jd: int) -> date:
    """Convert a Solar Hijri date to a Gregorian ``date``."""
    if jy < 1 or jy > 3177:
        raise ValueError("Jalali year is outside the supported range")
    if not 1 <= jm <= 12:
        raise ValueError("Jalali month must be between 1 and 12")
    if not 1 <= jd <= jalali_month_length(jy, jm):
        raise ValueError("Jalali day is not valid for this month")

    if jy > 979:
        gy = 1600
        jy -= 979
    else:
        gy = 621

    days = 365 * jy + (jy // 33) * 8 + ((jy % 33 + 3) // 4) + 78 + jd
    if jm < 7:
        days += (jm - 1) * 31
    else:
        days += 186 + (jm - 7) * 30

    gy += 400 * (days // 146097)
    days %= 146097
    if days > 36524:
        gy += 100 * ((days - 1) // 36524)
        days = (days - 1) % 36524
        if days >= 365:
            days += 1
    gy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        gy += (days - 1) // 365
        days = (days - 1) % 365
    gd = days + 1

    month_lengths = (31, 29 if _gregorian_leap(gy) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    gm = 1
    for length in month_lengths:
        if gd <= length:
            break
        gd -= length
        gm += 1
    return date(gy, gm, gd)


def parse_calendar_date(value: Any, system: str = "auto") -> date:
    """Parse ISO Gregorian or slash/dash-separated Jalali dates.

    In ``auto`` mode, years from 1200 through 1600 are treated as Jalali; this
    is intentionally unambiguous for modern productivity dates. Farsi digits
    and both Arabic/Persian date separators are accepted.
    """
    raw = normalize_digits(value).strip().replace("／", "/").replace("−", "-")
    match = re.fullmatch(r"(\d{1,4})[-/](\d{1,2})[-/](\d{1,2})", raw)
    if not match:
        raise ValueError("Enter a date as YYYY-MM-DD or YYYY/MM/DD")
    year, month, day = map(int, match.groups())
    mode = str(system or "auto").lower()
    jalali = mode in {"jalali", "shamsi", "persian"} or (mode == "auto" and 1200 <= year <= 1600)
    if jalali:
        return jalali_to_gregorian(year, month, day)
    return date(year, month, day)


def iso_date(value: Any, system: str = "gregorian") -> str:
    return parse_calendar_date(value, system).isoformat()


def date_for_day(anchor_iso: str, day_index: int) -> date:
    """Resolve virtual day 1 + an ISO anchor to a real Gregorian date."""
    anchor = date.fromisoformat(str(anchor_iso)[:10])
    return anchor + timedelta(days=max(1, int(day_index or 1)) - 1)


def date_for_system(value: date, system: str = "gregorian") -> tuple[int, int, int]:
    if str(system).lower() in {"jalali", "shamsi", "persian"}:
        return gregorian_to_jalali(value.year, value.month, value.day)
    return value.year, value.month, value.day


def format_date(value: date, system: str = "gregorian", separator: str = "/") -> str:
    year, month, day = date_for_system(value, system)
    return f"{year:04d}{separator}{month:02d}{separator}{day:02d}"


def calendar_payload(settings: dict[str, Any]) -> dict[str, Any]:
    """Small JSON-safe calendar context for clients and integrations."""
    start = str(settings.get("calendar_start_date") or "")[:10]
    current = max(1, int(settings.get("current_day_index", 1) or 1))
    out: dict[str, Any] = {
        "language": settings.get("language", "en"),
        "system": settings.get("calendar_system", "auto"),
        "start_date": start,
        "current_day_index": current,
        "timezone": settings.get("timezone", ""),
    }
    if start:
        try:
            current_date = date_for_day(start, current)
            out["current_gregorian"] = current_date.isoformat()
            out["current_jalali"] = format_date(current_date, "jalali")
        except (TypeError, ValueError, OverflowError):
            out["current_gregorian"] = ""
            out["current_jalali"] = ""
    return out
