import * as config from '@momonga/config';
import type { ResolvedSettings, UserSettingsCache, UserSettingsLoaded } from '@momonga/config';

export type Lease<T> = { readonly value: T; release(): void };

export type Derivation<T> = {
  acquire(signal: AbortSignal): Promise<Lease<T>>;
  admit(signal: AbortSignal): Promise<Lease<T>>;
};

export type OwnedDerivationOptions<T> = {
  cache: Pick<UserSettingsCache, 'read'>;
  signal: AbortSignal;
  inputsOf(settings: ResolvedSettings): unknown;
  derive(settings: ResolvedSettings, previous: T | undefined, signal: AbortSignal): T | Promise<T>;
  retire(object: T): void | Promise<void>;
  onWarning(message: string): void;
};

export const createOwnedDerivation = <T>(options: OwnedDerivationOptions<T>): Derivation<T> =>
  (config.createPinnedDerivation as unknown as (options: OwnedDerivationOptions<T>) => Derivation<T>)(options);

export type Built = { readonly version: number; readonly serial: number };

type Gate = { readonly signal: AbortSignal; release(): void; fail(error: Error): void };

export const settled = <T>(promise: Promise<T>) => {
  const state: { outcome: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { outcome: 'pending' };
  promise.then(
    (value) => {
      state.outcome = 'resolved';
      state.value = value;
    },
    (error: unknown) => {
      state.outcome = 'rejected';
      state.error = error;
    },
  );
  return state;
};

export const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
};

export const ownedHarness = () => {
  let version = 1;
  const owner = new AbortController();
  const cache: Pick<UserSettingsCache, 'read'> = {
    read: (): UserSettingsLoaded => ({ settings: { version } as unknown as ResolvedSettings, user: { warnings: [] } as unknown as UserSettingsLoaded['user'] }),
  };
  const gates: Gate[] = [];
  const derived: Array<{ version: number; signal: AbortSignal }> = [];
  const retired: Built[] = [];
  const warnings: string[] = [];
  const derivation = createOwnedDerivation<Built>({
    cache,
    signal: owner.signal,
    inputsOf: (settings) => (settings as unknown as { version: number }).version,
    derive: (settings, _previous, signal) =>
      new Promise<Built>((resolve, reject) => {
        const forVersion = (settings as unknown as { version: number }).version;
        derived.push({ version: forVersion, signal });
        const onAbort = (): void => reject(signal.reason);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        gates.push({
          signal,
          release: () => {
            signal.removeEventListener('abort', onAbort);
            resolve({ version: forVersion, serial: derived.length });
          },
          fail: (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        });
      }),
    retire: (object) => {
      retired.push(object);
    },
    onWarning: (message) => warnings.push(message),
  });
  return {
    owner,
    derivation,
    derived,
    gates,
    retired,
    warnings,
    edit: () => {
      version += 1;
      return version;
    },
    version: () => version,
  };
};
