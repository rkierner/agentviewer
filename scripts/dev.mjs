// Runs the collector and the Vite dev server together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  ['collector', 'npx', ['tsx', 'watch', '--clear-screen=false', 'server/collector.ts']],
  ['ui', 'npx', ['vite']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = `\x1b[32m[${name}]\x1b[0m `;
  const pipe = (s) => s.on('data', (d) => process.stdout.write(d.toString().replace(/^(?=.)/gm, tag)));
  pipe(p.stdout);
  pipe(p.stderr);
  p.on('exit', (code) => {
    console.log(`${tag}exited (${code})`);
    shutdown();
  });
  return p;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
