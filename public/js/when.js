// Dates, repeats and reminders for the schedule (unit tested in test/when.test.mjs).
// Events keep local wall-clock times as text in the business's time zone: 'YYYY-MM-DD' for all-day events and
// 'YYYY-MM-DDTHH:MM' for timed ones. The same text sorts by time, and Google Calendar gets exactly what was typed
// along with the zone, so daylight saving time never shifts an appointment.

export const DEFAULT_TZ = 'America/New_York';

export const TYPES = [
  { key: 'measure', label: 'Site measure', minutes: 60, reminders: [1440, 60] },
  { key: 'install', label: 'Install', minutes: 480, reminders: [1440, 60] },
  { key: 'meeting', label: 'Meeting', minutes: 60, reminders: [1440, 30] },
  { key: 'delivery', label: 'Delivery', minutes: 60, reminders: [60] },
  { key: 'task', label: 'Task', minutes: 30, reminders: [1440, 0] },
  { key: 'timeoff', label: 'Time off', allDay: true, reminders: [] },
  { key: 'other', label: 'Other', minutes: 60, reminders: [30] },
];
export const typeOf = (key) => TYPES.find((t) => t.key === key) || TYPES[TYPES.length - 1];

export const REPEATS = [['', 'Doesn\'t repeat'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']];

// Reminder choices, in minutes before the start. An all-day event starts at midnight, so its reminders count back
// from 00:00 of its first day: 900 minutes before is 9 AM the day before.
export const REMINDERS_TIMED = [[0, 'At the time'], [10, '10 min before'], [30, '30 min before'], [60, '1 hour before'],
  [120, '2 hours before'], [1440, '1 day before'], [2880, '2 days before'], [10080, '1 week before']];
export const REMINDERS_ALL_DAY = [[420, '5 PM the day before'], [900, '9 AM the day before'], [2340, '9 AM 2 days before'], [9540, '9 AM a week before']];
export const MAX_REMINDERS = 5;

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export const isDateTime = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(s || ''));
export const datePart = (s) => String(s || '').slice(0, 10);
export const timePart = (s) => (String(s || '').length > 10 ? String(s).slice(11, 16) : '');

// Date math on the text itself (in UTC, so no daylight saving jumps).
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms) => new Date(ms).toISOString();
export const addDays = (d, n) => fromMs(dayMs(d) + n * 864e5).slice(0, 10);
export const dayDiff = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 864e5);
export const weekday = (d) => new Date(dayMs(d)).getUTCDay();
const stamp = (s) => Date.parse(s.length > 10 ? `${s}:00Z` : `${s}T00:00:00Z`);
export const minutesBetween = (a, b) => Math.round((stamp(b) - stamp(a)) / 6e4);
export const addMinutes = (s, n) => fromMs(stamp(s) + n * 6e4).slice(0, 16);

