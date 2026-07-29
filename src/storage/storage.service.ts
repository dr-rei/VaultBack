import { BadRequestException, Injectable } from '@nestjs/common';
import { Client } from 'basic-ftp';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { DatabaseService } from '../database/database.service';
import { StorageTarget, StorageType } from '../types';
import { ensureDirectory, isWithin } from '../backup/backup.utils';

@Injectable()
export class StorageService {
  constructor(private readonly store: DatabaseService) {}

  listPage(input: any = {}) {
    this.store.assertEncryptionHealthy(); const page = Math.max(1, Number.parseInt(String(input.page || '1'), 10) || 1); const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(input.pageSize || '25'), 10) || 25)); const offset = (page - 1) * pageSize; const search = String(input.search || '').trim().toLowerCase(); const where = search ? `WHERE LOWER(COALESCE(name,'') || ' ' || COALESCE(type,'')) LIKE ?` : ''; const params = search ? [`%${search}%`] : []; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM storage_targets ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT * FROM storage_targets ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => ({ id: row.id, name: row.name, type: row.type, config: this.redact(this.store.decrypt(row.config_enc)), createdAt: row.created_at })); return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  }

  list() {
    this.store.assertEncryptionHealthy();
    const rows = this.store.db.prepare('SELECT * FROM storage_targets ORDER BY name').all() as any[];
    return rows.map(row => ({ id: row.id, name: row.name, type: row.type, config: this.redact(this.store.decrypt(row.config_enc)), createdAt: row.created_at }));
  }

  get(id: string): StorageTarget {
    this.store.assertEncryptionHealthy();
    const row = this.store.db.prepare('SELECT * FROM storage_targets WHERE id = ?').get(id) as any;
    if (!row) throw new BadRequestException('Storage target not found');
    return { id: row.id, name: row.name, type: row.type, config: this.store.decrypt(row.config_enc), createdAt: row.created_at } as StorageTarget;
  }

  save(input: Partial<StorageTarget> & { config?: Record<string, unknown> }) {
    this.store.assertEncryptionHealthy();
    if (!input.name || !input.type || !input.config) throw new BadRequestException('Name, type and configuration are required');
    const allowed: StorageType[] = ['local', 'ftp', 'webdav', 'google-drive', 'onedrive'];
    if (!allowed.includes(input.type as StorageType)) throw new BadRequestException('Unsupported storage type');
    const id = input.id || crypto.randomUUID();
    const now = this.store.now();
    const oldRow = input.id ? this.store.db.prepare('SELECT config_enc FROM storage_targets WHERE id=?').get(input.id) as any : undefined;
    const oldConfig = oldRow?.config_enc ? this.store.decrypt<Record<string, unknown>>(oldRow.config_enc) : {};
    const config = { ...(input.config || {}) } as Record<string, unknown>;
    for (const secret of ['password', 'token', 'accessToken', 'refreshToken', 'clientSecret', 'webhookToken', 'botToken']) {
      if ((!Object.prototype.hasOwnProperty.call(config, secret) || String(config[secret] || '').trim() === '') && Object.prototype.hasOwnProperty.call(oldConfig, secret)) config[secret] = oldConfig[secret];
    }
    const encoded = this.store.encrypt(config);
    this.store.db.prepare(`INSERT INTO storage_targets (id, name, type, config_enc, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, config_enc=excluded.config_enc`).run(id, input.name, input.type, encoded, now);
    return this.list().find(item => item.id === id);
  }

  delete(id: string) { this.store.db.prepare('DELETE FROM storage_targets WHERE id = ?').run(id); return { ok: true }; }

  async upload(target: StorageTarget, localFile: string, filename: string) {
    switch (target.type) {
      case 'local': return this.uploadLocal(target, localFile, filename);
      case 'ftp': return this.uploadFtp(target, localFile, filename);
      case 'webdav': return this.uploadWebdav(target, localFile, filename);
      case 'google-drive': return this.uploadGoogleDrive(target, localFile, filename);
      case 'onedrive': return this.uploadOneDrive(target, localFile, filename);
      default: throw new Error(`Storage adapter not implemented: ${target.type}`);
    }
  }

  async download(target: StorageTarget, filename: string, location?: string) {
    this.validateFilename(filename);
    if (target.type === 'local') {
      const directory = this.localDir(target);
      const file = path.resolve(directory, filename);
      if (!isWithin(directory, file) || !fs.existsSync(file)) throw new BadRequestException('Backup file is no longer available in local storage');
      return { path: file, cleanup: false };
    }

    const tempDir = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', 'download-'));
    const output = path.join(tempDir, filename);
    try {
      if (target.type === 'ftp') await this.downloadFtp(target, filename, output);
      else if (target.type === 'webdav') await this.downloadWebdav(target, filename, output);
      else if (target.type === 'google-drive') await this.downloadGoogleDrive(target, filename, location, output);
      else if (target.type === 'onedrive') await this.downloadOneDrive(target, filename, location, output);
      else throw new BadRequestException(`Download is not supported for ${target.type}`);
      return { path: output, cleanup: true };
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async rotate(target: StorageTarget, prefix: string, retentionCount: number) {
    if (retentionCount < 1) return;
    if (target.type === 'local') {
      const dir = this.localDir(target);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error: any) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      const files = entries.filter(entry => entry.isFile() && entry.name.startsWith(prefix)).map(entry => entry.name).sort().reverse();
      for (const file of files.slice(retentionCount)) {
        try {
          fs.rmSync(path.join(dir, file), { force: true });
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  async test(target: StorageTarget) {
    if (target.type === 'local') { ensureDirectory(this.localDir(target)); return { ok: true, message: 'Local directory is writable' }; }
    if (target.type === 'ftp') { const client = new Client(10000); try { await client.access(this.ftpConfig(target)); return { ok: true, message: 'FTP connection succeeded' }; } finally { client.close(); } }
    if (target.type === 'webdav') {
      const response = await this.webdavRequest(target, String(target.config.url), {
        method: 'PROPFIND',
        headers: { ...this.webdavHeaders(target), Depth: '0', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>'
      });
      if (response.status < 200 || response.status >= 300) throw new BadRequestException(`WebDAV returned ${response.status}. Check the Synology URL, shared-folder path, and account permissions.`);
      return { ok: true, message: 'WebDAV connection succeeded' };
    }
    const c = target.config as any;
    if (target.type === 'google-drive' && !c.accessToken && !(c.refreshToken && c.clientId && c.clientSecret)) throw new Error('Google Drive needs an access token or refresh-token OAuth credentials');
    if (target.type === 'onedrive' && !c.accessToken && !(c.refreshToken && c.clientId && c.clientSecret)) throw new Error('OneDrive needs an access token or refresh-token OAuth credentials');
    return { ok: true, message: 'Cloud credentials are configured; a live upload will verify them' };
  }

  private validateFilename(filename: string) { if (!filename || path.basename(filename) !== filename || /[\\/\0]/.test(filename)) throw new BadRequestException('Invalid backup filename'); }
  private uploadLocal(target: StorageTarget, localFile: string, filename: string) { const dir = this.localDir(target); ensureDirectory(dir); const destination = path.join(dir, filename); try { fs.copyFileSync(localFile, destination); } catch (error: any) { if (error?.code === 'ENOENT') throw new BadRequestException('The temporary backup file is no longer available to upload'); throw error; } return { location: destination }; }
  private localDir(target: StorageTarget) { const requested = String(target.config.path || ''); if (!requested) throw new Error('Local storage path is required'); const root = path.resolve(this.store.dataDir, 'backups'); const dir = path.resolve(requested); if (process.env.ALLOW_ANY_LOCAL_PATH !== 'true' && !isWithin(root, dir)) throw new Error(`Local paths must be inside ${root}`); return dir; }
  private ftpConfig(target: StorageTarget) { const c = target.config as any; return { host: String(c.host), port: Number(c.port || 21), user: String(c.username), password: String(c.password), secure: Boolean(c.secure) }; }
  private ftpRemotePath(target: StorageTarget, filename: string) { return `${String((target.config as any).remotePath || '').replace(/\\/g, '/').replace(/\/$/, '')}/${filename}`.replace(/^\//, '/'); }
  private async uploadFtp(target: StorageTarget, localFile: string, filename: string) { const c = new Client(30000); try { await c.access(this.ftpConfig(target)); const remote = `${String((target.config as any).remotePath || '').replace(/\\/g, '/').replace(/\/$/, '')}/${filename}`.replace(/^\//, '/'); await c.uploadFrom(localFile, remote); return { location: `ftp://${(target.config as any).host}${remote}` }; } finally { c.close(); } }
  private async downloadFtp(target: StorageTarget, filename: string, output: string) { const c = new Client(30000); try { await c.access(this.ftpConfig(target)); await c.downloadTo(output, this.ftpRemotePath(target, filename)); } finally { c.close(); } }
  private webdavHeaders(target: StorageTarget) { const c = target.config as any; const token = c.token ? `Bearer ${c.token}` : `Basic ${Buffer.from(`${c.username || ''}:${c.password || ''}`).toString('base64')}`; return { Authorization: token }; }
  private webdavUrl(target: StorageTarget, rawUrl: string) {
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { throw new BadRequestException('Enter a valid WebDAV URL, for example https://nas.example.com:5006/backups'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new BadRequestException('WebDAV URL must use http:// or https://');
    if (parsed.username || parsed.password) throw new BadRequestException('Do not put WebDAV credentials in the URL; use the username and password fields.');
    return parsed;
  }
  private async webdavRequest(target: StorageTarget, rawUrl: string, options: { method: string; headers?: Record<string, string>; body?: string | fs.ReadStream; output?: string }) {
    const parsed = this.webdavUrl(target, rawUrl);
    const config = target.config as any;
    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = { ...(options.headers || {}) } as Record<string, string>;
    if (options.body && typeof options.body !== 'string') headers['Content-Length'] = String(fs.statSync((options.body as any).path).size);
    if (typeof options.body === 'string') headers['Content-Length'] = String(Buffer.byteLength(options.body));
    try {
      return await new Promise<{ status: number; body?: Buffer }>((resolve, reject) => {
        const request = transport.request({
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname || '/'}${parsed.search}`,
          method: options.method,
          headers,
          timeout: 15000,
          ...(parsed.protocol === 'https:' ? { rejectUnauthorized: !Boolean(config.allowSelfSigned) } : {})
        }, response => {
          const status = response.statusCode || 0;
          if (options.output) {
            const output = fs.createWriteStream(options.output, { mode: 0o600 });
            response.pipe(output);
            output.once('finish', () => resolve({ status }));
            output.once('error', reject);
            response.once('error', reject);
            return;
          }
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          response.once('end', () => resolve({ status, body: Buffer.concat(chunks) }));
          response.once('error', reject);
        });
        request.once('timeout', () => request.destroy(new Error('The WebDAV request timed out.')));
        request.once('error', reject);
        if (!options.body) request.end();
        else if (typeof options.body === 'string') request.end(options.body);
        else options.body.pipe(request);
      });
    } catch (error) {
      throw this.webdavConnectionError(error, parsed, Boolean(config.allowSelfSigned));
    }
  }
  private webdavConnectionError(error: unknown, parsed: URL, allowSelfSigned: boolean) {
    const source = (error as any)?.cause || error as any;
    const code = String(source?.code || '').trim();
    const host = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    if (['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) {
      return new BadRequestException(`Synology HTTPS certificate could not be verified for ${host}. Use the NAS certificate hostname, install its CA certificate on the VaultBack host, or enable “Allow self-signed certificate” for this target${allowSelfSigned ? '' : ' (only for a trusted private network)'}.`);
    }
    if (code === 'ECONNREFUSED') return new BadRequestException(`VaultBack could not connect to Synology at ${host}. Check that WebDAV Server is enabled and the port is correct.`);
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return new BadRequestException(`Synology at ${host} did not respond. Check the NAS firewall, network route, and WebDAV port.`);
    if (code === 'ENOTFOUND') return new BadRequestException(`VaultBack could not resolve the WebDAV host ${parsed.hostname}. Check the hostname or DNS settings.`);
    const detail = String(source?.message || (error as any)?.message || 'Unknown network error').replace(/\s+/g, ' ').slice(0, 240);
    return new BadRequestException(`Could not reach WebDAV at ${host}. Check the URL, port, Synology WebDAV service, firewall, and HTTPS certificate${detail ? `: ${detail}` : '.'}`);
  }
  private async uploadWebdav(target: StorageTarget, localFile: string, filename: string) { const c = target.config as any; const base = String(c.url).replace(/\/$/, ''); const response = await this.webdavRequest(target, `${base}/${encodeURIComponent(filename)}`, { method: 'PUT', headers: { ...this.webdavHeaders(target), 'Content-Type': 'application/octet-stream' }, body: fs.createReadStream(localFile) }); if (response.status < 200 || response.status >= 300) throw new BadRequestException(`WebDAV upload returned ${response.status}`); return { location: `${base}/${filename}` }; }
  private async downloadWebdav(target: StorageTarget, filename: string, output: string) { const c = target.config as any; const base = String(c.url).replace(/\/$/, ''); const response = await this.webdavRequest(target, `${base}/${encodeURIComponent(filename)}`, { method: 'GET', headers: this.webdavHeaders(target), output }); if (response.status < 200 || response.status >= 300) { fs.rmSync(output, { force: true }); throw new BadRequestException(`WebDAV download returned ${response.status}`); } }
  private async uploadGoogleDrive(target: StorageTarget, localFile: string, filename: string) {
    const c = target.config as any; const content = fs.readFileSync(localFile); const send = async (token: string) => {
      const boundary = `vaultback-${crypto.randomUUID()}`; const metadata = JSON.stringify({ name: filename, parents: c.folderId ? [c.folderId] : undefined });
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--`) ]);
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    };
    let response = await send(await this.accessToken(target, 'google-drive'));
    if (response.status === 401 && c.refreshToken) response = await send(await this.accessToken(target, 'google-drive', true));
    if (!response.ok) throw new Error(`Google Drive upload returned ${response.status}`);
    const result = await response.json() as any; return { location: `gdrive://${result.id}` };
  }
  private async uploadOneDrive(target: StorageTarget, localFile: string, filename: string) {
    const c = target.config as any; const content = fs.readFileSync(localFile); const remotePath = String(c.remotePath || filename).replace(/^\/+/, '');
    const send = (token: string) => fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${remotePath}:/content`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: content });
    let response = await send(await this.accessToken(target, 'onedrive'));
    if (response.status === 401 && c.refreshToken) response = await send(await this.accessToken(target, 'onedrive', true));
    if (!response.ok) throw new Error(`OneDrive upload returned ${response.status}`);
    const result = await response.json() as any; return { location: `onedrive://${result.id}` };
  }
  private async downloadGoogleDrive(target: StorageTarget, filename: string, location: string | undefined, output: string) { const id = String(location || '').replace(/^gdrive:\/\//, ''); if (!id || id === String(location)) throw new BadRequestException(`Google Drive file ID is unavailable for ${filename}`); let response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${await this.accessToken(target, 'google-drive')}` } }); if (response.status === 401 && (target.config as any).refreshToken) response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${await this.accessToken(target, 'google-drive', true)}` } }); if (!response.ok) throw new BadRequestException(`Google Drive download returned ${response.status}`); await this.writeResponse(response, output); }
  private async downloadOneDrive(target: StorageTarget, filename: string, location: string | undefined, output: string) { const c = target.config as any; const id = String(location || '').replace(/^onedrive:\/\//, ''); const url = id && id !== String(location) ? `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(id)}/content` : `https://graph.microsoft.com/v1.0/me/drive/root:/${String(c.remotePath || filename).replace(/^\/+/, '')}:/content`; let response = await fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken(target, 'onedrive')}` } }); if (response.status === 401 && c.refreshToken) response = await fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken(target, 'onedrive', true)}` } }); if (!response.ok) throw new BadRequestException(`OneDrive download returned ${response.status}`); await this.writeResponse(response, output); }
  private async writeResponse(response: Response, output: string) { const data = Buffer.from(await response.arrayBuffer()); fs.writeFileSync(output, data, { mode: 0o600 }); }
  private async accessToken(target: StorageTarget, provider: 'google-drive' | 'onedrive', forceRefresh = false) {
    const c = target.config as any;
    if (c.accessToken && !forceRefresh) return String(c.accessToken);
    if (!c.refreshToken || !c.clientId || !c.clientSecret) throw new Error(`${provider === 'google-drive' ? 'Google Drive' : 'OneDrive'} needs an access token or complete refresh-token OAuth credentials`);
    const tokenUrl = provider === 'google-drive'
      ? 'https://oauth2.googleapis.com/token'
      : `https://login.microsoftonline.com/${encodeURIComponent(String(c.tenantId || 'common'))}/oauth2/v2.0/token`;
    const params = new URLSearchParams({ client_id: String(c.clientId), client_secret: String(c.clientSecret), refresh_token: String(c.refreshToken), grant_type: 'refresh_token' });
    if (provider === 'onedrive') params.set('scope', 'https://graph.microsoft.com/.default offline_access');
    const response = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
    if (!response.ok) throw new Error(`${provider === 'google-drive' ? 'Google' : 'Microsoft'} OAuth token refresh returned ${response.status}`);
    const result = await response.json() as any; if (!result.access_token) throw new Error('OAuth provider did not return an access token');
    c.accessToken = result.access_token; if (result.refresh_token) c.refreshToken = result.refresh_token;
    this.store.db.prepare('UPDATE storage_targets SET config_enc=? WHERE id=?').run(this.store.encrypt(c), target.id); target.config = c;
    return String(c.accessToken);
  }
  private redact(config: Record<string, unknown>) { const copy = { ...config }; for (const key of ['password', 'token', 'accessToken', 'refreshToken', 'clientSecret', 'webhookToken', 'botToken']) delete copy[key]; return copy; }
}
