import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** One local writer. Ambiguous metadata and abandoned recovery gates fail closed. */
export class DataOwner {
  static acquire(dataDir: string): () => void {
    fs.mkdirSync(dataDir, { recursive: true });
    const lock = path.join(fs.realpathSync(dataDir), '.vaultback-owner');
    const gate = `${lock}.gate`;
    let gateFd: number;
    try { gateFd = fs.openSync(gate, 'wx', 0o600); }
    catch { throw new Error('DATA_DIR ownership is being checked; another writer or an abandoned ownership gate exists'); }
    const token = crypto.randomUUID();
    try {
      if (fs.existsSync(lock)) {
        let owner: { pid: number; token: string };
        try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); }
        catch { throw new Error('DATA_DIR ownership is ambiguous'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token) throw new Error('DATA_DIR ownership is ambiguous');
        let dead = false;
        try { process.kill(owner.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') dead = true; else throw new Error('DATA_DIR owner cannot be verified'); }
        if (!dead) throw new Error('DATA_DIR already has a live writer');
        fs.unlinkSync(lock);
      }
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    } finally { fs.closeSync(gateFd); fs.unlinkSync(gate); }
    let released = false;
    return () => {
      if (released) return;
      const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (owner.token !== token || owner.pid !== process.pid) throw new Error('DATA_DIR ownership changed unexpectedly');
      fs.unlinkSync(lock); released = true;
    };
  }
}
