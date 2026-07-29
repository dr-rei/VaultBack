import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { ensureDirectory, isWithin } from './backup.utils';

type InstallState = 'queued' | 'downloading' | 'verifying' | 'extracting' | 'completed' | 'failed';
type InstallJob = {
  id: string;
  package: string;
  version: string;
  state: InstallState;
  message: string;
  bytesDownloaded: number;
  totalBytes: number | null;
  percent: number | null;
  startedAt: string;
  updatedAt: string;
  error?: string;
};

type ToolPackage = {
  engine: 'mariadb';
  version: string;
  archive: string;
  checksum: string;
  kind: 'zip' | 'tar.gz';
  platform: string;
  architecture: string;
  note: string;
};

const RELEASE = '11.8.6';
const OFFICIAL_ARCHIVE = 'https://archive.mariadb.org';
const MAX_ARCHIVE_BYTES = 520 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1_500 * 1024 * 1024;

@Injectable()
export class ToolInstallerService {
  private readonly logger = new Logger(ToolInstallerService.name);
  private readonly jobs = new Map<string, InstallJob>();
  private activeJob: string | null = null;

  availablePackages() {
    const pkg = this.packageForHost();
    return { supported: Boolean(pkg), packages: pkg ? [{ ...pkg, source: OFFICIAL_ARCHIVE }] : [], platform: process.platform, architecture: process.arch };
  }

