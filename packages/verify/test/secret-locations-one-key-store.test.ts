import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, momongaLayout, protectedSetFor, ruleEnforcementOf, standardSecretLocations } from '@momonga/foundation';
import { decide } from '@momonga/policy';
import { alwaysWriteDenied } from '@momonga/sandbox';
import { NEVER_CANCELLED, TEST_SEARCH_PATH, hostFilesystemOf, isWritableFor } from '@momonga/testkit';
import { predictDecision } from '../src/queries.ts';
import { buildQueryContext } from '../src/verify.ts';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, caseSensitiveFs, makeLayout, useZ3 } from './harness.ts';

const z3 = useZ3();

const READ = { name: 'Read', kind: 'read', sideEffect: 'read_only' } as const;

describe('the platform key store named by the layout', () => {
  it('is the one key store that the decision code, the model of the verifier and the sandbox read-deny, on Linux with XDG_DATA_HOME set', async () => {
    const layout = makeLayout();
    const dataHome = path.join(layout.root, 'data');
    const paths = momongaLayout(layout.home, 'linux', { XDG_DATA_HOME: dataHome });
    fs.mkdirSync(paths.keychains, { recursive: true });
    const key = path.join(paths.keychains, 'login.keyring');
    const locations = standardSecretLocations(paths);
    const roots = [layout.project];
    const fileSystem = caseSensitiveFs();

    expect(paths.keychains).toBe(path.join(dataHome, 'keyrings'));
    expect(locations.map((location) => location.directory)).toContain(paths.keychains);
    expect(locations.map((location) => location.directory)).not.toContain(path.join(layout.home, '.local', 'share', 'keyrings'));

    const decision = await decide({
      tool: READ,
      subject: { kind: 'path', tool: 'Read', paths: [key], access: 'read' },
      mode: 'bypassPermissions',
      rules: [],
      roots,
      home: layout.home,
      cwd: layout.project,
      fs: fileSystem,
      searchPath: TEST_SEARCH_PATH,
      isWritable: isWritableFor(roots),
      protectedSet: EMPTY_PROTECTED_SET,
      fileRules: EMPTY_FILE_RULES,
      secretLocations: locations,
    });
    expect(decision).toMatchObject({ kind: 'deny', reason: `reading ${key} is denied in every permission mode: it is inside the platform key store, a secret location` });

    const context = await buildQueryContext(z3.engine().api, {
      signal: NEVER_CANCELLED,
      rules: [],
      roots,
      mode: 'bypassPermissions',
      home: layout.home,
      cwd: layout.project,
      protectedSet: await protectedSetFor(roots, fileSystem),
      fs: hostFilesystemOf(fileSystem),
      secretLocations: locations,
      deniedLocations: locations,
      exemptDirectory: null,
      enforcement: ruleEnforcementOf('none'),
      budgetMs: 120_000,
    });
    expect((await predictDecision(context, 'Read', { kind: 'path', tool: 'Read', access: 'read', requested: key, resolved: key }))?.kind).toBe('deny');

    expect((await alwaysWriteDenied(paths, NEVER_CANCELLED)).readDenied).toContain(paths.keychains);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);
});
