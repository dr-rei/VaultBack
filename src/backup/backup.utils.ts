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

export function nextCron(cron: string, from = new Date(), timezone = 'UTC') {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Use a standard 5-field cron expression: minute hour day month weekday');
  const ranges = [[0,59],[0,23],[1,31],[1,12],[0,6]];
  const allowed = fields.map((field,index) => {
    const [min,max] = ranges[index];
    const values = Array.from({length:max-min+1},(_,i) => i+min).filter(value => parseCronField(field,min,max,value));
    if (!values.length) throw new Error('Cron field has no valid values');
    return values;
  });
  const formatter = new Intl.DateTimeFormat('en-US', {timeZone: timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const local = (timestamp: number) => {
    const parts = formatter.formatToParts(new Date(timestamp));
    const get = (key: string) => Number(parts.find(p => p.type === key)?.value);
    return {year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute')};
  };
  const current = local(from.getTime());
  const firstDay = Date.UTC(current.year,current.month-1,current.day);
  // Calendar search avoids millions of timezone conversions for sparse/invalid schedules.
  // Offset candidates on both sides of each date preserve repeated hours and reject DST gaps.
  for (let dayIndex = 0; dayIndex < 366 * 8; dayIndex++) {
    const dayStamp = firstDay + dayIndex * 86400000; const date = new Date(dayStamp);
    const month = date.getUTCMonth()+1; const day = date.getUTCDate(); const year = date.getUTCFullYear();
    if (!allowed[2].includes(day) || !allowed[3].includes(month) || !allowed[4].includes(date.getUTCDay())) continue;
    const offsets = new Set<number>();
    for (let hours = -48; hours <= 48; hours += 12) {
      const sample = dayStamp + hours*3600000; const p = local(sample);
      offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-sample);
    }
    let earliest = Infinity;
    for (const hour of allowed[1]) for (const minute of allowed[0]) {
      const wall = dayStamp + hour*3600000 + minute*60000;
      for (const offset of offsets) {
        const candidate = wall-offset;
        if (candidate <= from.getTime() || candidate >= earliest) continue;
        const actual = local(candidate);
        if (actual.year === year && actual.month === month && actual.day === day && actual.hour === hour && actual.minute === minute) earliest = candidate;
      }
    }
    if (Number.isFinite(earliest)) return new Date(earliest);
  }
  throw new Error('Could not calculate the next schedule occurrence');
}
