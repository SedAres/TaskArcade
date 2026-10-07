# TaskArcade V1.0

**Make time visible.** TaskArcade is a local-first planner that combines virtual-day planning, an editable task timeline, a focus timer, useful analytics, and a flexible interface. It is designed for English and Persian users, with a complete right-to-left Persian experience and a Solar Hijri (Jalali/Shamsi) calendar.

> **Your work stays yours:** TaskArcade stores its data in a local SQLite database. It does not require an account or a hosted service. Make a backup before moving or replacing the database.

## Start here

Requirements: Python 3.10 or newer.

```bash
cd V1.0
python -m venv .venv

# macOS / Linux
. .venv/bin/activate

# Windows PowerShell
# .venv\Scripts\Activate.ps1

python -m pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:2231>. To choose another port, set `PORT` before starting the app, for example `PORT=8080 python app.py` (PowerShell: `$env:PORT=8080; python app.py`). The application binds to all interfaces for container and local-network previews; it is intended for a trusted, private environment. It does not provide user accounts or authentication, so do not expose it directly to the public internet.

The first run creates `V1.0/data/taskarcade.db`, seeds starter tags and templates, and adds a small sample plan. The database, virtual environment, Python caches, and test artifacts are excluded from version control. Use **Settings → Data & backup** to export a portable backup and CSV files.

## The first few minutes

1. Choose **English** or **فارسی** in **Settings → Language & calendar**. Persian switches the whole interface to right-to-left and selects the Solar Hijri calendar and Persian numerals by default. Language, calendar, digits, and typeface remain independently adjustable.
2. Set the real date for **virtual day 1**. TaskArcade then gives each virtual day a Gregorian or Jalali date without moving or renumbering your tasks.
3. Open **Plan** and add a task. You can use ordinary Persian or English titles, or add quick-entry details such as a tag, estimate, priority, schedule, note, repeat rule, or subtasks.
4. Open **Routines** to make a reusable sequence or choose **Try a starter**. Start it to use the mobile-first runner, which keeps the current step, countdown, progress, and next step together.
5. Select a task in **Now** or **Focus** and start a focus interval. Task estimates, elapsed task time, and focus-session time are separate measures.
6. Visit **Insights** to compare periods, review trends, and open a past day. Past tasks, elapsed time, sessions, and journal details can be corrected.

The **Help & user guide** button in Settings opens a fuller bilingual guide covering planning, routines, the focus timer, analytics, history, Jalali dates, backups, keyboard shortcuts, and touch gestures.

## English and Persian, thoughtfully

Persian mode is a full locale, not only a direction switch. It updates page direction and language metadata, lays out controls from the right, formats labels and numbers, and keeps mixed-language content readable. Task titles, notes, tag names, aliases, template names, and other user-authored text are preserved as entered.

Settings provide four Persian typeface choices—Vazirmatn, Estedad, Noto Naskh Arabic, and Sahel. Their font files ship with TaskArcade, are served locally, and are included in the offline app cache; the choices work even when a typeface is not installed on the device. No font CDN or third-party font request is used. Persian digits can follow the language, or be selected explicitly as Persian or Latin. Font sources and OFL licenses are documented in `V1.0/static/fonts/README.md`.

### Calendar and time zone

- Choose **Follow language**, **Solar Hijri (Jalali/Shamsi)**, or **Gregorian** independently of the interface language.
- Set the date assigned to virtual day 1 in the selected calendar. Modern Persian dates such as `۱۴۰۵/۰۱/۰۱` are accepted; the database keeps a stable Gregorian anchor.
- Set an IANA time zone such as `Asia/Tehran` for local session-time display, scheduling, and best-focus-hour analytics. Leave the field blank to use the device/server's local zone.
- The Jalali calendar conversion works locally and does not depend on browser locale data or a remote service.

### Routine runner

Starting a routine opens a dedicated full-page runner with the current step, timer, progress and step sequence kept in view. A timer reaching zero never advances the run: choose **Complete step**, **Skip step**, or **Move to end** explicitly. Reorder saved steps by dragging their visible handles on desktop or touch devices, or use the arrow controls.

The **Settings → Timer → Advanced routine runner** area has four optional controls. They tune runner feedback only; they never edit saved step lists:

1. **Play a step chime** — play a short tone generated locally by the browser when a step changes.
2. **Vibrate on step change** — request a brief haptic cue on phones and browsers that support vibration.
3. **Keep the screen awake** — request a browser screen wake lock while the routine is running; this may use more battery and is unavailable in some browsers.
4. **Show the next step** — keep a preview visible so you can prepare without leaving the current step.

Language, calendar, virtual-day anchor, time zone, numeral style, and Persian typeface remain independently configurable under Settings. All four bundled Persian typefaces are available offline.

## Five color themes, eight practical designs

TaskArcade keeps its appearance system separate from its layout system. Choose any palette, choose light or dark mode, then pick one of eight designs. Changing a palette never changes the design. Every design is structurally distinct, touch-friendly, and adapts to a phone.

**The five palettes** are Lumen, Midnight, Slate, Zen Paper, and Harbor. Each has a light and a dark scheme. Advanced appearance settings include density, accent color, text size, corner radius, motion, translucency, and contrast; reduced-motion preferences are respected.

| Design | What changes |
| --- | --- |
| **Agenda** | Schedule-aware ordering with a clear day-by-day agenda. |
| **Board** | Separate day lanes that can be scanned or rearranged. |
| **Week map** | Seven day columns with task counts and completion progress. |
| **Cards** | A comfortable card gallery with tag color and progress visible. |
| **Compact** | A denser, readable information table. |
| **Flow** | A connected sequence that makes task order explicit. |
| **Focus first** | One primary task and a quieter queue of what follows. |
| **Reading flow** | A text-led, low-noise timeline. |

The previews are available in **Theme Studio**. Select one of the eight designs independently of the five palettes.

## Planning and customization

### Quick-add notation

The notation is optional—ordinary Persian or English task titles are fine. Examples:

```text
Prepare report #work 90m !! @09:30
Review notes #study ~2p
Walk outside *weekdays +fill bottle
Plan the trip >compare train times ^
```

| Marker | Meaning |
| --- | --- |
| `#tag` | Choose or create a tag; aliases are customizable (`#w` resolves to `#work` by default). |
| `25m`, `1h`, `۹۰ دقیقه` | Set an estimate; Persian and Arabic-Indic digits are supported. |
| `!`, `!!`, `!!!` | Low, medium, or high priority. |
| `@09:30` | Set a scheduled time. |
| `~2p` | Estimate two Pomodoro focus cycles. |
| `*weekdays` | Add a repeat rule. |
| `+subtask` | Add a subtask. |
| `>note` | Add a note. |
| `^` | Pin the task. |

