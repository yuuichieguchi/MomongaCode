import fs from 'node:fs';
import path from 'node:path';
import { GIT_OPTION_TABLES } from '@momonga/policy';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeDifferentialWorkspace } from './differential/fixture.ts';
import { runCase } from './differential/oracles.ts';
import type { Case } from './differential/oracles.ts';
import { separateWordSweep } from './differential/seeds.ts';
import type { SEPARATE_WORD_SUBCOMMANDS } from './differential/seeds.ts';

export const DIFFERENTIAL_TITLE = 'every command decide approves does what the analysis reported, on real /bin/bash and real git';

export const failures = async (cases: readonly Case[], run: (input: Case) => ReturnType<typeof runCase>): Promise<{ approved: number; failures: string[] }> => {
  const found: string[] = [];
  let approved = 0;
  for (const input of cases) {
    const outcome = await run(input);
    if (outcome.ran) approved += 1;
    for (const violation of outcome.violations) found.push(`${JSON.stringify(input)}: ${violation}`);
  }
  return { approved, failures: found };
};

export const separateWordSweepFile = (subcommand: (typeof SEPARATE_WORD_SUBCOMMANDS)[number]): void => {
  vi.setConfig({ testTimeout: 10 * REAL_PROCESS_TEST_TIMEOUT_MS });
  describe(DIFFERENTIAL_TITLE, () => {
    it(`every option of git ${subcommand} followed by a side-effect option word, with and without a separator`, async () => {
      const workspace = makeDifferentialWorkspace();
      fs.copyFileSync(workspace.hookScript('echo'), path.join(workspace.project, 'pager.sh'));
      fs.chmodSync(path.join(workspace.project, 'pager.sh'), 0o755);
      workspace.write('.gitattributes', 'tracked diff=x\n');
      workspace.git(workspace.project, 'config', 'diff.x.textconv', workspace.hookScript('echo'));
      workspace.write('two', 'two\n');
      workspace.git(workspace.project, 'add', 'two');
      workspace.git(workspace.project, 'commit', '-q', '-m', 'two');
      const table = GIT_OPTION_TABLES[subcommand] as { flags: readonly string[]; values: readonly string[]; optionalValues: readonly string[] };
      const options = [...table.flags, ...table.values, ...table.optionalValues];
      const swept = separateWordSweep(subcommand, options);
      expect(swept.length).toBeGreaterThan(options.length);
      expect((await failures(swept, (input) => runCase(workspace, input))).failures).toEqual([]);
    });
  });
};
