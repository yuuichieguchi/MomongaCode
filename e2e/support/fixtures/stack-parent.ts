import { spawn } from 'node:child_process';

export type StackParentRequest = { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };

export type StackParentReport = { readonly supervisorPid: number };

const HOLD_OPEN_INTERVAL_MS = 60_000;

const isRequest = (value: unknown): value is StackParentRequest =>
  typeof value === 'object' &&
  value !== null &&
  'args' in value &&
  Array.isArray(value.args) &&
  value.args.every((arg) => typeof arg === 'string') &&
  'env' in value &&
  typeof value.env === 'object' &&
  value.env !== null;

export const stackParentMain = async (argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
  const raw = argv[0];
  if (raw === undefined) throw new Error('the stack parent requires a JSON request argument');
  const request: unknown = JSON.parse(raw);
  if (!isRequest(request)) throw new Error('the stack parent request must carry args and env');
  const supervisor = spawn(process.execPath, [...request.args], { env: { ...request.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  if (supervisor.pid === undefined) throw new Error('the supervisor did not start');
  supervisor.stdout.resume();
  supervisor.stderr.resume();
  supervisor.stdin.on('error', () => undefined);
  const report: StackParentReport = { supervisorPid: supervisor.pid };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  setInterval(() => undefined, HOLD_OPEN_INTERVAL_MS);
};

if (import.meta.main) await stackParentMain();
