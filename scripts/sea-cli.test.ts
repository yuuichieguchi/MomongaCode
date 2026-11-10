import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { startFakeChatCompletions, productTestEnv, execProductFile } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import cliPackage from '../packages/cli/package.json' with { type: 'json' };
import { chatCompletions, textReply, toolCallReply } from '../e2e/support/upstream.ts';
import { defaultEntry } from './bundle.ts';
import { buildSea } from './sea.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { RUNS_MACOS_ARM64_ARTIFACTS } from './support/host.ts';

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

describe.skipIf(!RUNS_MACOS_ARM64_ARTIFACTS)('single executable built from the real CLI entry', () => {
  let root = '';
  let binary = '';
  let project = '';
  let paths: MomongaPaths;
  let upstream: FakeChatCompletionsServer;

  const run = (...args: string[]): Promise<Invocation> =>
    new Promise((resolve, reject) => {
      execProductFile(binary, args, { cwd: project, env: productTestEnv({ PATH: '/usr/bin:/bin', HOME: root }), encoding: 'utf8' }, (error, stdout, stderr) => {
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
              provider: 'fake',
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
  }, UNBOUNDED_BUILD_WAIT_MS);

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

  it('proves the permission rules of a folder with the Z3 solver it carries, extracting the solver once into the cache folder', async () => {
    const original = fs.readFileSync(paths.settingsFile, 'utf8');
    fs.writeFileSync(paths.settingsFile, JSON.stringify({ ...(JSON.parse(original) as Record<string, unknown>), permissions: { allow: ['Bash(git status:*)'], deny: ['Bash(git push:*)'] } }));
    try {
      const first = await run('policy', 'verify', '--json');

      expect(first.stderr).toBe('');
      expect(first.status).toBe(0);
      const report = JSON.parse(first.stdout) as { solver: string; results: { id: string; verdict: { status: string } }[]; outsideProof: string[] };
      expect(report.solver).toMatch(/^Z3 \d+\.\d+\.\d+/);
      expect(report.results.map((result) => result.verdict.status)).toEqual(['proved', 'proved', 'proved', 'proved']);
      expect(report.outsideProof.length).toBeGreaterThan(0);
      const extracted = fs.readdirSync(paths.executables).filter((name) => name.startsWith('z3-'));
      expect(extracted).toHaveLength(1);
      expect(fs.readdirSync(path.join(paths.executables, extracted[0] as string)).sort()).toEqual(['z3-api.cjs', 'z3-built.js']);

      const second = await run('policy', 'verify', '--json');
      expect(second.status).toBe(0);
      expect(fs.readdirSync(paths.executables).filter((name) => name.startsWith('z3-'))).toEqual(extracted);
    } finally {
      fs.writeFileSync(paths.settingsFile, original);
    }
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
