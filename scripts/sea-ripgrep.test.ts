import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { chatCompletions, textReply, toolCallReply } from '../e2e/support/upstream.ts';
import { defaultEntry } from './bundle.ts';
import { RIPGREP_VERSION } from './ripgrep-release.ts';
import { buildSea } from './sea.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { RUNS_MACOS_ARM64_ARTIFACTS } from './support/host.ts';

const UPSTREAM_TARGET = 'primary';
const NEEDLE = 'needle-token-7f3a';
const DONE = 'Searched.';
const RUNS = 4;

type Invocation = { status: number | null; stdout: string; stderr: string };

describe.skipIf(!RUNS_MACOS_ARM64_ARTIFACTS)('the built executable runs its embedded ripgrep on a PATH that has no rg', () => {
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

  const cacheEntries = (): string[] => fs.readdirSync(paths.executables).filter((name) => name.startsWith('ripgrep-'));

  const extractedRg = (): string => {
    const [directory] = cacheEntries();
    return path.join(paths.executables, directory as string, 'rg');
  };

  const searchRound = async (stderr = ''): Promise<string> => {
    const before = chatCompletions(upstream).length;
    const result = await run('-p', 'Find the needle', '--permission-mode', 'acceptEdits');
    expect(result).toEqual({ status: 0, stdout: `${DONE}\n`, stderr });
    const requests = chatCompletions(upstream);
    expect(requests.length - before).toBe(2);
    return JSON.stringify(requests[requests.length - 1]);
  };

  beforeAll(async () => {
    root = fs.realpathSync(createTempRoot());
    binary = path.join(root, 'bin', 'momonga');
    project = path.join(root, 'p');
    paths = momongaLayout(root);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'needle.txt'), `${NEEDLE}\n`);
    const script = [
      ...Array.from({ length: RUNS }, (_, index) => [toolCallReply('Grep', { pattern: NEEDLE }, `call_grep_${index}`), textReply(DONE)]).flat(),
      toolCallReply('Grep', { pattern: NEEDLE, glob: '', output_mode: 'content' }, 'call_grep_empty_glob'),
      textReply(DONE),
    ];
    upstream = await startFakeChatCompletions({ scenario: 'tools-ok', maxConcurrency: 8, socketPath: path.join(root, 'u.sock'), script });
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
  });

  afterAll(async () => {
    if (binary !== '') await run('daemon', 'stop');
    await upstream.close();
    removeTempRoot(root);
  });

  it('has no rg on the PATH it is started with', () => {
    expect(fs.existsSync('/usr/bin/rg')).toBe(false);
    expect(fs.existsSync('/bin/rg')).toBe(false);
  });

  it('finds the match through Grep, extracting rg and NOTICE.txt once into ripgrep-<version>-<hash> under the cache base', async () => {
    const lastRequest = await searchRound();
    expect(lastRequest).toContain('needle.txt');
    const entries = cacheEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(new RegExp(`^ripgrep-${RIPGREP_VERSION.replaceAll('.', '\\.')}-[0-9a-f]{16}$`));
    expect(fs.readdirSync(path.join(paths.executables, entries[0] as string)).sort()).toEqual(['NOTICE.txt', 'rg']);
  });

  it('restores rg when it was deleted, and finds the match again', async () => {
    fs.rmSync(extractedRg());
    expect(await searchRound()).toContain('needle.txt');
    expect(fs.existsSync(extractedRg())).toBe(true);
  });

  it('restores rg when it was truncated, and finds the match again', async () => {
    fs.truncateSync(extractedRg(), 10);
    expect(await searchRound()).toContain('needle.txt');
    expect(fs.statSync(extractedRg()).size).toBeGreaterThan(1_000_000);
    expect(fs.readdirSync(path.dirname(extractedRg())).filter((name) => name.startsWith('rg.partial-'))).toEqual([]);
  });

  it('tells the user how to choose another ripgrep when the selected one is not usable, and does not fall back to PATH', async () => {
    await run('daemon', 'stop');
    const original = fs.readFileSync(paths.settingsFile, 'utf8');
    fs.writeFileSync(paths.settingsFile, JSON.stringify({ ...(JSON.parse(original) as Record<string, unknown>), tools: { ripgrep: path.join(root, 'no-such-rg') } }));
    try {
      const lastRequest = await searchRound(`momonga: tool Grep ${NEEDLE} failed\n`);
      expect(lastRequest).toContain('ripgrep is not available');
      expect(lastRequest).toContain('no-such-rg');
      expect(lastRequest).not.toContain('needle.txt:');
    } finally {
      await run('daemon', 'stop');
      fs.writeFileSync(paths.settingsFile, original);
    }
  });

  it('carries an empty glob as ripgrep does on argv, filtering nothing, through the bundled ripgrep under the sandbox', async () => {
    await run('daemon', 'stop');
    const original = fs.readFileSync(paths.settingsFile, 'utf8');
    const { sandbox: _none, ...sandboxed } = JSON.parse(original) as Record<string, unknown>;
    fs.writeFileSync(paths.settingsFile, JSON.stringify(sandboxed));
    try {
      const lastRequest = await searchRound();
      expect(lastRequest).toContain(`needle.txt:1:${NEEDLE}`);
      expect(lastRequest).not.toContain('could not be read');
    } finally {
      await run('daemon', 'stop');
      fs.writeFileSync(paths.settingsFile, original);
    }
  });
});
