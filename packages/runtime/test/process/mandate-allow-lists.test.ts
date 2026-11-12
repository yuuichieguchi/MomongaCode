import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RULE_VERIFY_BUDGET_MS, refusingRefutations } from '@momonga/protocol';
import { NEVER_CANCELLED, withTempDir } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';
import { systemClock } from '@momonga/foundation';
import { RULE_VERIFY_LOAD_ALLOWANCE_MS, createRuleVerifier, installedRuleSolver } from '../../src/process/rule-verifier.ts';
import { systemTimers } from '../../src/service/timers.ts';
import { delegationOf } from '../../src/worker/held-calls.ts';
import { policyRefusal } from '../../src/worker/rule-verdict.ts';

const SOLVER_GUARD_MS = 60 * 60 * 1000;
const NO_CATALOGUE = { alwaysOperations: [], supersededForms: [] };

describe('a mandate whose allow list names tools that cover one another', () => {
  vi.setConfig({ testTimeout: SOLVER_GUARD_MS });

  it.for([
    { allow: ['Edit(*)', 'Write(*)'], noted: 'Write(*)' },
    { allow: ['Read(*)', 'Glob(*)', 'Grep(*)'], noted: 'Glob(*)' },
  ])('is verified with the rules the run builds from $allow and refuses nothing: the covered rule is a note', async ({ allow, noted }, context) => {
    const root = fs.realpathSync(withTempDir(context));
    const home = `${root}/home`;
    const cwd = `${root}/work`;
    fs.mkdirSync(cwd);
    fs.mkdirSync(`${home}/.ssh`, { recursive: true });
    const { delegation } = delegationOf({ mandate: { scope: { allow } } }, { home, cwd }, NO_CATALOGUE);
    const verifier = createRuleVerifier({
      host: installedRuleSolver(import.meta.url),
      fs: createPolicyFilesystem(),
      paths: { home, root: `${home}/.momonga`, keychains: `${home}/keys` } as never,
      timers: systemTimers,
      bashPath: () => '/bin/bash',
      clock: systemClock,
      budgetMs: RULE_VERIFY_BUDGET_MS,
      startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS,
    });

    const input = await verifier.inputOf(
      { unixSockets: { kind: 'limited', allowed: [] }, rules: delegation?.rules ?? [], roots: [cwd], mode: 'manual', home, cwd, exemptDirectory: `${home}/.momonga/tmp/sessions/s1`, enforcement: 'exact-paths', secrets: [] },
      NEVER_CANCELLED,
    );
    expect(delegation?.rules.map((rule) => rule.text)).toEqual(allow);
    expect(await verifier.needsVerdict(input)).toBe(true);
    const verdict = await verifier.verify(input, new AbortController().signal);

    expect(refusingRefutations(verdict)).toEqual([]);
    expect(verdict.verdict).not.toBe('refuted');
    expect(policyRefusal({ fingerprint: 'f'.repeat(64), ...verdict })).toBeUndefined();
    expect((verdict.notes ?? []).flatMap((note) => note.rules.map((rule) => rule.text))).toContain(noted);
  });
});
