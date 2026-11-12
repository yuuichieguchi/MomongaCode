import { describe, expect, it } from 'vitest';
import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { hostFilesystemOf, NEVER_CANCELLED, testSecretLocations } from '@momonga/testkit';
import { verifyPermissions } from '../src/index.ts';
import type { VerifyRequest } from '../src/index.ts';
import { caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';

const z3 = useZ3();

describe('the overall budget of a verification', () => {
  it('reports properties as unknown once the budget is spent, rather than giving each query its own timeout', async () => {
    const layout = makeLayout();
    const fileSystem = caseSensitiveFs();
    const roots = [layout.project];
    const request: VerifyRequest = { unixSockets: { kind: 'limited', allowed: [] },
      rules: rulesOf(layout, [
        ['allow', 'Write(src/**)'],
        ['deny', 'Write(src/secret/**)'],
      ]),
      roots,
      mode: 'manual',
      home: layout.home,
      deniedLocations: testSecretLocations(layout.home),
      cwd: layout.project,
      protectedSet: await protectedSetFor(roots, fileSystem),
      fs: hostFilesystemOf(fileSystem), signal: NEVER_CANCELLED,
      secretLocations: [sshLocation(layout)],
      exemptDirectory: null,
      enforcement: ruleEnforcementOf('none'),
      budgetMs: 0,
    };

    const report = await verifyPermissions(z3.engine().api, request);

    expect(report.results.find((result) => result.id === 'secret-reach')?.verdict.status).toBe('unknown');
  });
});
