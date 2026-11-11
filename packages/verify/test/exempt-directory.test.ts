import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, makeLayout, rulesOf, useZ3, verifyScenario } from './harness.ts';

const z3 = useZ3();

describe('the scratch folder a session exempts from the file rules', () => {
  it('is modelled: a deny rule that covers only that folder decides nothing and is noted, and the model agrees with the decision code', async () => {
    const layout = makeLayout();
    const scratch = path.join(layout.root, 'sessions', 's1');
    const rules = rulesOf(layout, [['deny', `Write(/${scratch}/**)`]]);

    const exempted = await verifyScenario(z3.engine().api, layout, rules, { exemptDirectory: scratch });
    const ruled = await verifyScenario(z3.engine().api, layout, rules);

    const notesOf = (report: typeof exempted) => report.results.flatMap((result) => (result.verdict.status === 'noted' ? result.verdict.ruleNotes : []));
    expect(notesOf(exempted)).toEqual([expect.objectContaining({ kind: 'never-matches', rules: [expect.objectContaining({ text: `Write(/${scratch}/**)` })] })]);
    expect(notesOf(ruled)).toEqual([]);
    expect(exempted.mismatches).toEqual([]);
    expect(ruled.mismatches).toEqual([]);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('is not listed as outside the proof', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, [], { exemptDirectory: path.join(layout.root, 'sessions', 's1') });

    expect(report.outsideProof.join(' ')).not.toContain('scratch folder');
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);
});
