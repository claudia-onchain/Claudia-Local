/**
 * cron.js — when a task runs. Three ways to write it, all in this computer's local time:
 *
 *   cron            standard 5 fields: minute hour day-of-month month day-of-week
 *                   (* , - / ; month and day names like jan or mon; 0 and 7 are Sunday;
 *                   when both day fields are set, either one matching is enough, as in cron)
 *   every N         "every 30 minutes", "every 2 hours", "every day", "hourly"
 *   daily at        "daily at 09:00", "every day at 7pm", "weekdays at 08:30"
 *
 * parseSchedule(text) → { kind, text, label, next(fromMs) } or throws an Error with status 400.
 * Runs are at least 5 minutes apart.
 */

const MIN = 60_000;
export const MIN_GAP_MS = 5 * MIN;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, offset: 0 },
];

function value(s, f) {
  const t = s.toLowerCase();
  if (f.names) { const i = f.names.indexOf(t.slice(0, 3)); if (i >= 0 && /^[a-z]+$/.test(t)) return i + f.offset; }
  if (!/^\d{1,2}$/.test(t)) throw bad(`"${s}" isn't a valid ${f.name}.`);
  const n = Number(t);
  if (n < f.min || n > f.max) throw bad(`The ${f.name} must be between ${f.min} and ${f.max}.`);
  return n;
}

/** One cron field → a Set of allowed numbers (and whether it was "*"). */
function field(src, f) {
  const out = new Set();
  for (const part of src.split(",")) {
    const m = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw bad(`"${part}" isn't a valid ${f.name}.`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw bad(`The step in "${part}" must be 1 or more.`);
    let lo, hi;
    if (m[1] === "*") { lo = f.min; hi = f.max === 7 ? 6 : f.max; }
    else if (m[1].includes("-")) { const [a, b] = m[1].split("-"); lo = value(a, f); hi = value(b, f); if (hi < lo) throw bad(`"${part}" goes backwards.`); }
    else { lo = value(m[1], f); hi = m[2] ? (f.max === 7 ? 6 : f.max) : lo; }
    for (let i = lo; i <= hi; i += step) out.add(f.max === 7 && i === 7 ? 0 : i);
  }
  return { set: out, any: src === "*" };
}

function cron(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw bad("A cron schedule has 5 fields: minute hour day month weekday, e.g. 0 9 * * 1-5.");
  const [mi, ho, dm, mo, dw] = parts.map((p, i) => field(p, FIELDS[i]));
  const dayOk = (d) => {
    const a = dm.set.has(d.getDate()), b = dw.set.has(d.getDay());
    if (dm.any && dw.any) return true;
    if (dm.any) return b;
    if (dw.any) return a;
    return a || b;
  };
  return (from) => {
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (let guard = 0; guard < 200_000; guard++) {
      if (!mo.set.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
      if (!dayOk(d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
      if (!ho.set.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
      if (!mi.set.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
      return d.getTime();
    }
    return null; // e.g. 31 February
  };
}

/** "9", "09:30", "7pm", "7:15 am" → [h, m] */
function clock(s) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) throw bad(`"${s}" isn't a time. Use 24-hour HH:MM, e.g. 09:00 or 18:30.`);
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (m[3]) { if (h < 1 || h > 12) throw bad(`"${s}" isn't a time.`); h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0); }
  if (h > 23 || mi > 59) throw bad(`"${s}" isn't a time.`);
  return [h, mi];
}

const pad = (n) => String(n).padStart(2, "0");

/** Parses a schedule. Throws (status 400) with a plain message when it can't. */
export function parseSchedule(input) {
  const text = String(input ?? "").trim().replace(/\s+/g, " ");
  if (!text) throw bad("Add a schedule, e.g. daily at 09:00, every 2 hours or 0 9 * * 1-5.");
  if (text.length > 100) throw bad("That schedule is too long.");
  const t = text.toLowerCase();
  let s;

  let m = /^(?:every )?(daily|day|every day|weekdays|weekends|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s? at (.+)$/.exec(t);
  if (m) {
    const [h, mi] = clock(m[2]);
    const which = m[1];
    const dow = which === "weekdays" ? "1-5" : which === "weekends" ? "0,6" : ["daily", "day", "every day"].includes(which) ? "*" : String(DAYS.indexOf(which.slice(0, 3)));
    const next = cron(`${mi} ${h} * * ${dow}`);
    const when = dow === "*" ? "Every day" : dow === "1-5" ? "Weekdays" : dow === "0,6" ? "Weekends" : `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(dow)]}`;
    s = { kind: "daily", next, label: `${when} at ${pad(h)}:${pad(mi)}` };
  }

  if (!s && (m = /^(?:every )?(\d{1,4})? ?(minutes?|mins?|m|hours?|hrs?|h|days?|d)$/.exec(t.replace(/^hourly$/, "every 1 hour").replace(/^daily$/, "every 1 day")))) {
    const n = Number(m[1] || 1);
    const unit = m[2][0] === "m" ? MIN : m[2][0] === "h" ? 60 * MIN : 1440 * MIN;
    const ms = n * unit;
    if (!(n >= 1)) throw bad("Use a number of 1 or more.");
    if (ms < MIN_GAP_MS) throw bad("Tasks run at most every 5 minutes.");
    if (ms > 31 * 1440 * MIN) throw bad("Use a cron schedule for anything rarer than once a month.");
    const word = unit === MIN ? "minute" : unit === 60 * MIN ? "hour" : "day";
    s = { kind: "every", next: (from) => from + ms, label: n === 1 ? `Every ${word}` : `Every ${n} ${word}s`, everyMs: ms };
  }

  if (!s && /^[\d*a-z,\-/]+( [\d*a-z,\-/]+){4}$/.test(t)) s = { kind: "cron", next: cron(t), label: `Cron: ${t}` };
  if (!s) throw bad(`"${text}" isn't a schedule I understand. Try: every 30 minutes, daily at 09:00, weekdays at 08:30, or cron like 0 9 * * 1-5.`);

  const now = Date.now();
  const a = s.next(now);
  if (a === null) throw bad("That schedule never runs.");
  const b = s.next(a);
  if (b !== null && b - a < MIN_GAP_MS) throw bad("Tasks run at most every 5 minutes.");
  return { ...s, text };
}

/** The next `n` run times after `from` (ms). */
export function nextRuns(schedule, n = 3, from = Date.now()) {
  const s = typeof schedule === "string" ? parseSchedule(schedule) : schedule;
  const out = [];
  let t = from;
  for (let i = 0; i < n; i++) { t = s.next(t); if (t === null) break; out.push(t); }
  return out;
}
