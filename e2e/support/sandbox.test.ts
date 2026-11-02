import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { E2E_CASES, caseOf, skipCase, titleOf } from './cases.ts';
import {
  SANDBOX_EXEC_PATH,
  SANDBOX_FALLBACK,
  SANDBOX_PROBE_ARGS,
  encodeSandboxProbe,
  resolveSandbox,
  runSandboxProbe,
  sandboxLine,
  sandboxProbe,
} from './sandbox.ts';
import type { SandboxProbeRunner } from './sandbox.ts';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const recordingRunner = (outcome: 'ok' | 'fail') => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner: SandboxProbeRunner = (file, args) => {
    calls.push({ file, args });
    if (outcome === 'fail') throw Object.assign(new Error('Command failed'), { stderr: 'sandbox_apply: Operation not permitted\n' });
  };
  return { runner, calls };
};

const registeredTitlesIn = (source: string): string[] =>
  [...source.matchAll(/titleOf\(\s*'([^']+)'\s*\)/g)].map((match) => caseOf(match[1] as Parameters<typeof caseOf>[0]).title);

describe('sandbox probe', () => {
  it('runSandboxProbe runs the allow-default profile once and reports usable', () => {
    const { runner, calls } = recordingRunner('ok');
    expect(runSandboxProbe(runner)).toEqual({ usable: true });
    expect(calls).toEqual([{ file: SANDBOX_EXEC_PATH, args: SANDBOX_PROBE_ARGS }]);
    expect(SANDBOX_PROBE_ARGS).toEqual(['-p', '(version 1)(allow default)', '/usr/bin/true']);
  });

  it('runSandboxProbe reports unusable with the stderr of the failure', () => {
    const { runner } = recordingRunner('fail');
    expect(runSandboxProbe(runner)).toEqual({ usable: false, stderr: 'sandbox_apply: Operation not permitted' });
  });

  it('sandboxProbe reads the published result without probing', () => {
    const { runner, calls } = recordingRunner('ok');
    expect(sandboxProbe({ MOMONGA_E2E_SANDBOX: 'usable' }, runner)).toEqual({ usable: true });
    expect(sandboxProbe({ MOMONGA_E2E_SANDBOX: 'unusable:nested sandbox' }, runner)).toEqual({ usable: false, stderr: 'nested sandbox' });
    expect(calls).toEqual([]);
  });

  it('sandboxProbe probes once and publishes the result when nothing was published', () => {
    const { runner, calls } = recordingRunner('fail');
    const env: Record<string, string | undefined> = {};
    const first = sandboxProbe(env, runner);
    const second = sandboxProbe(env, runner);
    expect(env['MOMONGA_E2E_SANDBOX']).toBe('unusable:sandbox_apply: Operation not permitted');
    expect(first).toEqual({ usable: false, stderr: 'sandbox_apply: Operation not permitted' });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it('encodes the probe the way sandboxProbe decodes it', () => {
    expect(encodeSandboxProbe({ usable: true })).toBe('usable');
    expect(encodeSandboxProbe({ usable: false, stderr: 'x: y' })).toBe('unusable:x: y');
  });
});

describe('resolveSandbox', () => {
  it.each([
    { probe: { usable: true } as const, needsBash: true, expected: { kind: 'seatbelt' } },
    { probe: { usable: true } as const, needsBash: false, expected: { kind: 'seatbelt' } },
    { probe: { usable: false, stderr: 'denied' } as const, needsBash: false, expected: { kind: 'none', sandboxFallback: SANDBOX_FALLBACK } },
    { probe: { usable: false, stderr: 'denied' } as const, needsBash: true, expected: { kind: 'skip', reason: 'sandbox-exec is not usable on this host: denied' } },
  ])('usable=$probe.usable needsBash=$needsBash gives $expected.kind', ({ probe, needsBash, expected }) => {
    expect(resolveSandbox({ needsBash }, probe)).toEqual(expected);
  });

  it('sandboxLine counts from the registry', () => {
    const bash = E2E_CASES.filter((entry) => entry.needsBash).length;
    expect(sandboxLine({ usable: true }, E2E_CASES)).toBe('e2e sandbox: seatbelt (sandbox-exec usable)');
    expect(sandboxLine({ usable: false, stderr: 'x' }, E2E_CASES)).toBe(
      `e2e sandbox: sandbox-exec UNUSABLE; ${bash} bash cases will be skipped, ${E2E_CASES.length - bash} cases run with sandbox none`,
    );
    expect(bash).toBe(7);
    expect(E2E_CASES.length - bash).toBe(37);
  });
});

describe('E2E_CASES registry', () => {
  it('has unique ids and unique titles', () => {
    expect(new Set(E2E_CASES.map((entry) => entry.id)).size).toBe(E2E_CASES.length);
    expect(new Set(E2E_CASES.map((entry) => entry.title)).size).toBe(E2E_CASES.length);
  });

  it('titleOf and caseOf look entries up by id', () => {
    expect(titleOf('b2-seatbelt')).toBe('b2 seatbelt is applied: a write outside the project is denied');
    expect(caseOf('s4')).toEqual({ id: 's4', file: 'supervisor.test.ts', title: 'S4 irrelevant change restarts nothing', needsBash: false });
  });

  it('skipCase follows the published probe: only bash cases are skipped when sandbox-exec is unusable', () => {
    const usable = process.env['MOMONGA_E2E_SANDBOX'] === 'usable';
    for (const entry of E2E_CASES) expect(skipCase(entry.id)).toBe(!usable && entry.needsBash);
  });

  it('matches the titles registered in the e2e test sources, file by file', () => {
    const files = [...new Set(E2E_CASES.map((entry) => entry.file))].sort();
    const onDisk = fs
      .readdirSync(E2E_DIR)
      .filter((entry) => entry.endsWith('.test.ts'))
      .sort();
    expect(onDisk).toEqual(files);
    for (const file of files) {
      const registered = E2E_CASES.filter((entry) => entry.file === file).map((entry) => entry.title).sort();
      const used = registeredTitlesIn(fs.readFileSync(path.join(E2E_DIR, file), 'utf8')).sort();
      expect({ file, titles: used }).toEqual({ file, titles: registered });
    }
  });
});
