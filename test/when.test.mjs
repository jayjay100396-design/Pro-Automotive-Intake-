import assert from 'node:assert/strict';
import {
  addDays, addMonths, dayDiff, minutesBetween, addMinutes, nowIn, lastDay, occurrences, nextOccurrence,
  fmtTime, fmtDay, fmtSpan, fmtWhen, reminderLabel, cleanReminders,
} from '../public/js/when.js';

const days = (list) => list.map((o) => o.date);

describe('schedule dates', () => {
  it('does date math on the text without daylight saving jumps', () => {
    assert.equal(addDays('2026-03-07', 1), '2026-03-08');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(dayDiff('2026-10-14', '2026-10-16'), 2);
    assert.equal(minutesBetween('2026-10-14T07:30', '2026-10-14T15:00'), 450);
    assert.equal(minutesBetween('2026-03-08T01:00', '2026-03-08T03:00'), 120);
    assert.equal(addMinutes('2026-10-14T23:30', 60), '2026-10-15T00:30');
    assert.equal(addMonths('2026-01-31', 1), null);
    assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
    assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  });

  it('knows today in the business\'s time zone', () => {
    // 2026-10-12 02:30 UTC is still the evening of Oct 11 in Florida.
    const at = new Date('2026-10-12T02:30:00Z');
    assert.deepEqual(nowIn('America/New_York', at), { date: '2026-10-11', time: '22:30' });
    assert.deepEqual(nowIn('UTC', at), { date: '2026-10-12', time: '02:30' });
    assert.deepEqual(nowIn('Not/AZone', at), { date: '2026-10-11', time: '22:30' });
  });

  it('works out the last day an event covers', () => {
    assert.equal(lastDay({ allDay: true, start: '2026-10-14', end: '2026-10-16' }), '2026-10-16');
    assert.equal(lastDay({ allDay: false, start: '2026-10-14T07:00', end: '2026-10-14T15:00' }), '2026-10-14');
    assert.equal(lastDay({ allDay: false, start: '2026-10-14T22:00', end: '2026-10-15T00:00' }), '2026-10-14');
    assert.equal(lastDay({ allDay: false, start: '2026-10-14T22:00', end: '2026-10-15T01:00' }), '2026-10-15');
  });

  it('lists a one-off event only when it touches the days asked for', () => {
    const ev = { allDay: true, start: '2026-10-14', end: '2026-10-16' };
    assert.deepEqual(days(occurrences(ev, '2026-10-01', '2026-10-31')), ['2026-10-14']);
    assert.deepEqual(days(occurrences(ev, '2026-10-16', '2026-10-20')), ['2026-10-14']);
    assert.deepEqual(days(occurrences(ev, '2026-10-17', '2026-10-20')), []);
    assert.deepEqual(days(occurrences(ev, '2026-10-01', '2026-10-13')), []);
  });

  it('repeats weekly, with the same times, until the end date', () => {
    const ev = { allDay: false, start: '2026-10-05T07:00', end: '2026-10-05T08:00', repeat: 'weekly', repeatUntil: '2026-10-26' };
    const list = occurrences(ev, '2026-10-01', '2026-11-30');
    assert.deepEqual(days(list), ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    assert.deepEqual(list[1], { start: '2026-10-12T07:00', end: '2026-10-12T08:00', date: '2026-10-12' });
    // A meeting that started long ago still shows up this month.
    const old = { allDay: false, start: '2020-01-06T09:00', end: '2020-01-06T10:00', repeat: 'weekly', repeatUntil: '' };
    assert.deepEqual(days(occurrences(old, '2026-10-01', '2026-10-14')), ['2026-10-05', '2026-10-12']);
  });

  it('repeats monthly and yearly the way Google Calendar does', () => {
    const payApp = { allDay: true, start: '2026-01-31', end: '2026-01-31', repeat: 'monthly' };
    assert.deepEqual(days(occurrences(payApp, '2026-01-01', '2026-06-30')), ['2026-01-31', '2026-03-31', '2026-05-31']);
    const leap = { allDay: true, start: '2028-02-29', end: '2028-02-29', repeat: 'yearly' };
    assert.deepEqual(days(occurrences(leap, '2028-01-01', '2036-12-31')), ['2028-02-29', '2032-02-29', '2036-02-29']);
    const renewal = { allDay: true, start: '2026-06-30', end: '2026-06-30', repeat: 'yearly' };
    assert.deepEqual(days(occurrences(renewal, '2026-01-01', '2028-12-31')), ['2026-06-30', '2027-06-30', '2028-06-30']);
  });

  it('finds the next time a repeating task comes due', () => {
    const ev = { type: 'task', allDay: false, start: '2026-10-25T09:00', end: '2026-10-25T09:30', repeat: 'monthly', repeatUntil: '2026-12-31' };
    assert.deepEqual(nextOccurrence(ev, '2026-10-25'), { start: '2026-11-25T09:00', end: '2026-11-25T09:30', date: '2026-11-25' });
    assert.equal(nextOccurrence({ ...ev, start: '2026-12-25T09:00', end: '2026-12-25T09:30' }, '2026-12-25'), null);
    assert.equal(nextOccurrence({ ...ev, repeat: '' }, '2026-10-25'), null);
  });

  it('says when things happen in plain words', () => {
    assert.equal(fmtTime('07:30'), '7:30 AM');
    assert.equal(fmtTime('15:00'), '3 PM');
    assert.equal(fmtTime('00:00'), '12 AM');
    assert.equal(fmtTime('12:15'), '12:15 PM');
    assert.equal(fmtDay('2026-10-14'), 'Wed, Oct 14');
    assert.equal(fmtDay('2027-01-04', { thisYear: 2026 }), 'Mon, Jan 4, 2027');
    const install = { type: 'install', allDay: false, start: '2026-10-14T07:30', end: '2026-10-14T15:00' };
    assert.equal(fmtSpan(install), '7:30 AM – 3 PM');
    assert.equal(fmtWhen(install), 'Wed, Oct 14, 7:30 AM – 3 PM');
    assert.equal(fmtWhen({ type: 'timeoff', allDay: true, start: '2026-10-14', end: '2026-10-16' }), 'Wed, Oct 14 – Fri, Oct 16, all day');
    assert.equal(fmtWhen({ type: 'task', allDay: false, start: '2026-10-25T09:00', end: '2026-10-25T09:30', repeat: 'monthly' }), 'Due Sun, Oct 25 at 9 AM · every month');
    assert.equal(fmtSpan({ type: 'meeting', allDay: false, start: '2026-10-14T22:00', end: '2026-10-15T01:00' }), '10 PM – Oct 15 1 AM');
  });

  it('keeps reminders tidy', () => {
    assert.deepEqual(cleanReminders([60, '1440', 60, -5, 99999, 1.5, 0, 10, 30, 120]), [1440, 120, 60, 30, 10]);
    assert.equal(reminderLabel(900, true), '9 AM the day before');
    assert.equal(reminderLabel(1440, false), '1 day before');
    assert.equal(reminderLabel(4320, false), '3 days before');
  });
});
