import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import cliPackage from '../packages/cli/package.json' with { type: 'json' };
import { chatCompletions, textReply, toolCallReply } from '../e2e/support/upstream.ts';
import { defaultEntry } from './bundle.ts';
import { buildSea } from './sea.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const ORIGINAL = 'greeting = "hello"\n';
const EDITED = 'greeting = "hello, momonga"\n';
const FINAL_TEXT = 'Updated the greeting in config.toml.';
const UPSTREAM_TARGET = 'primary';

type Invocation = { status: number | null; stdout: string; stderr: string };

type ProcessRow = { pid: number; ppid: number; command: string };

const processTable = (): ProcessRow[] =>
  execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match === null) throw new Error(`unreadable ps line: ${line}`);
      return { pid: Number(match[1]), ppid: Number(match[2]), command: (match[3] as string).trim() };
    });

const familyOf = (rootPid: number, table: readonly ProcessRow[]): ProcessRow[] => {
  const family = table.filter((row) => row.pid === rootPid);
  for (let index = 0; index < family.length; index += 1) {
    const parent = family[index] as ProcessRow;
    family.push(...table.filter((row) => row.ppid === parent.pid));
  }
  return family;
};

describe('single executable built from the real CLI entry', () => {
  let root = '';
  let binary = '';
  let project = '';
  let paths: MomongaPaths;
  let upstream: FakeChatCompletionsServer;

  const run = (...args: string[]): Promise<Invocation> =>
    new Promise((resolve, reject) => {
      execFile(binary, args, { cwd: project, env: { PATH: '/usr/bin:/bin', HOME: root }, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') reject(error);
        else resolve({ status: error === null ? 0 : (error.code as number), stdout, stderr });
      });
    });

  beforeAll(async () => {
    root = fs.realpathSync(createTempRoot());
    binary = path.join(root, 'bin', 'momonga');
    project = path.join(root, 'p');
    paths = momongaLayout(root);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'config.toml'), ORIGINAL);
    const target = path.join(project, 'config.toml');
    upstream = await startFakeChatCompletions({
      scenario: 'tools-ok',
      maxConcurrency: 8,
      socketPath: path.join(root, 'u.sock'),
      script: [
        toolCallReply('Read', { file_path: target }, 'call_read'),
        toolCallReply('Edit', { file_path: target, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_edit'),
        textReply(FINAL_TEXT),
      ],
    });
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(
      paths.settingsFile,
      JSON.stringify({
        models: {
          aliases: { default: [UPSTREAM_TARGET] },
          targets: {
            [UPSTREAM_TARGET]: {
              adapter: 'chat-completions',
              model: 'system',
              socketPath: path.join(root, 'u.sock'),
              capabilities: { contextWindow: 8192, maxOutputTokens: 1024 },
            },
          },
        },
        sandbox: 'none',
      }),
    );
    await buildSea({ entry: defaultEntry, output: binary, workDir: path.join(root, 'work') });
  });

  afterAll(async () => {
    if (binary !== '') await run('daemon', 'stop');
    await upstream.close();
    removeTempRoot(root);
  });

  it('prints its version on a PATH that contains no node', async () => {
    expect(fs.existsSync('/usr/bin/node')).toBe(false);
    expect(fs.existsSync('/bin/node')).toBe(false);

    expect(await run('--version')).toEqual({ status: 0, stdout: `${cliPackage.version}\n`, stderr: '' });
  });

  it('completes a Read and Edit task through a daemon it starts from the same binary, and the file on disk changes', async () => {
    const result = await run('-p', 'Update the greeting', '--permission-mode', 'acceptEdits');

    expect(result).toEqual({ status: 0, stdout: `${FINAL_TEXT}\n`, stderr: '' });
    expect(fs.readFileSync(path.join(project, 'config.toml'), 'utf8')).toBe(EDITED);
    expect(chatCompletions(upstream)).toHaveLength(3);

    const status = await run('daemon', 'status');
    const supervisorPid = Number(/pid (\d+)/.exec(status.stdout)?.[1]);
    const family = familyOf(supervisorPid, processTable());
    expect(family.length).toBeGreaterThanOrEqual(3);
    expect(family.map((row) => row.command)).toEqual(family.map(() => binary));
  });

  it('stops the daemon through momonga daemon stop', async () => {
    const before = familyOf(Number(/pid (\d+)/.exec((await run('daemon', 'status')).stdout)?.[1]), processTable());

    const stopped = await run('daemon', 'stop');

    expect(stopped).toEqual({ status: 0, stdout: 'momonga daemon stopped\n', stderr: '' });
    const remaining = new Set(processTable().map((row) => row.pid));
    expect(before.filter((row) => remaining.has(row.pid))).toEqual([]);
    expect((await run('daemon', 'status')).stdout).toBe('momonga daemon is not running\n');
  });
});
