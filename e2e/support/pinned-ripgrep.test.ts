import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RIPGREP_VERSION } from '../../scripts/ripgrep-release.ts';
import { createE2eHome } from './home.ts';
import { REPO_ROOT } from './launcher.ts';
import { SUPERVISOR_ENV_PATH, baseSettings, settingsOf } from './stack.ts';

const PINNED_CACHE = path.join(REPO_ROOT, '.cache', 'ripgrep');

const ripgrepSettingOf = (settings: Readonly<Record<string, unknown>> | string): unknown =>
  typeof settings === 'string' ? undefined : (settings['tools'] as { ripgrep?: unknown } | undefined)?.ripgrep;

describe('the stack ripgrep', () => {
  it('names the pinned ripgrep from the repository cache through tools.ripgrep, outside the fixed PATH', async () => {
    const home = await createE2eHome();
    const setting = ripgrepSettingOf(baseSettings(home, 'none'));
    expect(typeof setting).toBe('string');
    const binary = setting as string;
    expect(path.isAbsolute(binary)).toBe(true);
    expect(path.relative(PINNED_CACHE, binary).startsWith('..')).toBe(false);
    expect(SUPERVISOR_ENV_PATH.split(path.delimiter)).not.toContain(path.dirname(binary));
    expect(fs.statSync(binary).isFile()).toBe(true);
    expect(execFileSync(binary, ['--version'], { encoding: 'utf8' }).split('\n')[0]).toMatch(new RegExp(`^ripgrep ${RIPGREP_VERSION.replaceAll('.', '\\.')}( |$)`));
  });

  it('keeps the pinned ripgrep when a test adds its own settings', async () => {
    const home = await createE2eHome();
    const expected = ripgrepSettingOf(baseSettings(home, 'none'));
    const merged = settingsOf(home, 'none', { home, settings: { tools: { deferral: true } } });
    expect(ripgrepSettingOf(merged)).toBe(expected);
    expect(expected).not.toBeUndefined();
  });

  it('keeps the fixed PATH, which needs no host ripgrep', () => {
    expect(SUPERVISOR_ENV_PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});