Manage tag names, display labels, colours, aliases, and default durations under **Library → Tags & aliases**. Templates, recurring rules, sorting, grouping, carry-over behavior, daily capacity, WIP limits, focus goals, timer presets, reminders, and undo history are also customizable.

### Reusable routines and the step runner

Create a routine with a name, description, accent, and ordered steps. Each step can have its own title, emoji, note, and duration (1 minute to 4 hours); use the accessible up/down controls to reorder steps. The editor remains available after saving, so routines can change as your process evolves. A run keeps a snapshot of the steps it started with, so editing the definition does not unexpectedly rewrite a routine already in progress.

Starting a routine opens the guided runner. It shows the current step and its live countdown, the next step, total time remaining, and progress through the whole sequence. Pause and resume the run, complete or skip a step, or stop the routine and return to it later. Run history keeps completed and stopped attempts. The runner remains readable on narrow screens and respects the app’s English/Persian direction and Jalali day labels.

### Elapsed task time vs focus sessions

A task estimate is a planning target. **Elapsed time** is the amount of time recorded against that task, and can be edited directly in the task editor (including for a completed task). The five-minute buttons are a quick adjustment. **Focus sessions** are a separate log of timed work; editing a session updates session and task focus totals. This distinction makes historical corrections and analytics more honest.

## Insights and historical records

Insights supports 7-day, 30-day, 90-day, annual, and all-history ranges. It reports task completion, planned and elapsed time, focused time, estimate accuracy, goal days, session consistency, day-by-day activity, tag distribution, weekday patterns, best focus hours, and change from the preceding period. Empty days remain in the daily series so quiet days are not silently omitted from averages.

Select a point or day in the historical list to open its record. You can update the day's note, mood, and capacity; add or edit a task; correct elapsed time, estimates, tags, priorities, and subtasks; or edit, move, and delete a focus session. Changes are undoable and refresh the related summaries. Totals are derived from their source tasks and sessions rather than being manually overwritten.

## Keyboard, touch, and accessibility

- Press **?** for keyboard shortcuts; press **Ctrl/⌘ K** to search tasks, tags, themes, or commands.
- On touch screens, swipe right on a task to complete it, swipe left to defer it, and long-press for task actions. Drag handles reorder tasks; pull down on **Now** to refresh.
- Layouts adapt to narrow screens. Settings panes have their own scrollable body, including on mobile.
- Prefer less motion? TaskArcade follows the device's reduced-motion preference and also provides an in-app motion control.

## Data, backups, and privacy

The main database is `V1.0/data/taskarcade.db`. Export a full JSON backup before importing or resetting data. CSV exports are available for spreadsheet workflows. Backups may contain task titles, notes, and other personal information; store them accordingly. Restoring a backup supports merge and replace modes, and changes participate in undo history where applicable.

