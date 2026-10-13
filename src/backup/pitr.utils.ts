import { BadRequestException } from '@nestjs/common';

export type BinlogCoordinate = { file: string; position: number };

export function parseDumpBinlogCoordinates(contents: string): BinlogCoordinate | null {
  const patterns = [
    /CHANGE\s+REPLICATION\s+SOURCE\s+TO\s+SOURCE_LOG_FILE\s*=\s*'([^']+)'\s*,\s*SOURCE_LOG_POS\s*=\s*(\d+)/i,
    /CHANGE\s+MASTER\s+TO\s+MASTER_LOG_FILE\s*=\s*'([^']+)'\s*,\s*MASTER_LOG_POS\s*=\s*(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = contents.match(pattern);
    if (!match) continue;
    const file = match[1];
    const position = Number(match[2]);
    if (!/^[A-Za-z0-9._-]+$/.test(file) || !Number.isSafeInteger(position) || position < 4) return null;
    return { file, position };
  }
  return null;
}

export function pitrDumpCoordinateOption(engine: string): string {
  if (engine === 'mysql') return '--source-data=2';
  if (engine === 'mariadb') return '--master-data=2';
  throw new BadRequestException('PITR coordinates are supported only for MySQL and MariaDB');
}

export function pitrBinlogReplayOptions(engine: string, position: number, stopDatetime: string, mapping: Record<string, string>, localTimezoneOffsetMinutes?: number): string[] {
  if (!['mysql', 'mariadb'].includes(engine)) throw new BadRequestException('PITR replay is supported only for MySQL and MariaDB');
  if (!Number.isSafeInteger(position) || position < 4) throw new BadRequestException('PITR start position is invalid');
  const target = parseUtcTargetTime(stopDatetime);
  // Both vendor tools interpret --stop-datetime in the client's local timezone.
  const offset = localTimezoneOffsetMinutes ?? new Date(target.epoch).getTimezoneOffset();
  const local = new Date(target.epoch - offset * 60_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stop = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return ['--verify-binlog-checksum', `--start-position=${position}`, `--stop-datetime=${stop}`, ...Object.entries(mapping).map(([from, to]) => `--rewrite-db=${from}->${to}`)];
}

export function pitrBinlogTransportOptions(engine: string, mysqlNative: boolean, ssl: boolean): string[] {
  if (engine === 'mysql' && mysqlNative) return [ssl ? '--ssl-mode=REQUIRED' : '--ssl-mode=DISABLED'];
  return [ssl ? '--ssl' : '--skip-ssl'];
}

export function parseUtcTargetTime(value: unknown): { iso: string; epoch: number } {
  const input = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input)) {
    throw new BadRequestException('Target time must be an ISO-8601 UTC timestamp ending in Z');
  }
  const epoch = Date.parse(input);
  const fraction = input.match(/\.(\d{1,3})Z$/)?.[1];
  const canonicalInput = fraction ? input.replace(/\.\d{1,3}Z$/, `.${fraction.padEnd(3, '0')}Z`) : input.replace(/Z$/, '.000Z');
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== canonicalInput) {
    throw new BadRequestException('Target time is not a valid UTC timestamp');
  }
  return { iso: new Date(epoch).toISOString(), epoch };
}

export function binlogSequence(name: string): { prefix: string; sequence: number } | null {
  const match = String(name).match(/^(.*\.)(\d{6,})$/);
  if (!match) return null;
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence) ? { prefix: match[1], sequence } : null;
}

