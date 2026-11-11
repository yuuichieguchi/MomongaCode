import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BWRAP_PATH, bwrapProbeArguments } from '@momonga/sandbox';
import { nodeShellHost, resolveBashPath } from '@momonga/tools';
import { E2E_CASES, caseOf, skipCase, titleOf } from './cases.ts';
import type { E2eCase } from './cases.ts';
import {
  LAUNCHER_PATH,
  SANDBOX_EXEC_PATH,
  SANDBOX_PROBE_ARGS,
  decodeSandboxProbe,
  encodeSandboxProbe,
  platformSandbox,
  resolveSandbox,
  runSandboxProbe,
  sandboxLine,
  sandboxProbe,
} from './sandbox.ts';
import type { SandboxProbe, SandboxProbeRunner } from './sandbox.ts';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BWRAP_PROC_DENIED = "bwrap: Can't mount proc on /newroot/proc: Operation not permitted";

const recordingRunner = (outcome: 'ok' | { stderr: string } | Error) => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner: SandboxProbeRunner = (file, args) => {
    calls.push({ file, args });
    if (outcome instanceof Error) throw outcome;
    if (outcome === 'ok') return { status: 0, stderr: '', timedOut: false };
    return { status: 1, stderr: `${outcome.stderr}\n`, timedOut: false };
  };
  return { runner, calls };
};

