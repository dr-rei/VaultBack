import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AppModule } from './app.module';
import { isProductionEnvironment, rateLimitPerMinute } from './common/app-config';
import { EnvironmentExceptionFilter } from './common/environment-exception.filter';
import { SystemService } from './system/system.service';

type ApplicationProtocol = 'http' | 'https' | 'both';

function configuredProtocol(): ApplicationProtocol {
  const value = String(process.env.APP_PROTOCOL || 'http').trim().toLowerCase();
  if (value !== 'http' && value !== 'https' && value !== 'both') throw new Error('APP_PROTOCOL must be http, https, or both.');
  return value;
}

function normalizeHost(value: unknown) {
  let host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else if (host.split(':').length <= 2) host = host.split(':')[0];
  return host;
}

function allowedDomains() {
  const configured = String(process.env.APP_DOMAIN || '').split(',').map(normalizeHost).filter(Boolean);
  if (configured.length) return configured;
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') throw new Error('APP_DOMAIN is required when NODE_ENV=production. Set one or more allowed hostnames separated by commas.');
  return ['localhost', '127.0.0.1', '::1'];
}

function tlsOptions(protocol: ApplicationProtocol) {
  if (protocol === 'http') return undefined;
  const certificate = String(process.env.HTTPS_CERT_FILE || '').trim();
  const privateKey = String(process.env.HTTPS_KEY_FILE || '').trim();
  if (!certificate || !privateKey) throw new Error('HTTPS_CERT_FILE and HTTPS_KEY_FILE are required when APP_PROTOCOL is https or both.');
  const certPath = path.resolve(process.cwd(), certificate);
  const keyPath = path.resolve(process.cwd(), privateKey);
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) throw new Error('The configured HTTPS certificate or private-key file does not exist.');
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

async function bootstrap() {
  const protocol = configuredProtocol();
  const domains = allowedDomains();
  const tls = tlsOptions(protocol);
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: true, ...(tls ? { https: tls } : {}) }));
  const isProduction = isProductionEnvironment();
  app.useGlobalFilters(new EnvironmentExceptionFilter(isProduction));
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  const server = app.getHttpAdapter().getInstance();
  const system = app.get(SystemService);
  server.addHook('onRequest', async (request, reply) => {
    if (!domains.includes(normalizeHost(request.headers?.host))) return reply.code(421).send({ message: 'Host not allowed' });
  });
  server.addHook('onRequest', async (request) => {
    const requestPath = String(request.url || '').split('?')[0];
    if (requestPath.startsWith('/api/') && !/^\/api\/auth\/(login|setup)$/.test(requestPath)) system.recordApiRequest(request);
  });
  if (isProduction) {
    // Rate-limit API traffic without making normal frontend assets compete for
    // the same bucket. Authentication gets its own stricter bucket because it
    // is the highest-value brute-force target.
    const apiRequestsPerMinute = rateLimitPerMinute();
    await app.register(rateLimit, { global: false });
    const apiRateLimit = server.rateLimit({ max: apiRequestsPerMinute, timeWindow: '1 minute', groupId: 'api' });
    const authRateLimit = server.rateLimit({ max: 10, timeWindow: '15 minutes', groupId: 'auth' });
    server.addHook('onRequest', async (request, reply) => {
      const requestPath = String(request.url || '').split('?')[0];
      if (!requestPath.startsWith('/api/')) return;
      const limiter = /^\/api\/auth\/(login|setup)$/.test(requestPath) ? authRateLimit : apiRateLimit;
      return limiter.call(server, request, reply);
    });
  }
  const publicRoot = path.resolve(process.cwd(), 'public');
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  const frontendRoutes = new Set(['/', '/overview', '/databases', '/connections', '/storage', '/schedules', '/jobs', '/history', '/runs', '/guide', '/help', '/settings', '/sessions']);
  app.getHttpAdapter().getInstance().get('/*', async (request: any, reply: any) => {
    const requested = String(request.url || '/').split('?')[0];
    const normalizedPath = requested.replace(/\/+$/, '') || '/';
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const candidate = path.resolve(publicRoot, relative);
    const safe = candidate === publicRoot || candidate.startsWith(`${publicRoot}${path.sep}`);
    const fileExists = safe && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    if (fileExists) {
      const extension = path.extname(candidate).toLowerCase();
      if (['.html', '.js', '.css'].includes(extension)) reply.header('Cache-Control', 'no-store, max-age=0');
      return reply.type(mime[extension] || 'application/octet-stream').send(fs.readFileSync(candidate));
    }
    if (normalizedPath.startsWith('/api/')) return reply.code(404).send({ message: 'Not found' });
    const index = fs.readFileSync(path.join(publicRoot, 'index.html'));
    reply.header('Cache-Control', 'no-store, max-age=0');
    if (frontendRoutes.has(normalizedPath)) return reply.type(mime['.html']).send(index);
    return reply.code(404).type(mime['.html']).send(index);
  });
  app.enableShutdownHooks();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3010);
  const httpPort = Number(process.env.HTTP_PORT || port);
  const httpsPort = Number(process.env.HTTPS_PORT || 3443);
  if (protocol === 'both' && httpPort === httpsPort) throw new Error('HTTP_PORT and HTTPS_PORT must be different when APP_PROTOCOL=both.');
  await app.listen({ host, port: protocol === 'both' ? httpsPort : port });
  if (protocol === 'both') {
    const redirectServer = http.createServer((request, response) => {
      if (!domains.includes(normalizeHost(request.headers.host))) { response.writeHead(421, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ message: 'Host not allowed' })); return; }
      const domain = domains[0];
      const portSuffix = httpsPort === 443 ? '' : `:${httpsPort}`;
      response.writeHead(308, { location: `https://${domain}${portSuffix}${request.url || '/'}` });
      response.end();
    });
    redirectServer.listen({ host, port: httpPort });
    app.enableShutdownHooks();
  }
}
bootstrap();