export function addMonths(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  // A day that the month doesn't have (the 31st in April) means there's no such date: null, as in Google Calendar.
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return day > last ? null : `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The date and time right now in a time zone: { date: 'YYYY-MM-DD', time: 'HH:MM' }.
export function nowIn(tz = DEFAULT_TZ, at = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return nowIn(DEFAULT_TZ, at);
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

// The last day an event covers. A timed event that ends at midnight is over at the end of the day before.
export function lastDay(ev) {
  const end = datePart(ev.end || ev.start);
  if (!ev.allDay && timePart(ev.end) === '00:00' && end > datePart(ev.start)) return addDays(end, -1);
  return end < datePart(ev.start) ? datePart(ev.start) : end;
}

// The start of the occurrence that follows the one starting on `date` (k steps along), or null if there's none.
function step(ev, first, k) {
  if (ev.repeat === 'weekly') return addDays(first, 7 * k);
  if (ev.repeat === 'monthly') return addMonths(first, k);
  if (ev.repeat === 'yearly') return addMonths(first, 12 * k);
  return k === 0 ? first : null;
}

// Each time an event happens that touches the days `from`..`to` (inclusive), as { start, end, date } with the
// occurrence's own start and end text. Repeats follow Google Calendar's rules so both show the same days: a monthly
// event on the 31st skips months without a 31st, and a yearly one on Feb 29 only comes in leap years.
export function occurrences(ev, from, to, max = 1000) {
  const first = datePart(ev.start);
  const spanDays = dayDiff(first, lastDay(ev));
  const minutes = ev.allDay ? 0 : minutesBetween(ev.start, ev.end);
  const time = timePart(ev.start);
  const until = ev.repeat && isDate(ev.repeatUntil) ? ev.repeatUntil : null;
  const out = [];
  // Weekly repeats can jump straight to the first week that matters.
  let k = ev.repeat === 'weekly' ? Math.max(0, Math.floor((dayDiff(first, from) - spanDays) / 7)) : 0;
  for (let n = 0; n < max; n += 1, k += 1) {
    if (!ev.repeat && k > 0) break;
    const d = step(ev, first, k);
    if (d === null) {
      // Only months and years can skip; keep going (an impossible date can't repeat forever: Feb 29 comes back).
      if (k > 12 * 400) break;
      continue;
    }
    if (d > to || (until && d > until)) break;
    if (addDays(d, spanDays) < from) continue;
    const start = ev.allDay ? d : `${d}T${time}`;
    const end = ev.allDay ? addDays(d, spanDays) : addMinutes(start, minutes);
    out.push({ start, end, date: d });
  }
  return out;
}

// The next time a repeating event starts after the day `after`, as { start, end }, or null when it's over.
export function nextOccurrence(ev, after) {
  if (!ev.repeat) return null;
  const horizon = addDays(after, 366 * 5);
  return occurrences(ev, addDays(after, 1), horizon, 2000).find((o) => o.date > after) || null;
}

// ---------- Words ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// "Tue, Oct 14", with the year when it isn't `thisYear`.
export function fmtDay(d, { long = false, thisYear = null } = {}) {
  if (!isDate(d)) return '';
  const [y, m, day] = d.split('-').map(Number);
  const name = (long ? LONG_DAYS : DAYS)[weekday(d)];
  return `${name}, ${MONTHS[m - 1]} ${day}${thisYear && String(y) !== String(thisYear) ? `, ${y}` : ''}`;
}

export const monthName = (d) => `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
export const shortDay = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

// The time of an occurrence for a list: "7:30 AM – 3 PM", "All day", "Due 9 AM".
export function fmtSpan(ev, occ = ev) {
  if (ev.allDay) {
    const days = dayDiff(datePart(occ.start), datePart(occ.end));
    return days > 0 ? `All day, ${days + 1} days` : 'All day';
  }
  if (ev.type === 'task') return `Due ${fmtTime(timePart(occ.start))}`;
  const sameDay = datePart(occ.end) === datePart(occ.start) || (timePart(occ.end) === '00:00' && dayDiff(datePart(occ.start), datePart(occ.end)) === 1);
  return `${fmtTime(timePart(occ.start))} – ${sameDay ? '' : `${shortDay(datePart(occ.end))} `}${fmtTime(timePart(occ.end))}`;
}

// The whole "when" in one line: "Tue, Oct 14, 7:30 AM – 3 PM", "Oct 14 – Oct 16, all day", "Due Tue, Oct 14 at 9 AM".
export function fmtWhen(ev, thisYear = null) {
  const day = fmtDay(datePart(ev.start), { thisYear });
  let s;
  if (ev.allDay) {
    s = lastDay(ev) > datePart(ev.start) ? `${day} – ${fmtDay(lastDay(ev), { thisYear })}, all day` : `${day}, all day`;
  } else if (ev.type === 'task') {
    s = `Due ${day} at ${fmtTime(timePart(ev.start))}`;
  } else {
    s = `${day}, ${fmtSpan(ev)}`;
  }
  const r = REPEATS.find(([k]) => k === (ev.repeat || ''));
  if (ev.repeat && r) s += ` · ${r[1].toLowerCase()}${isDate(ev.repeatUntil) ? ` until ${shortDay(ev.repeatUntil)}` : ''}`;
  return s;
}

export function reminderLabel(minutes, allDay) {
  const known = (allDay ? REMINDERS_ALL_DAY : REMINDERS_TIMED).find(([m]) => m === minutes);
  if (known) return known[1];
  if (minutes % 1440 === 0) return `${minutes / 1440} days before`;
  if (minutes % 60 === 0) return `${minutes / 60} hours before`;
  return `${minutes} min before`;
}

// Reminders kept tidy: whole minutes from 0 to 4 weeks, no repeats, soonest last, at most five (Google's limit).
export function cleanReminders(list) {
  const seen = [...new Set((list || []).map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 40320))];
  return seen.sort((a, b) => b - a).slice(0, MAX_REMINDERS);
}
