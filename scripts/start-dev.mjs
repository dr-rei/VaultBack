import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typescript = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const options = { cwd: root, stdio: 'inherit', windowsHide: true };

// NestJS needs TypeScript's emitted decorator metadata for constructor injection.
const compiler = spawn(process.execPath, [typescript, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], options);
const server = spawn(process.execPath, ['--watch', 'dist/main.js'], options);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  compiler.kill();
  server.kill();
  process.exitCode = code;
}

compiler.on('error', error => { console.error(error); stop(1); });
server.on('error', error => { console.error(error); stop(1); });
compiler.on('exit', code => stop(code || 1));
server.on('exit', code => stop(code || 1));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