export function findBinlogSequenceGaps(names: string[]): string[] {
  const unique = [...new Set(names)];
  const parsed = unique.map(name => ({ name, parsed: binlogSequence(name) }));
  if (parsed.some(item => !item.parsed)) return parsed.filter(item => !item.parsed).map(item => `unverifiable:${item.name}`);
  const prefixes = new Set(parsed.map(item => item.parsed!.prefix));
  if (prefixes.size > 1) return ['binary log prefix changed'];
  const entries = parsed.map(item => ({ name: item.name, sequence: item.parsed!.sequence }));
  for (let index = 1; index < entries.length; index++) {
    if (entries[index].sequence <= entries[index - 1].sequence) return ['binary log order changed'];
  }
  const gaps: string[] = [];
  const prefix = parsed[0]?.parsed?.prefix || '';
  for (let index = 1; index < entries.length; index++) {
    for (let sequence = entries[index - 1].sequence + 1; sequence < entries[index].sequence; sequence++) {
      gaps.push(`${prefix}${String(sequence).padStart(6, '0')}`);
    }
  }
  return gaps;
}

export function makeScratchDatabaseNames(databases: string[], prefix: string, randomHex: string): Record<string, string> {
  if (!databases.length || new Set(databases).size !== databases.length) throw new BadRequestException('A non-empty, unique database list is required for PITR rehearsal');
  if (!/^[a-f0-9]{32,}$/.test(randomHex)) throw new BadRequestException('Scratch database randomness is invalid');
  const result = Object.create(null) as Record<string, string>;
  databases.forEach((database, index) => {
    if (!database || database.length > 64) throw new BadRequestException('PITR baseline database names are invalid');
    const suffix = `${randomHex.slice(0, 20)}_${index.toString(36)}`;
    const safePrefix = String(prefix).replace(/[^A-Za-z0-9_]/g, '_').slice(0, Math.max(1, 63 - suffix.length - 1)) || 'vb';
    result[database] = `${safePrefix}_${suffix}`;
  });
  return result;
}

function regexEscape(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function mysqlQuoteIdentifier(value: string) { return `\`${value.replace(/`/g, '``')}\``; }
const SQL_PROTECTED_PARTS = /('(?:\\.|''|[^'])*'|"(?:\\.|""|[^"])*"|\/\*![0-9]{0,6}[\s\S]*?\*\/|\/\*M![0-9]{0,6}[\s\S]*?\*\/|\/\*[\s\S]*?\*\/|--[ \t][^\r\n]*|#[^\r\n]*)/gi;

function sqlCodeMask(contents: string): string {
  return contents.split(SQL_PROTECTED_PARTS).map((part, index) => {
    if (!(index % 2)) return part;
    const executable = part.match(/^(\/\*M?![0-9]{0,6})([\s\S]*)(\*\/$)/i);
    if (!executable) return ' '.repeat(part.length);
    return `${' '.repeat(executable[1].length)}${sqlCodeMask(executable[2])}${' '.repeat(executable[3].length)}`;
  }).join('');
}

export function rewritePitrSqlDatabases(contents: string, mapping: Record<string, string>): string {
  const masked = sqlCodeMask(contents);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const addEdits = (pattern: RegExp, capture: number, replacement: string) => {
    for (const match of masked.matchAll(pattern)) {
      const text = match[capture];
      if (!text || match.index === undefined) continue;
      const start = match.index + (capture ? match[0].lastIndexOf(text) : 0);
      edits.push({ start, end: start + text.length, replacement });
    }
  };
  for (const [source, destination] of Object.entries(mapping)) {
    const quoted = mysqlQuoteIdentifier(source);
    const quotedFrom = regexEscape(quoted);
    const quotedTo = mysqlQuoteIdentifier(destination);
    addEdits(new RegExp(`${quotedFrom}(?=\\s*\\.)`, 'g'), 0, quotedTo);
    if (/^[A-Za-z0-9_$]+$/.test(source)) {
      addEdits(new RegExp(`(?<![A-Za-z0-9_$])${regexEscape(source)}(?=\\s*\\.)`, 'g'), 0, quotedTo);
    }
    const bareIdentifier = /^[A-Za-z0-9_$]+$/.test(source) ? regexEscape(source) : '(?!)';
    const directive = new RegExp(`\\b(?:USE|CREATE\\s+DATABASE|ALTER\\s+DATABASE|DROP\\s+DATABASE)(?:\\s+IF\\s+(?:NOT\\s+)?EXISTS)?\\s+(${quotedFrom}|${bareIdentifier})(?=\\s|;|$)`, 'gi');
    addEdits(directive, 1, quotedTo);
  }
  edits.sort((left, right) => right.start - left.start);
  let rewritten = contents;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of edits) {
    if (edit.end > lastStart) continue;
    rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
    lastStart = edit.start;
  }
  return rewritten;
}

