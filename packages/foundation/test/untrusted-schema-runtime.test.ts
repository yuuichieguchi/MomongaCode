import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CHILD = fileURLToPath(new URL('./fixtures/untrusted-schema-child.ts', import.meta.url));
const CHILD_TIMEOUT_MS = 60_000;

const runChild = (flags: readonly string[]) => {
  const child = spawnSync(process.execPath, [...flags, CHILD], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, env: { ...process.env, ATA_NO_NATIVE: undefined } });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
};

describe('the untrusted-schema boundary at run time', () => {
  it(
    'compiles and validates with code generation from strings disallowed',
    () => {
      const child = runChild(['--disallow-code-generation-from-strings']);
      expect(child.stderr).not.toMatch(/Code generation from strings disallowed/);
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({ accepted: true, rejected: false });
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'loads no native addon',
    () => {
      const child = runChild([]);
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ accepted: true, rejected: false, nativeModules: [] });
    },
    CHILD_TIMEOUT_MS,
  );
});