  startInstall() {
    const existing = this.activeJob ? this.jobs.get(this.activeJob) : undefined;
    if (existing && ['queued', 'downloading', 'verifying', 'extracting'].includes(existing.state)) return existing;
    const pkg = this.packageForHost();
    if (!pkg) throw new BadRequestException(`Automatic tool setup is not available for ${process.platform}/${process.arch}. Use the manual portable-tool instructions.`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const job: InstallJob = { id, package: pkg.engine, version: pkg.version, state: 'queued', message: 'Preparing the official database tool package…', bytesDownloaded: 0, totalBytes: null, percent: 0, startedAt: now, updatedAt: now };
    this.jobs.set(id, job); this.activeJob = id; this.pruneJobs();
    void this.run(job, pkg);
    return job;
  }

  repair() {
    if (!this.packageForHost()) throw new BadRequestException(`Automatic tool repair is not available for ${process.platform}/${process.arch}. Use the manual portable-tool instructions.`);
    const existing = this.activeJob ? this.jobs.get(this.activeJob) : undefined;
    if (existing && ['queued', 'downloading', 'verifying', 'extracting'].includes(existing.state)) return { ...existing, repair: true, removed: false };
    const target = path.join(process.cwd(), 'tools', 'mariadb', `${process.platform}-${process.arch}`);
    let removed = false;
    if (isWithin(path.join(process.cwd(), 'tools', 'mariadb'), target) && fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      ensureDirectory(path.join(target, 'bin'));
      fs.writeFileSync(path.join(target, 'bin', '.gitkeep'), '\n');
      removed = true;
    }
    return { ...this.startInstall(), repair: true, removed };
  }

  status(id: string) {
    return this.jobs.get(id) || { id, state: 'failed', message: 'Tool setup job not found', error: 'Tool setup job not found' };
  }

  private packageForHost(): ToolPackage | null {
    if (process.arch !== 'x64') return null;
    if (process.platform === 'win32') return { engine: 'mariadb', version: RELEASE, archive: `${OFFICIAL_ARCHIVE}/mariadb-${RELEASE}/winx64-packages/mariadb-${RELEASE}-winx64.zip`, checksum: `${OFFICIAL_ARCHIVE}/mariadb-${RELEASE}/winx64-packages/sha256sums.txt`, kind: 'zip', platform: 'win32-x64', architecture: 'x64', note: 'The MariaDB community client pack supplies compatible client and dump tools for MySQL and MariaDB servers.' };
    if (process.platform === 'linux') return { engine: 'mariadb', version: RELEASE, archive: `${OFFICIAL_ARCHIVE}/mariadb-${RELEASE}/bintar-linux-systemd-x86_64/mariadb-${RELEASE}-linux-systemd-x86_64.tar.gz`, checksum: `${OFFICIAL_ARCHIVE}/mariadb-${RELEASE}/bintar-linux-systemd-x86_64/sha256sums.txt`, kind: 'tar.gz', platform: 'linux-x64', architecture: 'x64', note: 'The MariaDB community client pack supplies compatible client and dump tools for MySQL and MariaDB servers.' };
    return null;
  }

  private async run(job: InstallJob, pkg: ToolPackage) {
    const work = path.join(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')), 'tmp', 'tool-installs', job.id);
    ensureDirectory(work);
    const archive = path.join(work, pkg.kind === 'zip' ? 'client-pack.zip' : 'client-pack.tar.gz');
    try {
      this.update(job, 'downloading', 'Downloading the official MariaDB client package…');
      await this.download(pkg.archive, archive, job);
      this.update(job, 'verifying', 'Verifying the official SHA-256 checksum…');
      await this.verifyChecksum(pkg.checksum, path.basename(pkg.archive), archive);
      this.update(job, 'extracting', 'Extracting and checking the client and dump tools…');
      const staging = path.join(work, 'extracted'); ensureDirectory(staging);
      if (pkg.kind === 'zip') this.extractZip(archive, staging); else this.extractTarGz(archive, staging);
      const bin = this.findBinaryDirectory(staging);
      if (!bin) throw new Error('The downloaded package did not contain the expected MariaDB client tools.');
      const target = path.join(process.cwd(), 'tools', 'mariadb', pkg.platform);
      ensureDirectory(path.dirname(target));
      fs.cpSync(bin.root, target, { recursive: true, force: true });
      const client = this.findTool(target, ['mariadb', 'mysql']);
      const dump = this.findTool(target, ['mariadb-dump', 'mysqldump']);
      if (!client || !dump) throw new Error('The extracted package is missing a client or dump executable.');
      if (process.platform !== 'win32') for (const file of [client, dump]) try { fs.chmodSync(file, 0o755); } catch {}
      fs.writeFileSync(path.join(target, '.vaultback-managed.json'), JSON.stringify({ package: pkg.engine, version: pkg.version, installedAt: new Date().toISOString() }), { mode: 0o600 });
      this.update(job, 'completed', 'Database tools installed and ready.'); job.percent = 100;
    } catch (error: any) {
      const message = String(error?.message || error).slice(0, 500);
      job.state = 'failed'; job.error = message; job.message = `Tool setup failed: ${message}`; job.updatedAt = new Date().toISOString();
      this.logger.warn(`Tool setup ${job.id} failed: ${message}`);
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      if (this.activeJob === job.id) this.activeJob = null;
    }
  }

  private update(job: InstallJob, state: InstallState, message: string) { job.state = state; job.message = message; job.updatedAt = new Date().toISOString(); }

  private async download(url: string, output: string, job: InstallJob) {
    const response = await this.officialFetch(url);
    if (!response.body) throw new Error('The official download returned no file data.');
    const length = Number(response.headers.get('content-length') || 0); if (length > MAX_ARCHIVE_BYTES) throw new Error('The official package is larger than the safe download limit.');
    job.totalBytes = length || null; job.bytesDownloaded = 0; job.percent = 0;
    const stream = Readable.fromWeb(response.body as any); const file = fs.createWriteStream(output, { flags: 'wx', mode: 0o600 });
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); job.bytesDownloaded += buffer.length;
        if (job.bytesDownloaded > MAX_ARCHIVE_BYTES) throw new Error('The official package exceeded the safe download limit.');
        if (job.totalBytes) job.percent = Math.min(99, Math.round(job.bytesDownloaded / job.totalBytes * 100));
        if (!file.write(buffer)) await new Promise<void>(resolve => file.once('drain', resolve));
      }
      await new Promise<void>((resolve, reject) => { file.end((error?: Error | null) => error ? reject(error) : resolve()); });
    } catch (error) { file.destroy(); throw error; }
  }

  private async officialFetch(url: string) {
    const parsed = new URL(url); if (parsed.protocol !== 'https:' || !this.isOfficialHost(parsed.hostname)) throw new Error('Blocked non-official tool download source.');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000); timer.unref?.();
    try {
      const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'VaultBack tool setup' } });
      const finalHost = new URL(response.url || url).hostname;
      if (!response.ok || !this.isOfficialHost(finalHost)) throw new Error(`Official download returned HTTP ${response.status}.`);
      return response;
    } catch (error: any) { if (error?.name === 'AbortError') throw new Error('Official download timed out.'); throw error; } finally { clearTimeout(timer); }
  }

  private isOfficialHost(host: string) { return host === 'archive.mariadb.org' || host === 'mariadb.org' || host.endsWith('.mariadb.org'); }

  private async verifyChecksum(checksumUrl: string, filename: string, file: string) {
    const response = await this.officialFetch(checksumUrl); const text = await response.text();
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const match = text.match(new RegExp(`^\\s*([a-f0-9]{64})\\s+[* ]?(?:\\.\\/)?${escaped}\\s*$`, 'im'));
    if (!match) throw new Error('The official SHA-256 checksum for this package was not found.');
    const hash = await this.sha256(file); if (hash !== match[1].toLowerCase()) throw new Error('Checksum verification failed; the package was not installed.');
  }

  private async sha256(file: string) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

  private extractZip(archive: string, destination: string) {
    const data = fs.readFileSync(archive); const end = this.findSignature(data, 0x06054b50, Math.max(0, data.length - 0xffff - 22)); if (end < 0) throw new Error('Invalid ZIP archive.');
    const count = data.readUInt16LE(end + 10); const directorySize = data.readUInt32LE(end + 12); const directoryOffset = data.readUInt32LE(end + 16); if (directoryOffset + directorySize > data.length) throw new Error('Invalid ZIP directory.');
    let cursor = directoryOffset; let extracted = 0;
    for (let i = 0; i < count; i++) {
      if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry.');
      const method = data.readUInt16LE(cursor + 10); const compressed = data.readUInt32LE(cursor + 20); const size = data.readUInt32LE(cursor + 24); const nameLength = data.readUInt16LE(cursor + 28); const extraLength = data.readUInt16LE(cursor + 30); const commentLength = data.readUInt16LE(cursor + 32); const localOffset = data.readUInt32LE(cursor + 42); const name = this.safeArchivePath(data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
      cursor += 46 + nameLength + extraLength + commentLength; if (!name || name.endsWith('/')) continue; if (size > MAX_EXTRACTED_BYTES || extracted + size > MAX_EXTRACTED_BYTES) throw new Error('The extracted package is larger than the safe limit.');
      if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP local entry.'); const localName = data.readUInt16LE(localOffset + 26); const localExtra = data.readUInt16LE(localOffset + 28); const start = localOffset + 30 + localName + localExtra; const compressedData = data.subarray(start, start + compressed); let content: Buffer;
      if (method === 0) content = Buffer.from(compressedData); else if (method === 8) content = inflateRawSync(compressedData); else throw new Error('Unsupported ZIP compression method.');
      if (content.length !== size) throw new Error('ZIP entry size verification failed.'); this.writeExtracted(destination, name, content); extracted += content.length;
    }
  }

  private extractTarGz(archive: string, destination: string) {
    // Linux MariaDB binary tarballs are large and can exceed the Node heap if
    // gunzipped into one Buffer. Validate every archive path first, then use
    // the platform's standard tar extractor without invoking a shell.
    let listing: string;
    try { listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true }); }
    catch { throw new Error('The Linux archive could not be inspected. Confirm that the standard tar utility is available.'); }
    const entries = listing.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!entries.length || entries.length > 100000) throw new Error('The Linux archive contains an unexpected number of entries.');
    for (const entry of entries) this.safeArchivePath(entry);
    try { execFileSync('tar', ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions'], { stdio: 'pipe', windowsHide: true, maxBuffer: 2 * 1024 * 1024 }); }
    catch { throw new Error('The Linux archive could not be extracted. Confirm that the standard tar utility is available.'); }
  }

  private safeArchivePath(value: string) { const name = value.replace(/\\/g, '/'); if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) throw new Error('The archive contains an unsafe path.'); return name; }

  private writeExtracted(root: string, name: string, content: Buffer) { const target = path.resolve(root, ...name.split('/')); if (!isWithin(root, target)) throw new Error('The archive contains a path outside the extraction directory.'); ensureDirectory(path.dirname(target)); fs.writeFileSync(target, content, { mode: 0o600 }); }

  private findSignature(buffer: Buffer, signature: number, start: number) { for (let index = buffer.length - 4; index >= start; index--) if (buffer.readUInt32LE(index) === signature) return index; return -1; }

  private findBinaryDirectory(root: string) { const client = this.findTool(root, ['mariadb', 'mysql']); const dump = this.findTool(root, ['mariadb-dump', 'mysqldump']); if (!client || !dump) return null; const binRoot = path.dirname(client); if (path.basename(binRoot).toLowerCase() !== 'bin' || binRoot !== path.dirname(dump)) return null; return { root: this.packageRoot(root, binRoot) }; }
  private packageRoot(staging: string, bin: string) { const relative = path.relative(path.resolve(staging), bin).split(path.sep).filter(Boolean); return relative.length === 1 && relative[0].toLowerCase() === 'bin' ? path.resolve(staging) : path.join(path.resolve(staging), relative[0] || ''); }
  private findTool(root: string, names: string[]) { const wanted = new Set(names.map(name => process.platform === 'win32' ? `${name}.exe`.toLowerCase() : name)); const visit = (dir: string, depth: number): string | null => { if (depth > 8) return null; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { const found = visit(full, depth + 1); if (found) return found; } else if (entry.isFile() && wanted.has(entry.name.toLowerCase()) && path.basename(path.dirname(full)).toLowerCase() === 'bin') return full; } return null; }; return visit(root, 0); }
  private pruneJobs() { if (this.jobs.size <= 20) return; for (const [id, job] of this.jobs) if (job.state === 'completed' || job.state === 'failed') { this.jobs.delete(id); if (this.jobs.size <= 20) break; } }
}
