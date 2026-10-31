import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { DataOwner } from '../src/database/data-owner';

describe('DATA_DIR writer ownership', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultback-owner-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
  it('rejects another process while a live owner holds the directory', () => {
    const release = DataOwner.acquire(directory);
    const source = fs.readFileSync(path.join(__dirname, '../src/database/data-owner.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const script = path.join(directory, 'owner.cjs'); fs.writeFileSync(script, compiled);
    const child = spawnSync(process.execPath, ['-e', 'try { require(process.argv[1]).DataOwner.acquire(process.argv[2]); process.exit(2); } catch { process.exit(0); }', script, directory]);
    expect(child.status).toBe(0); release();
    const again = DataOwner.acquire(directory); again(); again();
  });
  it('allows independent directories and recovers only a confirmed dead owner', () => {
    const first = DataOwner.acquire(directory);
    const other = path.join(directory, 'other'); const second = DataOwner.acquire(other);
    expect(() => DataOwner.acquire(directory)).toThrow('live writer');
    second(); first();
    // A just-exited child supplies a real dead PID instead of assuming a platform PID range.
    const dead = spawnSync(process.execPath, ['-e', '']);
    fs.writeFileSync(path.join(directory, '.vaultback-owner'), JSON.stringify({ pid: dead.pid, token: 'old' }));
    DataOwner.acquire(directory)();
  });
  it('fails closed for malformed ownership or abandoned recovery gates', () => {
    fs.writeFileSync(path.join(directory, '.vaultback-owner'), 'broken');
    expect(() => DataOwner.acquire(directory)).toThrow('ambiguous');
    fs.writeFileSync(path.join(directory, '.vaultback-owner.gate'), '');
    expect(() => DataOwner.acquire(directory)).toThrow('gate');
  });
});