const registeredTitlesIn = (source: string): string[] =>
  [...source.matchAll(/titleOf\(\s*'([^']+)'\s*\)/g)].map((match) => caseOf(match[1] as Parameters<typeof caseOf>[0]).title);

describe('sandbox probe', () => {
  it('on darwin it probes seatbelt: the allow-default profile once through sandbox-exec', () => {
    const { runner, calls } = recordingRunner('ok');
    expect(runSandboxProbe('darwin', runner)).toEqual({ usable: true, kind: 'seatbelt' });
    expect(calls).toEqual([{ file: SANDBOX_EXEC_PATH, args: SANDBOX_PROBE_ARGS }]);
    expect(SANDBOX_PROBE_ARGS).toEqual(['-p', '(version 1)(allow default)', '/usr/bin/true']);
  });

  it('on darwin it reports seatbelt unusable with the stderr of the failure', () => {
    const { runner } = recordingRunner({ stderr: 'sandbox_apply: Operation not permitted' });
    expect(runSandboxProbe('darwin', runner)).toEqual({ usable: false, kind: 'seatbelt', stderr: 'sandbox_apply: Operation not permitted' });
  });

  it('on linux it probes bubblewrap once with the product probe arguments and the product shell', () => {
    const { runner, calls } = recordingRunner('ok');
    expect(runSandboxProbe('linux', runner)).toEqual({ usable: true, kind: 'bubblewrap' });
    expect(calls).toEqual([{ file: DEFAULT_BWRAP_PATH, args: bwrapProbeArguments(resolveBashPath('linux', { isExecutable: nodeShellHost().isExecutable, env: process.env })) }]);
  });

  it('on linux it reports bubblewrap unusable with the stderr of bwrap', () => {
    const { runner } = recordingRunner({ stderr: BWRAP_PROC_DENIED });
    expect(runSandboxProbe('linux', runner)).toEqual({ usable: false, kind: 'bubblewrap', stderr: BWRAP_PROC_DENIED });
  });

  it('reports the launcher unusable when it cannot be started', () => {
    const { runner } = recordingRunner(Object.assign(new Error('spawnSync /usr/bin/bwrap ENOENT'), { code: 'ENOENT' }));
    expect(runSandboxProbe('linux', runner)).toEqual({ usable: false, kind: 'bubblewrap', stderr: 'spawnSync /usr/bin/bwrap ENOENT' });
  });

  it('on a platform without a product sandbox it probes nothing and reports why', () => {
    const { runner, calls } = recordingRunner('ok');
    expect(runSandboxProbe('win32', runner)).toEqual({ usable: false, kind: 'none', stderr: 'the product has no sandbox on win32' });
    expect(calls).toEqual([]);
  });

  it('platformSandbox is the sandbox the product selects for the platform', () => {
    expect(platformSandbox('darwin')).toBe('seatbelt');
    expect(platformSandbox('linux')).toBe('bubblewrap');
    expect(platformSandbox('win32')).toBe('none');
    expect(LAUNCHER_PATH).toEqual({ seatbelt: SANDBOX_EXEC_PATH, bubblewrap: DEFAULT_BWRAP_PATH });
  });

  it('sandboxProbe reads the published result without probing', () => {
    const { runner, calls } = recordingRunner('ok');
    expect(sandboxProbe({ MOMONGA_E2E_SANDBOX: 'usable:bubblewrap' }, runner)).toEqual({ usable: true, kind: 'bubblewrap' });
    expect(sandboxProbe({ MOMONGA_E2E_SANDBOX: 'unusable:seatbelt:nested sandbox' }, runner)).toEqual({ usable: false, kind: 'seatbelt', stderr: 'nested sandbox' });
    expect(calls).toEqual([]);
  });

  it('sandboxProbe probes once and publishes the result when nothing was published', () => {
    const { runner, calls } = recordingRunner({ stderr: BWRAP_PROC_DENIED });
    const env: Record<string, string | undefined> = {};
    const first = sandboxProbe(env, runner, 'linux');
    const second = sandboxProbe(env, runner, 'linux');
    expect(env['MOMONGA_E2E_SANDBOX']).toBe(`unusable:bubblewrap:${BWRAP_PROC_DENIED}`);
    expect(first).toEqual({ usable: false, kind: 'bubblewrap', stderr: BWRAP_PROC_DENIED });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [{ usable: true, kind: 'seatbelt' }, 'usable:seatbelt'],
    [{ usable: true, kind: 'bubblewrap' }, 'usable:bubblewrap'],
    [{ usable: false, kind: 'bubblewrap', stderr: 'x: y' }, 'unusable:bubblewrap:x: y'],
    [{ usable: false, kind: 'none', stderr: 'the product has no sandbox on win32' }, 'unusable:none:the product has no sandbox on win32'],
  ] as Array<[SandboxProbe, string]>)('encodes %o as %s and decodes it back', (probe, encoded) => {
    expect(encodeSandboxProbe(probe)).toBe(encoded);
    expect(decodeSandboxProbe(encoded)).toEqual(probe);
  });

  it.each(['usable', 'usable:none', 'unusable:sandbox-exec:x', 'unusable'])('refuses the published value %s', (encoded) => {
    expect(() => decodeSandboxProbe(encoded)).toThrow('MOMONGA_E2E_SANDBOX');
  });
});

describe('resolveSandbox', () => {
  it.each([
    { probe: { usable: true, kind: 'seatbelt' } as const, needsBash: true, expected: { kind: 'seatbelt' } },
    { probe: { usable: true, kind: 'bubblewrap' } as const, needsBash: true, expected: { kind: 'bubblewrap' } },
    { probe: { usable: true, kind: 'bubblewrap' } as const, needsBash: false, expected: { kind: 'bubblewrap' } },
    { probe: { usable: false, kind: 'bubblewrap', stderr: 'denied' } as const, needsBash: false, expected: { kind: 'none', sandboxFallback: 'bubblewrap unusable' } },
    { probe: { usable: false, kind: 'bubblewrap', stderr: 'denied' } as const, needsBash: true, expected: { kind: 'skip', reason: 'the bubblewrap sandbox is not usable on this host: denied' } },
    { probe: { usable: false, kind: 'seatbelt', stderr: 'denied' } as const, needsBash: true, expected: { kind: 'skip', reason: 'the seatbelt sandbox is not usable on this host: denied' } },
    {
      probe: { usable: false, kind: 'none', stderr: 'the product has no sandbox on win32' } as const,
      needsBash: true,
      expected: { kind: 'skip', reason: 'the none sandbox is not usable on this host: the product has no sandbox on win32' },
    },
  ])('$probe.kind usable=$probe.usable needsBash=$needsBash gives $expected.kind', ({ probe, needsBash, expected }) => {
    expect(resolveSandbox({ needsBash }, probe)).toEqual(expected);
  });

  it('sandboxLine names the probed sandbox and counts the cases it is given, not a fixed set', () => {
    const bashCase = E2E_CASES.find((entry) => entry.needsBash);
    const plainCase = E2E_CASES.find((entry) => !entry.needsBash);
    if (bashCase === undefined || plainCase === undefined) throw new Error('the registry has no bash case or no plain case to build from');
    const registryOf = (bash: number, plain: number): E2eCase[] => [...Array.from({ length: bash }, () => bashCase), ...Array.from({ length: plain }, () => plainCase)];
    expect(sandboxLine({ usable: true, kind: 'seatbelt' }, registryOf(2, 3))).toBe('e2e sandbox: seatbelt (sandbox-exec usable)');
    expect(sandboxLine({ usable: true, kind: 'bubblewrap' }, registryOf(2, 3))).toBe('e2e sandbox: bubblewrap (bwrap usable)');
    for (const [bash, plain] of [[2, 3], [0, 4], [5, 0], [3, 11]] as const) {
      expect(sandboxLine({ usable: false, kind: 'bubblewrap', stderr: 'x' }, registryOf(bash, plain))).toBe(
        `e2e sandbox: bubblewrap UNUSABLE (x); ${bash} bash cases will be skipped, ${plain} cases run with sandbox none`,
      );
    }
  });
});

describe('E2E_CASES registry', () => {
  it('has unique ids and unique titles', () => {
    expect(new Set(E2E_CASES.map((entry) => entry.id)).size).toBe(E2E_CASES.length);
    expect(new Set(E2E_CASES.map((entry) => entry.title)).size).toBe(E2E_CASES.length);
  });

  it('titleOf and caseOf look entries up by id', () => {
    expect(titleOf('b2-seatbelt')).toBe('b2 seatbelt is applied: a write outside the project is denied');
    expect(caseOf('s4')).toEqual({ id: 's4', file: 'supervisor.test.ts', title: 'S4 a permissions change applies in place: no daemon is restarted', needsBash: false });
  });

  it('skipCase follows the published probe: only bash cases are skipped when the platform sandbox is unusable', () => {
    const usable = process.env['MOMONGA_E2E_SANDBOX']?.startsWith('usable:') === true;
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
