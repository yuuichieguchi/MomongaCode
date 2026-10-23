import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { countFakeTokens, startFakeChatCompletions } from './fake-chat-completions.ts';
import type { FakeFmConfig } from './fake-fm.ts';

export interface RunFakeFmOptions {
  configPath: string;
  argv: readonly string[];
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const SURVIVOR_SOURCE = [
  "process.on('SIGTERM', () => {});",
  "require('node:fs').writeFileSync(process.argv[1], `${process.pid}\\n`);",
  'setInterval(() => {}, 1 << 30);',
].join(' ');
const MARKER_FD = 3;

const hasMarkerFd = (): boolean => {
  try {
    fs.fstatSync(MARKER_FD);
    return true;
  } catch {
    return false;
  }
};

const forkSurvivor = (pidFile: string): void => {
  const stdio: Array<'ignore' | number> = ['ignore', 'ignore', 'ignore'];
  if (hasMarkerFd()) stdio[MARKER_FD] = MARKER_FD;
  const survivor = spawn(process.execPath, ['-e', SURVIVOR_SOURCE, pidFile], { stdio });
  survivor.unref();
};

const DETACHED_HELPER_SOURCE = [
  "const fs = require('node:fs');",
  "process.on('SIGTERM', () => {});",
  'try { fs.closeSync(3); } catch {}',
  "fs.writeFileSync(process.argv[1], `${process.pid}\\n`);",
  'setInterval(() => {}, 1 << 30);',
].join(' ');

const forkDetachedHelper = (pidFile: string): void => {
  const stdio: Array<'ignore' | number> = ['ignore', 'ignore', 'ignore'];
  if (hasMarkerFd()) stdio[MARKER_FD] = MARKER_FD;
  const helper = spawn(process.execPath, ['-e', DETACHED_HELPER_SOURCE, pidFile], { stdio });
  helper.unref();
};

const serve = async (argv: readonly string[], config: FakeFmConfig): Promise<void> => {
  const flagIndex = argv.indexOf('--socket');
  const socketPath = flagIndex < 0 ? undefined : argv[flagIndex + 1];
  if (socketPath === undefined) throw new Error('fm serve requires --socket <path>');
  if (config.serveSurvivorPidFile !== undefined) forkSurvivor(config.serveSurvivorPidFile);
  if (config.serveDetachedHelperPidFile !== undefined) forkDetachedHelper(config.serveDetachedHelperPidFile);
  const server = await startFakeChatCompletions({ scenario: 'tools-ok', ...config.serve, socketPath });
  process.once('SIGTERM', () => {
    void server.close().finally(() => process.exit(0));
  });
};

export const runFakeFm = async ({ configPath, argv }: RunFakeFmOptions): Promise<void> => {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as FakeFmConfig;
  if (config.envDumpFile !== undefined) {
    fs.appendFileSync(config.envDumpFile, `${JSON.stringify({ argv, pid: process.pid, env: process.env })}\n`);
  }
  const [command] = argv;
  if (command === 'serve') return serve(argv, config);
  if (command === 'license' || command === 'available') return;
  if (command === 'count-tokens') {
    process.stdout.write(`${countFakeTokens(await readStdin())}\n`);
    return;
  }
  process.stderr.write(`fake fm: unknown command ${JSON.stringify(command)}\n`);
  process.exitCode = 2;
};