function stripSqlCommentsAndStrings(contents: string): string {
  return contents.split(SQL_PROTECTED_PARTS).map((part, index) => {
    if (!(index % 2)) return part;
    if (part.startsWith('/*!') || /^\/\*M!/i.test(part)) return stripSqlCommentsAndStrings(part.replace(/^\/\*M?![0-9]{0,6}/i, '').replace(/\*\/$/, ''));
    return ' ';
  }).join('');
}

export function validatePitrSql(contents: string, allowedDatabases: string[]): void {
  const sql = stripSqlCommentsAndStrings(contents);
  if (/\b(?:CREATE|ALTER|DROP)\s+(?:USER|ROLE|SERVER|TABLESPACE)\b|\bGRANT\b|\bREVOKE\b|\bFLUSH\s+PRIVILEGES\b|\bSET\s+(?:@@GLOBAL|@@PERSIST|GLOBAL\b|PERSIST\b)|\b(?:INSTALL|UNINSTALL)\s+(?:PLUGIN|COMPONENT)\b|\bLOAD\s+DATA\s+(?:LOCAL\s+)?INFILE\b|\b(?:PREPARE|EXECUTE)\b|\bDEALLOCATE\s+PREPARE\b|\bCALL\b|\bINTO\s+(?:OUTFILE|DUMPFILE)\b|\bCREATE\s+FUNCTION\b[\s\S]*?\bSONAME\b|\b(?:RESET\s+(?:MASTER|SLAVE|PERSIST)|PURGE\s+BINARY\s+LOGS|CHANGE\s+(?:MASTER|REPLICATION\s+SOURCE)|START\s+(?:SLAVE|REPLICA)|STOP\s+(?:SLAVE|REPLICA)|SHUTDOWN|KILL)\b/i.test(sql)) {
    throw new BadRequestException('PITR replay contains server-level, dynamic SQL, or external-file statements outside the supported database-only recovery scope');
  }
  const allowed = new Set(allowedDatabases);
  const unknown: string[] = [];
  const identifiers = /`((?:``|[^`])+)`\s*\.|(?<!@)\b([A-Za-z0-9_$]+)\s*\./g;
  for (const match of sql.matchAll(identifiers)) {
    const database = (match[1] || match[2]).replace(/``/g, '`');
    if (!allowed.has(database)) unknown.push(database);
  }
  if (unknown.length) throw new BadRequestException(`PITR replay references databases outside the recorded source set: ${[...new Set(unknown)].slice(0, 5).join(', ')}`);
  for (const match of sql.matchAll(/\bUSE\s+([A-Za-z0-9_$]+|`(?:``|[^`])+`)/gi)) {
    const database = match[1].replace(/^`|`$/g, '').replace(/``/g, '`');
    if (!allowed.has(database)) throw new BadRequestException(`PITR replay selects a database outside the recorded source set: ${database}`);
  }
  for (const match of sql.matchAll(/\b(?:CREATE|ALTER|DROP)\s+DATABASE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+([A-Za-z0-9_$]+|`(?:``|[^`])+`)/gi)) {
    const database = match[1].replace(/^`|`$/g, '').replace(/``/g, '`');
    if (!allowed.has(database)) throw new BadRequestException(`PITR replay changes a database outside the recorded source set: ${database}`);
  }
}
