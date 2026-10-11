// How one app event looks in Google Calendar. Pure: no Firestore and no network, so it's easy to test
// (test/mapping.test.js). sync.js does the reading and writing.
//
// An app event is companies/{companyId}/events/{eventId}. Dates are wall-clock times in the event's time zone:
// 'YYYY-MM-DD' for all-day events (end is the last day, inclusive) and 'YYYY-MM-DDTHH:MM' for the rest.
import { createHash } from 'node:crypto';

export const TYPE_LABELS = {
  measure: 'Site measure', install: 'Install', meeting: 'Meeting', delivery: 'Delivery', task: 'Task', timeoff: 'Time off', other: 'Other',
};
// Google Calendar's event colors: 7 Peacock, 9 Blueberry, 3 Grape, 6 Tangerine, 5 Banana, 8 Graphite, 2 Sage.
export const TYPE_COLORS = { measure: '7', install: '9', meeting: '3', delivery: '6', task: '5', timeoff: '8', other: '2' };
export const REPEATS = ['weekly', 'monthly', 'yearly'];
const FREQ = { weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
export const DEFAULT_TIME_ZONE = 'America/New_York';
// A full sync covers events that ended up to this many days ago, plus everything after.
export const WINDOW_DAYS = 30;
const MAX_REMINDERS = 5; // Google's limit per event
const MAX_REMINDER_MINUTES = 40320; // four weeks, also Google's limit

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

// The business name without "LLC", "Inc." and the like, which reads better as a calendar name.
// The app names the calendars the same way (shortName in public/js/gcal.js), so keep the two in step.
export const shortCompanyName = (name) => String(name || '').trim()
  .replace(/[,\s]+(LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Ltd\.?|PLLC|LLP)$/i, '').trim() || 'Stellar Glass';

// ---------- Event ids ----------

// Google event ids may only use the base32hex letters (0-9 and a-v), 5 to 1024 of them. Turning the app's event id
// into one, instead of keeping a list of which is which, means the same app event always lands on the same Google
// event, so a retry or a second copy of the trigger can never make a duplicate.
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';
export function base32hex(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff; // only the bits not written out yet matter (never more than 12)
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32HEX[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

export const googleEventId = (eventId) => `st${base32hex(Buffer.from(String(eventId), 'utf8'))}`;

// ---------- Who gets which events ----------

// The business calendar gets every event; a person's own calendar gets the ones they're assigned to.
// Canceled events come off both.
export function isWanted(link, event) {
  if (!event || event.canceled === true) return false;
  if (link.kind === 'business') return true;
  return Array.isArray(event.assignees) && event.assignees.includes(link.uid);
}

// ---------- Dates and time zones ----------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// A real calendar day in 'YYYY-MM-DD' form (not 2026-02-30).
export const isDate = (s) => typeof s === 'string' && DATE.test(s) && addDays(s, 0) === s;

export function isDateTime(s) {
  const m = typeof s === 'string' && DATE_TIME.exec(s);
  return !!m && isDate(s.slice(0, 10)) && Number(m[4]) <= 23 && Number(m[5]) <= 59;
}

export function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The wall-clock reading of an instant in a time zone.
function wallClock(tz, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// How far the zone's clocks are ahead of UTC at an instant, in ms (negative west of Greenwich).
function offsetAt(tz, ms) {
  const w = wallClock(tz, ms);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time happens in a time zone. The offset is checked again at the answer, because the
// first guess can land on the other side of a daylight saving change.
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = wall - offsetAt(tz, wall);
  const again = offsetAt(tz, utc);
  if (wall - again !== utc) utc = wall - again;
  return new Date(utc);
}

// Today's date where the business is.
export function todayIn(tz, now) {
  const w = wallClock(tz, now.getTime());
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export const windowStartFor = (tz, now) => addDays(todayIn(tz, now), -WINDOW_DAYS);

// ---------- One event ----------

// Google's start and end. All-day: Google's end date is the day after the last day. Timed: the wall-clock time and
// its zone, so Google shows it right wherever the phone is. Null when the event's dates can't be read.
export function timesFor(event, tz) {
  if (event.allDay === true) {
    if (!isDate(event.start)) return null;
    const last = isDate(event.end) && event.end >= event.start ? event.end : event.start;
    return { start: { date: event.start }, end: { date: addDays(last, 1) } };
  }
  if (!isDateTime(event.start)) return null;
  const end = isDateTime(event.end) && event.end >= event.start ? event.end : event.start;
  return { start: { dateTime: `${event.start}:00`, timeZone: tz }, end: { dateTime: `${end}:00`, timeZone: tz } };
}

// The repeat rule. repeatUntil is the last day an occurrence may start on. Google wants that as a date for all-day
// events, and as the UTC moment of 23:59:59 that day where the event is for timed ones.
export function recurrenceFor(event, tz) {
  const freq = FREQ[event.repeat];
  if (!freq) return undefined;
  let rule = `RRULE:FREQ=${freq}`;
  if (isDate(event.repeatUntil)) {
    if (event.allDay === true) {
      rule += `;UNTIL=${event.repeatUntil.replace(/-/g, '')}`;
    } else {
      const [year, month, day] = event.repeatUntil.split('-').map(Number);
      const last = zonedTimeToUtc({ year, month, day, hour: 23, minute: 59, second: 59 }, tz);
      rule += `;UNTIL=${last.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')}`;
    }
  }
  return [rule];
}

// Reminders pop up on the phone of whoever's calendar the event is on. On the business calendar (the owner's),
// an event assigned to other people doesn't remind the owner: those people get it on their own calendars.
// Done events don't remind anyone.
export function remindersFor(link, event) {
  const assignees = Array.isArray(event.assignees) ? event.assignees : [];
  const someoneElses = link.kind === 'business' && assignees.length > 0 && !assignees.includes(link.uid);
  if (event.done === true || someoneElses) return { useDefault: false, overrides: [] };
  const minutes = [...new Set((Array.isArray(event.reminders) ? event.reminders : [])
    .filter((m) => Number.isInteger(m) && m >= 0 && m <= MAX_REMINDER_MINUTES))]
    .sort((a, b) => a - b)
    .slice(0, MAX_REMINDERS);
  return { useDefault: false, overrides: minutes.map((m) => ({ method: 'popup', minutes: m })) };
}

const nameOf = (member) => oneLine(member?.name) || oneLine(member?.email).split('@')[0];
const firstNameOf = (member) => nameOf(member).split(' ')[0];

// 'Pat Customer (Lake Dental) · (863) 555-0100 · pat@example.com', leaving out what isn't filled in.
function customerLine(c) {
  const name = oneLine(c.name);
  const company = oneLine(c.company);
  const who = name && company ? `${name} (${company})` : name || company;
  return [who, oneLine(c.phone), oneLine(c.email)].filter(Boolean).join(' · ');
}

// A short fingerprint of a Google event, kept on it (stellarV), so a full sync can skip events that haven't changed.
// Keys are sorted first, so it only changes when the content does.
const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
};
export const versionOf = (body) => createHash('sha1').update(JSON.stringify(canonical(body))).digest('hex').slice(0, 12);

// The Google Calendar event for an app event on one link's calendar. Returns null when the event's dates can't be
// read (the app checks them, so that would be an old or broken record), and the caller leaves it alone.
//   link     { kind: 'business' | 'personal', uid }
//   company  { name, timeZone }
//   members  Map of uid -> member ({ name, email })
//   customer, job  the records the event points to, or null
export function buildGoogleEvent({ eventId, event, link, company = {}, members = new Map(), customer = null, job = null, appUrl }) {
  const tz = isTimeZone(event.tz) ? event.tz : (isTimeZone(company.timeZone) ? company.timeZone : DEFAULT_TIME_ZONE);
  const times = timesFor(event, tz);
  if (!times) return null;
  const type = TYPE_LABELS[event.type] ? event.type : 'other';
  const short = shortCompanyName(company.name);
  const url = `${appUrl}/#/schedule/${encodeURIComponent(eventId)}`;
  const people = (Array.isArray(event.assignees) ? event.assignees : []).map((uid) => members.get(uid)).filter((m) => m && nameOf(m));

  // The business calendar shows who's on it: "Install storefront (Maria, Wes)".
  const firstNames = people.map(firstNameOf);
  const title = oneLine(event.title) || TYPE_LABELS[type];
  const summary = `${event.done === true ? '✓ ' : ''}${title}${link.kind === 'business' && firstNames.length ? ` (${firstNames.join(', ')})` : ''}`;

  const head = [TYPE_LABELS[type]];
  if (customer && customerLine(customer)) head.push(`Customer: ${customerLine(customer)}`);
  if (job && oneLine(job.name)) head.push(`Job: ${oneLine(job.name)}`);
  if (people.length) head.push(`Who: ${people.map(nameOf).join(', ')}`);
  const description = [head.join('\n'), String(event.notes ?? '').trim(), `Open in the app: ${url}`].filter(Boolean).join('\n\n');

  const recurrence = recurrenceFor(event, tz);
  const body = {
    id: googleEventId(eventId),
    summary,
    description,
    location: oneLine(event.location),
    start: times.start,
    end: times.end,
    ...(recurrence ? { recurrence } : {}),
    reminders: remindersFor(link, event),
    colorId: TYPE_COLORS[type],
    transparency: type === 'task' ? 'transparent' : 'opaque', // a task doesn't make anyone look busy
    status: 'confirmed', // also brings back an event that was deleted earlier
    source: { title: short, url },
  };
  return { ...body, extendedProperties: { private: { stellar: '1', stellarEvent: eventId, stellarV: versionOf(body) } } };
}
