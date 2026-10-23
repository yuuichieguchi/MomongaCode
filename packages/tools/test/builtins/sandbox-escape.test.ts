import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { buildSandboxPolicy } from '@momonga/tools';
import { makeBuiltins, resultOf } from './fixtures.ts';
import type { Builtins, RunExtra } from './fixtures.ts';

const PROCESS_TIMEOUT = { timeout: 30_000 };
const HAS_SEATBELT = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

const escapeFixture = async (realSandbox: boolean) => {
  const tools = await makeBuiltins({ realSandbox });
  const { home, outside } = tools.layout;
  const momonga = path.join(home, '.momonga');
  const keychains = path.join(home, 'Library', 'Keychains');
  const sessions = momongaLayout(home, 'darwin', {}).tmp.sessions;
  const mine = path.join(sessions, 'session-1');
  const other = path.join(sessions, 'session-2');
  for (const dir of [momonga, keychains, mine, other]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const markerFor = (roots: string[]): string => path.join(roots[0] === '/' ? outside : (roots[0] as string), 'ran');
  const extraFor = (roots: string[], cwd: string): RunExtra => ({
    roots,
    home,
    session: { cwd, readLedger: new Map() },
    sandboxPolicy: buildSandboxPolicy({ roots, home, tmpDir: mine, sessionsTmpRoot: sessions }),
    tmpDir: mine,
  });
  return { tools, home, momonga, keychains, sessions, mine, other, markerFor, extraFor };
};

const bash = (tools: Builtins, command: string, extra: RunExtra) => tools.run('Bash', { command }, extra, 'allow_once');

describe.runIf(HAS_SEATBELT)('always-denied writes under real Seatbelt Bash', () => {
  it('cwd / cannot write home/.momonga', PROCESS_TIMEOUT, async () => {
    const fx = await escapeFixture(true);
    const target = path.join(fx.momonga, 'x');
    const result = resultOf(await bash(fx.tools, `touch '${fx.markerFor(['/'])}' && printf escaped > '${target}'`, fx.extraFor(['/'], '/')));
    expect(fs.existsSync(fx.markerFor(['/']))).toBe(true);
    expect(result.status).toBe('failed');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('cwd home cannot write home/.momonga', PROCESS_TIMEOUT, async () => {
    const fx = await escapeFixture(true);
    const target = path.join(fx.momonga, 'x');
    const result = resultOf(await bash(fx.tools, `touch '${fx.markerFor([fx.home])}' && printf escaped > '${target}'`, fx.extraFor([fx.home], fx.home)));
    expect(fs.existsSync(fx.markerFor([fx.home]))).toBe(true);
    expect(result.status).toBe('failed');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('cwd home cannot write home/Library/Keychains', PROCESS_TIMEOUT, async () => {
    const fx = await escapeFixture(true);
    const target = path.join(fx.keychains, 'x');
    const result = resultOf(await bash(fx.tools, `touch '${fx.markerFor([fx.home])}' && printf escaped > '${target}'`, fx.extraFor([fx.home], fx.home)));
    expect(fs.existsSync(fx.markerFor([fx.home]))).toBe(true);
    expect(result.status).toBe('failed');
    expect(fs.existsSync(target)).toBe(false);
  });

  it("cwd home cannot write another session's tmp dir", PROCESS_TIMEOUT, async () => {
    const fx = await escapeFixture(true);
    const target = path.join(fx.other, 'x');
    const result = resultOf(await bash(fx.tools, `touch '${fx.markerFor([fx.home])}' && printf escaped > '${target}'`, fx.extraFor([fx.home], fx.home)));
    expect(fs.existsSync(fx.markerFor([fx.home]))).toBe(true);
    expect(result.status).toBe('failed');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('cwd home can still write its own session tmp dir', PROCESS_TIMEOUT, async () => {
    const fx = await escapeFixture(true);
    const result = resultOf(await bash(fx.tools, `printf own > "$TMPDIR/own"`, fx.extraFor([fx.home], fx.home)));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(path.join(fx.mine, 'own'), 'utf8')).toBe('own');
  });

  it('a normal project cwd still writes the project and not home/.momonga', PROCESS_TIMEOUT, async () => {
    const fx = await escapeFixture(true);
    const project = fx.tools.layout.project;
    const inside = path.join(project, 'inside.txt');
    const ok = resultOf(await bash(fx.tools, `printf hello > '${inside}'`, fx.extraFor([project], project)));
    expect(ok.status).toBe('completed');
    expect(fs.readFileSync(inside, 'utf8')).toBe('hello');
    const target = path.join(fx.momonga, 'x');
    const denied = resultOf(await bash(fx.tools, `touch '${fx.markerFor([project])}' && printf escaped > '${target}'`, fx.extraFor([project], project)));
    expect(fs.existsSync(fx.markerFor([project]))).toBe(true);
    expect(denied.status).toBe('failed');
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('always-denied writes for the builtin Write', () => {
  const ACCEPT = { mode: 'acceptEdits' } as const;

  it('cwd / cannot Write home/.momonga/x', async () => {
    const fx = await escapeFixture(false);
    const target = path.join(fx.momonga, 'x');
    const result = resultOf(await fx.tools.run('Write', { file_path: target, content: 'x' }, { ...fx.extraFor(['/'], '/'), mode: 'bypassPermissions' }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: /);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('cwd home cannot Write home/Library/Keychains/x', async () => {
    const fx = await escapeFixture(false);
    const target = path.join(fx.keychains, 'x');
    const result = resultOf(await fx.tools.run('Write', { file_path: target, content: 'x' }, { ...fx.extraFor([fx.home], fx.home), mode: 'bypassPermissions' }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: /);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("cwd home cannot Write another session's tmp dir", async () => {
    const fx = await escapeFixture(false);
    const target = path.join(fx.other, 'x');
    const result = resultOf(await fx.tools.run('Write', { file_path: target, content: 'x' }, { ...fx.extraFor([fx.home], fx.home), ...ACCEPT }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: /);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('a normal project cwd still Writes inside the project', async () => {
    const fx = await escapeFixture(false);
    const project = fx.tools.layout.project;
    const target = path.join(project, 'new.txt');
    const result = resultOf(await fx.tools.run('Write', { file_path: target, content: 'hello' }, { ...fx.extraFor([project], project), ...ACCEPT }));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
  });
});
