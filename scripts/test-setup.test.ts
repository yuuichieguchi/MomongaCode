import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUIRED_TOOLS } from '../test/support/required-tools.ts';
import { repoRoot } from './bundle.ts';
import { TEST_SETUP_COMMAND } from './fetch-tla.ts';
import { testSetupSteps } from './test-setup.ts';

describe('npm run test:setup', () => {
  it('is the test:setup script of the package', () => {
    const scripts: unknown = JSON.parse(fs.readFileSync(`${repoRoot}package.json`, 'utf8')).scripts;
    expect(scripts).toMatchObject({ 'test:setup': 'node scripts/test-setup.ts' });
    expect(TEST_SETUP_COMMAND).toBe('npm run test:setup');
  });

  it('provides every prerequisite whose refusal names it, so the refusal is never a dead end', () => {
    const provided = new Set(testSetupSteps(repoRoot).flatMap((step) => step.provides));
    const named = REQUIRED_TOOLS.filter((tool) => tool.setup === TEST_SETUP_COMMAND).map((tool) => tool.name);
    expect(named.filter((name) => !provided.has(name))).toEqual([]);
  });
});
