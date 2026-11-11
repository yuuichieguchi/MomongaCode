import fs from 'node:fs';
import path from 'node:path';
import { hostPaths, momongaPaths, sessionRootsOf } from '@momonga/foundation';
import { fakePolicyFilesystem, hostFilesystemOf, withTempDir } from '@momonga/testkit';
import { protectedSetOf } from '@momonga/verify';
import { describe, expect, it, vi } from 'vitest';
import { policyVerify } from '../src/commands/policy.ts';
import type { CliPorts } from '../src/ports.ts';
import { terminalPorts } from '../src/terminal-writer.ts';
import type { PolicyVerifyHost } from '../src/verify/host.ts';

vi.mock('../src/daemon/ensure-daemon.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/ensure-daemon.ts')>()),
  ensureCurrentDaemon: async () => ({}),
}));

vi.mock('../src/run/open-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/run/open-session.ts')>()),
  connectRuntime: () => ({
    trust: async () => ({ path: 'x', decision: 'trusted' }),
    policyGovernance: async () => ({ rules: [], textOnly: [] }),
    putRuleVerdict: async () => undefined,
    close: async () => undefined,
  }),
}));

type Captured = { home: string; cwd: string; roots: string[]; rules: { home?: string; cwd?: string; settingsRoot?: string }[] };

const capturing = () => {
  const requests: Captured[] = [];
  const host = {
    loadVerifier: async () => ({
      secretLocationsOf: () => [],
      protectedSetOf,
      verifyPermissions: async (_api: unknown, request: Captured) => {
        requests.push(request);
        return { exitCode: 0, status: 'proved' };
      },
      formatReport: () => 'report',
      ruleVerifyInputOf: (request: Captured) => request,
      verdictOfReport: () => ({ verdict: 'proved', solver: 's', refuted: [], unknown: [], notProved: [] }),
    }),
    solverVersion: async () => 's',
    loadPolicyFilesystem: async () => hostFilesystemOf(fakePolicyFilesystem()),
    openSolver: async () => ({ api: {}, close: async () => undefined }),
  } as unknown as PolicyVerifyHost;
  return { host, requests };
};

describe('the key of a stored verdict is computed from one normalised input: the canonical home and the deduplicated roots of the session', () => {
  it('a home behind a symlink and a folder named twice give the home, the folder and the roots the runtime uses', async (context) => {
    const base = fs.realpathSync(withTempDir(context));
    const realHome = path.join(base, 'real-home');
    const project = path.join(base, 'project');
    const extra = path.join(base, 'extra');
    for (const folder of [realHome, project, extra]) fs.mkdirSync(folder);
    const linkedHome = path.join(base, 'home-link');
    const linkedExtra = path.join(base, 'extra-link');
    fs.symlinkSync(realHome, linkedHome);
    fs.symlinkSync(extra, linkedExtra);
    fs.mkdirSync(path.join(realHome, '.momonga'));
    fs.writeFileSync(path.join(realHome, '.momonga', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read(~/notes/**)'], additionalDirectories: [extra, linkedExtra, project] } }));
    const sink = { write: () => true };
    const ports = terminalPorts({ version: '1.0.0', home: linkedHome, cwd: project, env: {}, platform: process.platform, interrupt: new AbortController().signal, stdout: sink, stderr: sink } as unknown as CliPorts);
    const { host, requests } = capturing();

    expect(await policyVerify(ports, momongaPaths(linkedHome, process.platform, {}), host, { json: true, secrets: [] })).toBe(0);

    const [request] = requests;
    if (request === undefined) throw new Error('the verifier was not asked');
    const runtimeRoots = await sessionRootsOf(project, [extra, linkedExtra, project], hostPaths(new AbortController().signal));
    expect(runtimeRoots).toEqual({ ok: true, roots: [project, extra] });
    expect({ ok: true, roots: request.roots }).toEqual(runtimeRoots);
    expect(request.home).toBe(realHome);
    expect(request.cwd).toBe(project);
    expect(request.rules.length).toBeGreaterThan(0);
    for (const rule of request.rules) expect({ home: rule.home, cwd: rule.cwd }).toEqual({ home: realHome, cwd: project });
  });
});
