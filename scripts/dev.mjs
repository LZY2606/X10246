import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

const server = spawn(process.execPath, ['src/server/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, FRINGE_PORT: process.env.FRINGE_PORT ?? '8787' },
});

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, ...args], {
  cwd: root,
  stdio: 'inherit',
});

function shutdown() {
  server.kill('SIGINT');
  vite.kill('SIGINT');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', (code) => {
  if (code && code !== 0) { vite.kill('SIGINT'); process.exit(code); }
});
