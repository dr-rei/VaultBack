import fs from 'node:fs';
import path from 'node:path';

export function safeFilePart(value: string) { return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'backup'; }

export function isWithin(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function ensureDirectory(dir: string) { fs.mkdirSync(dir, { recursive: true }); }

export function parseCronField(field: string, min: number, max: number, value: number) {
  if (field === '*') return true;
  return field.split(',').some(part => {
    const [base, stepText] = part.split('/'); const step = Number(stepText || 1);
    if (!Number.isInteger(step) || step < 1) return false;
    if (base === '*') return value % step === 0;
    if (base.includes('-')) { const [a, b] = base.split('-').map(Number); return value >= a && value <= b && (value - a) % step === 0; }
    return Number(base) === value;
  }) && value >= min && value <= max;
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function fromLocalParts(parts: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string) {
  const rough = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  const actual = localParts(rough, timezone);
  const asUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
  return new Date(rough.getTime() + (rough.getTime() - asUtc));
}

export function nextCron(cron: string, from = new Date(), timezone = 'UTC') {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Use a standard 5-field cron expression: minute hour day month weekday');
  let current = localParts(from, timezone); current.second = 0; current.minute += 1;
  const start = new Date(Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute));
  for (let i = 0; i < 60 * 24 * 366; i++) {
    const date = new Date(start.getTime() + i * 60000); const local = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() };
    if (parseCronField(fields[0], 0, 59, local.minute) && parseCronField(fields[1], 0, 23, local.hour) && parseCronField(fields[2], 1, 31, local.day) && parseCronField(fields[3], 1, 12, local.month) && parseCronField(fields[4], 0, 6, date.getUTCDay())) return fromLocalParts(local, timezone);
  }
  throw new Error('Could not calculate the next schedule occurrence');
}
