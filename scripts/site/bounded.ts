import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const SIGNAL_EXIT_BASE = 128;
const STOPPING_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const [secondsText, command, ...args] = process.argv.slice(2);
const seconds = Number(secondsText);
if (command === undefined || !Number.isFinite(seconds) || seconds <= 0) {
  process.stderr.write('usage: node scripts/site/bounded.ts <seconds> <command> [<argument> ...]\n');
  process.exit(2);
}

const child = spawn(command, args, { stdio: 'inherit', detached: true });
const group = child.pid;
let running = group !== undefined;

const stopGroup = (): void => {
  if (running && group !== undefined) process.kill(-group, 'SIGKILL');
};

child.on('error', (error) => {
  throw error;
});

const bound = setTimeout(() => {
  process.stderr.write(`site-deploy.sh: ${command} did not finish within ${secondsText} seconds and was stopped\n`);
  stopGroup();
  process.exit(1);
}, seconds * 1000);

for (const signal of STOPPING_SIGNALS) {
  process.on(signal, () => {
    stopGroup();
    process.exit(SIGNAL_EXIT_BASE + constants.signals[signal]);
  });
}

child.on('exit', (code, signal) => {
  running = false;
  clearTimeout(bound);
  if (signal !== null) {
    process.stderr.write(`site-deploy.sh: ${command} was stopped by ${signal}\n`);
    process.exit(1);
  }
  process.exit(code);
});