The app is local-first and has no sign-in or authentication layer. Use it on a trusted machine or behind a properly configured private access layer; do not make the development server publicly accessible.

## Development and tests

```bash
cd V1.0
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
node tests/test_i18n.mjs
```

The API tests use a temporary database. They cover task editing, editable history, tag aliases, settings validation, Jalali date conversion, time-zone-aware analytics, backups, routine CRUD and run progress, and the five-palette/eight-design registry. For a quick health check, open `/api/health`; the application also serves static assets and the offline web-app manifest.

## Technical notes

- **Backend:** Flask, Python standard library, and SQLite.
- **Frontend:** semantic HTML, CSS, and JavaScript ES modules; no frontend build step is required.
- **Projects:** group tasks by outcome, track progress, and keep project data in exports and backups.
- **Calendar:** local Gregorian/Solar Hijri conversion with a stable ISO database anchor.
- **Local data:** `V1.0/data/` (ignored by Git).
- **Main entry point:** `V1.0/app.py`.
- **In-app guide:** Settings → **Help & user guide**.

---

## راهنمای کوتاه فارسی

تسک‌آرکید برنامه‌ای محلی برای برنامه‌ریزی روزها، زمان‌سنج تمرکز، گزارش‌گیری و اصلاح اطلاعات گذشته است. برای آغاز، پوشهٔ `V1.0` را باز کنید، محیط مجازی پایتون بسازید، وابستگی‌های فایل `requirements.txt` را نصب کنید و `python app.py` را اجرا کنید. سپس نشانی `http://127.0.0.1:2231` را در مرورگر باز کنید.

در **تنظیمات ← زبان و تقویم** می‌توانید فارسی را انتخاب کنید تا رابط راست‌به‌چپ و تقویم شمسی فعال شود. تقویم، رقم‌ها، قلم فارسی، تاریخ روز مجازی نخست و منطقهٔ زمانی هرکدام جداگانه قابل تنظیم‌اند. چهار قلم وزیرمتن، استعداد، نسخ نوتو و ساحل همراه برنامه هستند و بدون ارتباط با سرویس بیرونی به‌صورت آفلاین کار می‌کنند؛ مجوزها و مبدأ قلم‌ها در `V1.0/static/fonts/README.md` آمده است. از **تنظیمات ← راهنما و راهنمای کاربر** نیز به راهنمای کامل فارسی و انگلیسی دسترسی دارید.

وظایف را در نمای «برنامه‌ریزی» بیفزایید و با نشانه‌هایی مثل `#w` برای برچسب، `۹۰ دقیقه` برای برآورد، `!!` برای اولویت یا `@09:30` برای ساعت انجام، ورود سریع را ساده کنید. `#w` به‌طور پیش‌فرض به `#work` اشاره می‌کند و نام‌های کوتاه در کتابخانه قابل تغییرند. زمان سپری‌شدهٔ وظیفه از زمان جلسه‌های تمرکز جداست و هر دو در سابقهٔ روزهای گذشته قابل ویرایش‌اند.

در بخش «روال‌ها» توالی‌های قابل استفادهٔ دوباره بسازید؛ هر گام عنوان، مدت، یادداشت و ایموجی خودش را دارد و ترتیبش قابل ویرایش است. اجراکنندهٔ تمام‌صفحه، زمان‌سنج، گام جاری و پیشرفت کل را نشان می‌دهد. زمان‌سنج هرگز خودکار به گام بعد نمی‌رود؛ خودتان «تکمیل گام»، «ردکردن گام» یا «انتقال به انتها» را انتخاب می‌کنید. گام‌ها را در رایانه یا تلفن با دستگیرهٔ کشیدن جابه‌جا کنید. چهار گزینهٔ پیشرفتهٔ آن در «تنظیمات ← زمان‌سنج» قرار دارند: آوای گام، لرزش، روشن نگه‌داشتن صفحه و نمایش پیش‌نمایش گام بعد.

استودیوی ظاهر پنج پالت رنگی دارد: Lumen، Midnight، Slate، Zen Paper و Harbor؛ هرکدام در حالت روشن و تیره در دسترس‌اند. هشت طرح چیدمان نیز مستقل‌اند: برنامهٔ روزانه، برد، نمای هفتگی، کارت‌ها، فشرده، مسیر گام‌به‌گام، تمرکز بر کار جاری و نمای متنی. انتخاب رنگ، طرح را عوض نمی‌کند.

اطلاعات برنامه در پایگاه دادهٔ محلی `V1.0/data/taskarcade.db` نگهداری می‌شود. برای ایمنی، از بخش **داده‌ها و نسخهٔ پشتیبان** خروجی پشتیبان بگیرید و آن را در جای امن نگهداری کنید.
