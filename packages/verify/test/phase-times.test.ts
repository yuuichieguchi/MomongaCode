import { describe, expect, it } from 'vitest';
import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { hostFilesystemOf, NEVER_CANCELLED } from '@momonga/testkit';
import { formatReport, verdictOfReport, verifyPermissions } from '../src/index.ts';
import { caseSensitiveFs, makeLayout, sshLocation, useZ3 } from './harness.ts';

const z3 = useZ3();

const HOST_PHASES = [
  { phase: 'thread-start', ms: 3 },
  { phase: 'load', ms: 5 },
  { phase: 'instantiate', ms: 7 },
];

describe('the time a verification spends per phase', () => {
  it('is recorded for the phases of its host and for each property, printed in the report and kept in the verdict', async () => {
    const layout = makeLayout();
    const fileSystem = caseSensitiveFs();
    const roots = [layout.project];
    let now = 0;
    const report = await verifyPermissions(z3.engine().api, {
      rules: [],
      roots,
      mode: 'manual',
      home: layout.home,
      cwd: layout.project,
      protectedSet: await protectedSetFor(roots, fileSystem),
      fs: hostFilesystemOf(fileSystem),
      signal: NEVER_CANCELLED,
      secretLocations: [sshLocation(layout)],
      exemptDirectory: null,
      enforcement: ruleEnforcementOf('none'),
      budgetMs: 0,
      clock: { now: () => (now += 2) },
      hostPhases: HOST_PHASES,
    });

    expect(report.timings.map((entry) => entry.phase)).toEqual(['thread-start', 'load', 'instantiate', 'deny-precedence', 'secret-reach', 'rule-consistency', 'bash-admission']);
    expect(report.timings.slice(0, 3)).toEqual(HOST_PHASES);
    for (const entry of report.timings.slice(3)) expect(entry.ms).toBeGreaterThanOrEqual(2);
    expect(formatReport(report)).toContain(`time per phase: thread-start 3 ms, load 5 ms, instantiate 7 ms, deny-precedence ${report.timings[3]?.ms} ms`);
    expect(verdictOfReport(report, 'z3 1').phases).toEqual(report.timings);
  });
});
