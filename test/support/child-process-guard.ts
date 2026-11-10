import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { assertFakeSecretStoreEnv } from '../../packages/testkit/src/secret-store-env-check.ts';

const LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;

type Launcher = (...args: unknown[]) => unknown;
type ProcessEnv = Readonly<Record<string, string | undefined>>;

const GUARDED = Symbol.for('momonga.childProcessGuard');

const optionsOf = (args: readonly unknown[]): { env?: ProcessEnv } | undefined =>
  args.slice(1).find((arg): arg is { env?: ProcessEnv } => typeof arg === 'object' && arg !== null && !Array.isArray(arg)) as { env?: ProcessEnv } | undefined;

const childProcess = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;

const checked =
  (launch: Launcher): Launcher =>
  function checkedLaunch(this: unknown, ...args: unknown[]): unknown {
    assertFakeSecretStoreEnv(optionsOf(args)?.env ?? process.env, String(args[0]));
    return launch.apply(this, args);
  };

for (const name of LAUNCHERS) {
  const original = childProcess[name] as Launcher & { [GUARDED]?: true; [promisify.custom]?: Launcher };
  if (original[GUARDED] === true) continue;
  const guarded = checked(original) as Launcher & { [GUARDED]?: true; [promisify.custom]?: Launcher };
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key) as PropertyDescriptor;
    Object.defineProperty(guarded, key, key === promisify.custom ? { ...descriptor, value: checked(descriptor.value as Launcher) } : descriptor);
  }
  Object.defineProperty(guarded, GUARDED, { value: true });
  childProcess[name] = guarded;
}
syncBuiltinESMExports();
