/*
 * Dependency-free Gregorian / Solar Hijri calendar arithmetic.
 * The day-index timeline stores an ISO Gregorian anchor and displays either
 * calendar from this module. Conversion is deterministic and works offline.
 */

export function normalizeDigits(value) {
  const map = {
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "٫": ".", "٬": ",", "／": "/", "−": "-",
  };
  return String(value ?? "").replace(/[۰-۹٠-٩٫٬／−]/g, (char) => map[char] || char);
}

export function toPersianDigits(value) {
  return String(value ?? "").replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}

function rawJalaliToGregorian(jy, jm, jd) {
  let gy;
  if (jy > 979) {
    gy = 1600;
    jy -= 979;
  } else {
    gy = 621;
  }
  let days = 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + 78 + jd;
  if (jm < 7) days += (jm - 1) * 31;
  else days += 186 + (jm - 7) * 30;

  gy += 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor((days - 1) / 36524);
    days = (days - 1) % 36524;
    if (days >= 365) days += 1;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = gy % 4 === 0 && (gy % 100 !== 0 || gy % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  for (const length of monthDays) {
    if (gd <= length) break;
    gd -= length;
    gm += 1;
  }
  return { year: gy, month: gm, day: gd };
}

export function isJalaliLeap(year) {
  const start = rawJalaliToGregorian(year, 1, 1);
  const next = rawJalaliToGregorian(year + 1, 1, 1);
  const utc = (value) => Date.UTC(value.year, value.month - 1, value.day);
  return Math.round((utc(next) - utc(start)) / 86400000) === 366;
}

export function jalaliMonthLength(year, month) {
  const m = Number(month);
  if (m < 1 || m > 12) throw new RangeError("Jalali month must be 1–12");
  if (m <= 6) return 31;
  if (m <= 11) return 30;
  return isJalaliLeap(Number(year)) ? 30 : 29;
}

export function jalaliToGregorian(year, month, day) {
  const jy = Number(year), jm = Number(month), jd = Number(day);
  if (!Number.isInteger(jy) || jy < 1 || jy > 3177) throw new RangeError("Unsupported Jalali year");
  if (!Number.isInteger(jm) || jm < 1 || jm > 12) throw new RangeError("Jalali month must be 1–12");
  if (!Number.isInteger(jd) || jd < 1 || jd > jalaliMonthLength(jy, jm)) throw new RangeError("Invalid Jalali day");
  return rawJalaliToGregorian(jy, jm, jd);
}

export function gregorianToJalali(year, month, day) {
  const gyInput = Number(year), gm = Number(month), gd = Number(day);
  const check = new Date(Date.UTC(gyInput, gm - 1, gd));
  if (!Number.isFinite(check.getTime()) || check.getUTCFullYear() !== gyInput || check.getUTCMonth() !== gm - 1 || check.getUTCDate() !== gd) {
    throw new RangeError("Invalid Gregorian date");
  }
  let gy = gyInput;
  let jy;
  const monthDaysBefore = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  if (gy > 1600) {
    jy = 979;
    gy -= 1600;
  } else {
    jy = 0;
    gy -= 621;
  }
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy
    + Math.floor((gy2 + 3) / 4)
    - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400)
    - 80 + gd + monthDaysBefore[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let jm, jd;
  if (days < 186) {
    jm = 1 + Math.floor(days / 31);
    jd = 1 + (days % 31);
  } else {
    jm = 7 + Math.floor((days - 186) / 30);
    jd = 1 + ((days - 186) % 30);
  }
  return { year: jy, month: jm, day: jd };
}

export function parseCalendarDate(value, system = "auto") {
  const raw = normalizeDigits(value).trim().replace(/\u200c/g, "");
  const match = raw.match(/^(\d{1,4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) throw new RangeError("Enter a date as YYYY/MM/DD or YYYY-MM-DD");
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const mode = String(system || "auto").toLowerCase();
  const isJalali = ["jalali", "shamsi", "persian"].includes(mode) || (mode === "auto" && year >= 1200 && year <= 1600);
  if (isJalali) {
    const converted = jalaliToGregorian(year, month, day);
    return isoFromParts(converted.year, converted.month, converted.day);
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(check.getTime()) || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError("Invalid Gregorian date");
  }
  return isoFromParts(year, month, day);
}

function isoFromParts(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isoParts(value) {
  const match = String(value ?? "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new RangeError("Expected an ISO Gregorian date");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function addIsoDays(value, amount) {
  const { year, month, day } = isoParts(value);
  const date = new Date(Date.UTC(year, month - 1, day + Number(amount || 0)));
  return isoFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function isoDayDifference(left, right) {
  const a = isoParts(left), b = isoParts(right);
  return Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86400000);
}

export function calendarSystem(settings = {}) {
  const selected = String(settings.calendar_system || "auto");
  if (selected !== "auto") return selected;
  return settings.language === "fa" ? "jalali" : "gregorian";
}

export function datePartsForSystem(isoDate, system = "gregorian") {
  const { year, month, day } = isoParts(isoDate);
  return ["jalali", "shamsi", "persian"].includes(system)
    ? Object.values(gregorianToJalali(year, month, day))
    : [year, month, day];
}

export function formatCalendarDate(isoDate, system = "gregorian", { digits = "latin", separator = "/" } = {}) {
  const [year, month, day] = datePartsForSystem(isoDate, system);
  const value = `${String(year).padStart(4, "0")}${separator}${String(month).padStart(2, "0")}${separator}${String(day).padStart(2, "0")}`;
  return digits === "persian" ? toPersianDigits(value) : value;
}

export function monthParts(isoDate, system = "gregorian") {
  const parts = datePartsForSystem(isoDate, system);
  return { year: parts[0], month: parts[1], day: parts[2] };
}

export function monthLength(year, month, system = "gregorian") {
  if (["jalali", "shamsi", "persian"].includes(system)) return jalaliMonthLength(year, month);
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

export function monthStartIso(year, month, system = "gregorian") {
  const parts = system === "jalali"
    ? jalaliToGregorian(year, month, 1)
    : { year: Number(year), month: Number(month), day: 1 };
  return isoFromParts(parts.year, parts.month, parts.day);
}

export function addCalendarMonths(year, month, delta, system = "gregorian") {
  let y = Number(year), m = Number(month) + Number(delta);
  while (m < 1) { y -= 1; m += 12; }
  while (m > 12) { y += 1; m -= 12; }
  return { year: y, month: m };
}
