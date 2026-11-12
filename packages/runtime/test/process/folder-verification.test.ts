import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRule } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { verdictKey } from '@momonga/foundation';
import { RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import type { RuleVerdict } from '@momonga/protocol';
import { createFakeClock, withTempDir } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';
import { folderPolicyVerification } from '../../src/process/folder-verification.ts';
import type { FolderPolicyFacts } from '../../src/process/folder-verification.ts';
import { RULE_VERIFY_LOAD_ALLOWANCE_MS, createRuleVerifier, installedRuleSolver } from '../../src/process/rule-verifier.ts';
import { RuleVerificationFailure } from '../../src/process/rule-verifier-thread-client.ts';
import { systemTimers } from '../../src/service/timers.ts';
import { PROVED_THREAD_CODE } from './fake-rule-solver.ts';

const SOCKETS = { kind: 'limited', allowed: [] } as const;

const CATALOGUE = { supersededForms: [], alwaysOperations: ['git.push'] };

const layoutIn = (context: Parameters<typeof withTempDir>[0]) => {
  const root = fs.realpathSync(withTempDir(context));
  const home = `${root}/home`;
  const work = `${root}/work`;
  fs.mkdirSync(`${home}/.ssh`, { recursive: true });
  fs.mkdirSync(`${work}/extra`, { recursive: true });
  fs.symlinkSync(work, `${root}/linked-work`);
  return { root, home, work };
};

const verifierIn = (home: string, threadCode = PROVED_THREAD_CODE) =>
  createRuleVerifier({
    host: { ...installedRuleSolver(import.meta.url), threadCode },
    fs: createPolicyFilesystem(),
    paths: { home, root: `${home}/.momonga`, keychains: `${home}/keys` } as never,
    timers: systemTimers,
    bashPath: () => '/bin/bash',
    clock: createFakeClock(0),
    budgetMs: RULE_VERIFY_BUDGET_MS,
    startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS,
  });

const ruleIn = (home: string, work: string, text: string): PermissionRule =>
  parseRule(text, { effect: 'allow', origin: 'user', source: `${home}/.momonga/settings.json`, settingsRoot: home, home, cwd: work } as never);

type Stored = Map<string, RuleVerdict>;

const verificationIn = (layout: { home: string; work: string }, facts: (cwd: string) => FolderPolicyFacts, stored: Stored, threadCode?: string) => {
  const verifier = verifierIn(layout.home, threadCode);
  const seen: string[] = [];
  const verify = folderPolicyVerification({
    verifier,
    ruleVerdicts: { put: (fingerprint, verdict) => void stored.set(fingerprint, verdict) },
    home: layout.home,
    sessionsRoot: `${layout.home}/.momonga/tmp/sessions`,
    folder: async (cwd) => {
      seen.push(cwd);
      return facts(cwd);
    },
    mandates: async () => ({ release: { allow: ['Bash(git push:*)'] } }),
    catalogue: () => CATALOGUE,
  });
  return { verifier, verify, seen };
};

describe('the verification of the rules of a folder, done by the daemon', () => {
  it('builds its input by the one function a run uses, so that a folder reached through a link and a repeated directory give the key of the canonical folder', async (context) => {
    const layout = layoutIn(context);
    const stored: Stored = new Map();
    const rules = [ruleIn(layout.home, layout.work, 'Read(src/**)')];
    const { verifier, verify, seen } = verificationIn(layout, () => ({ rules, additionalDirectories: [`${layout.work}/extra`, `${layout.work}/extra`, `${layout.root}/linked-work/extra`], enforcement: 'exact-paths', unixSockets: SOCKETS }), stored);

    const linked = await verify({ cwd: `${layout.root}/linked-work`, secrets: [] }, new AbortController().signal);
    const direct = await verify({ cwd: layout.work, secrets: [] }, new AbortController().signal);

    expect(seen).toEqual([layout.work, layout.work]);
    expect(linked.fingerprint).toBe(direct.fingerprint);
    const input = await verifier.inputOf({ rules, roots: [layout.work, `${layout.work}/extra`], mode: 'manual', home: layout.home, cwd: layout.work, exemptDirectory: `${layout.home}/.momonga/tmp/sessions/session-scratch`, enforcement: 'exact-paths', secrets: [], unixSockets: SOCKETS }, new AbortController().signal);
    expect(direct.fingerprint).toBe(verdictKey(input, await verifier.solverVersion()));
    expect(direct).toMatchObject({ stored: true, exitCode: 0 });
    expect(stored.get(direct.fingerprint)).toMatchObject({ verdict: 'proved' });
  });

  it('takes the mode of the request before the default mode of the settings, and the named secret locations into the input', async (context) => {
    const layout = layoutIn(context);
    const stored: Stored = new Map();
    const { verify } = verificationIn(layout, () => ({ rules: [], defaultMode: 'acceptEdits', additionalDirectories: [], enforcement: 'exact-paths', unixSockets: SOCKETS }), stored);
    const byDefault = await verify({ cwd: layout.work, secrets: [] }, new AbortController().signal);
    const named = await verify({ cwd: layout.work, mode: 'acceptEdits', secrets: [] }, new AbortController().signal);
    const other = await verify({ cwd: layout.work, mode: 'manual', secrets: [] }, new AbortController().signal);
    const withSecret = await verify({ cwd: layout.work, mode: 'acceptEdits', secrets: [`${layout.home}/vault`] }, new AbortController().signal);
    expect(named.fingerprint).toBe(byDefault.fingerprint);
    expect(other.fingerprint).not.toBe(byDefault.fingerprint);
    expect(withSecret.fingerprint).not.toBe(byDefault.fingerprint);
  });

  it('verifies a mandate of the user settings with its checks, and stores nothing for it', async (context) => {
    const layout = layoutIn(context);
    const stored: Stored = new Map();
    const { verify } = verificationIn(layout, () => ({ rules: [], additionalDirectories: [], enforcement: 'exact-paths', unixSockets: SOCKETS }), stored);
    const answer = await verify({ cwd: layout.work, secrets: [], mandate: 'release' }, new AbortController().signal);
    expect(answer.stored).toBe(false);
    expect(stored.size).toBe(0);
    await expect(verify({ cwd: layout.work, secrets: [], mandate: 'nothing' }, new AbortController().signal)).rejects.toThrow('no mandate named "nothing" is declared in the user settings');
  });

  it('stores no verdict that is not final, and a thread that fails is an error of the request', async (context) => {
    const layout = layoutIn(context);
    const stored: Stored = new Map();
    const unknownThread = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ entered: true });
parentPort.postMessage({ ok: true, verdict: { verdict: 'unknown', solver: workerData.solverVersion, refuted: [], unknown: [{ property: 'bash-admission', reason: 'the budget was spent' }], notProved: [] }, report: 'unknown', findings: { exitCode: 2 } });
`;
    const undecided = verificationIn(layout, () => ({ rules: [], additionalDirectories: [], enforcement: 'exact-paths', unixSockets: SOCKETS }), stored, unknownThread);
    expect(await undecided.verify({ cwd: layout.work, secrets: [] }, new AbortController().signal)).toMatchObject({ stored: false, exitCode: 2, text: 'unknown' });
    expect(stored.size).toBe(0);
    const broken = verificationIn(layout, () => ({ rules: [], additionalDirectories: [], enforcement: 'exact-paths', unixSockets: SOCKETS }), stored, `throw new Error('the solver is broken')`);
    await expect(broken.verify({ cwd: layout.work, secrets: [] }, new AbortController().signal)).rejects.toBeInstanceOf(RuleVerificationFailure);
  });
});
