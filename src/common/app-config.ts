export const DEFAULT_RATE_LIMIT_PER_MINUTE = 800;

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isProductionEnvironment() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

export function environmentName() {
  return String(process.env.NODE_ENV || 'development').trim() || 'development';
}

export function rateLimitPerMinute() {
  return positiveInteger(process.env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE);
}

export function maxLoginSessionsPerUser() {
  const configured = positiveInteger(process.env.MAX_LOGIN_SESSIONS_PER_USER, 0);
  return configured === 0 ? 0 : configured;
}
