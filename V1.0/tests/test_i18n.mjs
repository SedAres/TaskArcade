import assert from "node:assert/strict";

const root = {
  dataset: {},
  style: {
    setProperty() {},
    removeProperty() {},
  },
};

globalThis.document = {
  documentElement: root,
  querySelectorAll: () => [],
  title: "",
};

const { applyLocale, t } = await import("../static/js/i18n.js");
applyLocale({ language: "fa", calendar_system: "auto", digit_style: "auto", persian_font: "vazirmatn" }, { notify: false });

assert.equal(t("Day 4"), "روز ۴");
assert.equal(t("Every 3 days"), "هر ۳ روز");
assert.equal(t("in 25m"), "تا ۲۵ دقیقه دیگر");
assert.equal(t("layout: console"), "چیدمان: کنسول");
assert.equal(t("Midnight applied"), "پوستهٔ نیمه‌شب اعمال شد");
assert.equal(t("Added “Focus” as #Work"), "«Focus» با برچسب #Work افزوده شد");
assert.equal(t("“Plan” done"), "«Plan» انجام شد");
assert.equal(t("Focus logged: 25m"), "جلسهٔ تمرکز ثبت شد: ۲۵ دقیقه");
assert.equal(t("Read book — تا ۲۵ دقیقه دیگر"), "یادآوری برای «Read book»: تا ۲۵ دقیقه دیگر");
assert.equal(t("Added 2 tasks to Day 4"), "۲ وظیفه به روز ۴ افزوده شد");
assert.equal(t("All four typefaces are bundled and load locally when selected. No external font service is contacted."), "هر چهار قلم همراه برنامه هستند و هنگام انتخاب از همین دستگاه بارگذاری می‌شوند؛ هیچ درخواستی به سرویس قلم بیرونی فرستاده نمی‌شود.");
assert.equal(t("No tasks for this day"), "برای این روز وظیفه‌ای ندارید");
assert.equal(t("#t"), "#t");

console.log("Persian locale patterns and user-authored names passed.");
