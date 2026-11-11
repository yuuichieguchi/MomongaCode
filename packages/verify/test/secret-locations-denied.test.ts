import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout, protectedSetFor, ruleEnforcementOf, standardSecretLocations as secretLocationsOfLayout } from '@momonga/foundation';
import { PERMISSION_MODES } from '@momonga/protocol';
import { hostFilesystemOf, NEVER_CANCELLED } from '@momonga/testkit';
import { CREDENTIAL_PATHS, formatReport, secretLocationsOf as secretLocationsOfLayoutWith, verdictOfReport } from '../src/index.ts';
import { predictDecision } from '../src/queries.ts';
import { replayWitness } from '../src/replay.ts';
import { buildQueryContext } from '../src/verify.ts';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, caseSensitiveFs, makeLayout, rulesOf, useZ3, verifyScenario } from './harness.ts';
import type { Layout } from './harness.ts';

const z3 = useZ3();

const standardSecretLocations = (home: string) => secretLocationsOfLayout(momongaLayout(home, process.platform, {}));

const secretLocationsOf = (home: string, paths: { root: string; keychains: string }, extra: readonly string[]) => secretLocationsOfLayoutWith({ home, ...paths }, extra);

const withSecrets = (): Layout => {
  const layout = makeLayout();
  fs.mkdirSync(path.join(layout.home, '.ssh'), { mode: 0o700 });
  return layout;
};

describe('the one list of secret locations', () => {
  it('is the list of the foundation, which the verifier gives out unchanged', () => {
    const home = '/home/u';
    const paths = { root: '/home/u/.momonga', keychains: '/home/u/keys' };

    expect(secretLocationsOf(home, paths, []).map((location) => location.directory)).toEqual([...CREDENTIAL_PATHS.map((relative) => path.join(home, relative)), paths.root, paths.keychains]);
    expect(standardSecretLocations(home).map((location) => location.directory).slice(0, CREDENTIAL_PATHS.length)).toEqual(CREDENTIAL_PATHS.map((relative) => path.join(home, relative)));
  });
});

describe('a secret location that the workspace contains', () => {
  it.each(PERMISSION_MODES)('is opened by no default in %s mode: proved, with nothing listed as by the mode default', async (mode) => {
    const layout = withSecrets();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, []), { mode, roots: [layout.home], secretLocations: standardSecretLocations(layout.home) });

    const reach = report.results.find((result) => result.id === 'secret-reach');
    expect(reach?.verdict.status).toBe('proved');
    for (const result of report.results) expect(result).not.toHaveProperty('byModeDefault');
    expect(verdictOfReport(report, 'z3 1')).not.toHaveProperty('byModeDefault');
    expect(formatReport(report)).not.toContain('by the mode default');
    expect(report.mismatches).toEqual([]);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it.each(PERMISSION_MODES)('is still opened by a written allow rule in %s mode, which refutes the rules and names the rule', async (mode) => {
    const layout = withSecrets();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Read(~/**)']]), { mode, roots: [layout.home], secretLocations: standardSecretLocations(layout.home) });
    const verdict = verdictOfReport(report, 'z3 1');

    expect(verdict.verdict).toBe('refuted');
    expect(verdict.refuted).toEqual(expect.arrayContaining([expect.objectContaining({ property: 'secret-reach', message: expect.stringContaining('Read(~/**)') })]));
    expect(report.mismatches).toEqual([]);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it.each(PERMISSION_MODES)('is denied by the model as by the decision code in %s mode', async (mode) => {
    const layout = withSecrets();
    const roots = [layout.home];
    const fileSystem = caseSensitiveFs();
    const context = await buildQueryContext(z3.engine().api, {
      signal: NEVER_CANCELLED,
      rules: rulesOf(layout, []),
      roots,
      mode,
      home: layout.home,
      cwd: layout.project,
      protectedSet: await protectedSetFor(roots, fileSystem),
      fs: hostFilesystemOf(fileSystem),
      secretLocations: standardSecretLocations(layout.home),
      deniedLocations: standardSecretLocations(layout.home),
      exemptDirectory: null,
      enforcement: ruleEnforcementOf('none'),
      budgetMs: 120_000,
    });
    const key = path.join(layout.home, '.ssh', 'id_rsa');
    const witness = { kind: 'path', tool: 'Read', access: 'read', requested: key, resolved: key } as const;

    const predicted = await predictDecision(context, 'Read', witness);
    expect(predicted?.kind).toBe('deny');
    expect(await replayWitness(context.env, 'Read', witness, predicted as NonNullable<typeof predicted>)).toMatchObject({ agrees: true, actual: 'deny' });
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);
});
