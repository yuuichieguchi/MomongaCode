import { describe, expect, it } from 'vitest';
import { REQUIRED_TOOLS, missingToolsOf, requires } from './support/required-tools.ts';

describe('the required tools of a run', () => {
  it('fails, naming the setup command, when bun is missing for the Open Responses suite', () => {
    expect(() => requires('bun', { exists: () => false, platform: 'darwin' })).toThrow(/bun.*npm ci --prefix compliance\/open-responses/s);
    expect(() => requires('bun', { exists: () => true, platform: 'darwin' })).not.toThrow();
  });

  it('checks each project for the tools of its platform only', () => {
    const missing = missingToolsOf('unit', { exists: () => false, platform: 'linux' }).map((tool) => tool.name);
    expect(missing).toContain('bwrap');
    expect(missingToolsOf('unit', { exists: () => false, platform: 'darwin' }).map((tool) => tool.name)).not.toContain('bwrap');
  });

  it('gives every tool a setup command and at least one platform', () => {
    expect(REQUIRED_TOOLS.filter((tool) => tool.setup.trim() === '' || tool.platforms.length === 0)).toEqual([]);
  });
});
