import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 800;

export type RuntimeEnvironment = 'development' | 'production';

function readEnvFileValue(key: string) {
  try {
    const file = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
    const line = file.split(/\r?\n/).find(item => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*=`).test(item));
    if (!line) return '';
    const value = line.slice(line.indexOf('=') + 1).trim();
    return value.replace(/^(['"])(.*)\1$/, '$2');
  } catch {
    return '';
  }
}

export function configuredEnvValue(key: string) {
  return readEnvFileValue(key) || String(process.env[key] || '').trim();
}

function normalizeEnvironment(value: unknown): RuntimeEnvironment {
  return String(value || '').trim().toLowerCase() === 'production' ? 'production' : 'development';
}

// The deployment .env is the durable application setting. This also prevents
// a stale NODE_ENV value saved by PM2 from overriding a GUI change on restart.
const startupEnvironment = normalizeEnvironment(configuredEnvValue('NODE_ENV'));

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isProductionEnvironment() {
  return startupEnvironment === 'production';
}

export function environmentName() {
  return startupEnvironment;
}

export function rateLimitPerMinute() {
  return positiveInteger(process.env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE);
}

export function maxLoginSessionsPerUser() {
  const configured = positiveInteger(process.env.MAX_LOGIN_SESSIONS_PER_USER, 0);
  return configured === 0 ? 0 : configured;
}
