import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, generationLayout, isPipePath } from '@momonga/foundation';
import { assertHomeSocketBudget, registerCleanup, withTempDir } from '@momonga/testkit';

const LONG_TEMP_COMPONENT_BYTES = 150;
const TEMP_ENV_NAMES = ['TMPDIR', 'TEMP', 'TMP'] as const;

const pointTempAtLongDirectory = (context: Parameters<typeof withTempDir>[0]): string => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mmt-long-')));
  const longDir = path.join(parent, 'l'.repeat(LONG_TEMP_COMPONENT_BYTES));
  fs.mkdirSync(longDir, { mode: 0o700 });
  const saved = TEMP_ENV_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of TEMP_ENV_NAMES) process.env[name] = longDir;
  registerCleanup(context, () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return longDir;
};

describe('withTempDir as a home does not depend on the length of the host temporary directory', () => {
  it('gives a home whose longest generation socket the host binds when TMPDIR is too long for one', async (context) => {
    const longDir = pointTempAtLongDirectory(context);
    if (process.platform !== 'win32') await expect(assertHomeSocketBudget(longDir)).rejects.toThrow(/leaves no socket-path budget/);
    expect(os.tmpdir()).toBe(longDir);

    const home = withTempDir(context, { asHome: true });

    const unixSockets = Object.values(generationLayout(home, FIRST_GENERATION).sockets).filter((socket) => !isPipePath(socket));
    if (unixSockets.length > 0) await expect(assertHomeSocketBudget(home)).resolves.toBeUndefined();
    const stat = fs.statSync(home);
    expect(stat.isDirectory()).toBe(true);
    expect(() => fs.accessSync(home, fs.constants.W_OK)).not.toThrow();
    if (process.getuid !== undefined) expect(stat.uid).toBe(process.getuid());
    fs.writeFileSync(path.join(home, 'probe'), 'x');
    expect(fs.readFileSync(path.join(home, 'probe'), 'utf8')).toBe('x');
  });
});
