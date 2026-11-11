import { describe, expect, it } from 'vitest';
import { createPinnedDerivation } from '@momonga/config';
import type { PinnedDerivation, ResolvedSettings, UserSettingsCache, UserSettingsLoaded } from '@momonga/config';

type Built = { readonly serial: number; readonly inputs: unknown };

type Hooks = {
  inputsOf(): unknown;
  prepare(signal: AbortSignal): Promise<void> | undefined;
  derive(): void;
};

const cache: Pick<UserSettingsCache, 'loadOrKeep'> = {
  loadOrKeep: async (): Promise<UserSettingsLoaded> => ({ settings: {} as ResolvedSettings, user: { warnings: [] } as unknown as UserSettingsLoaded['user'] }),
};

const derivationWith = (hooks: Hooks) => {
  const owner = new AbortController();
  const derived: unknown[][] = [];
  const warnings: string[] = [];
  const prepareCalls = { count: 0 };
  const derivation = createPinnedDerivation<Built>({
    cache,
    signal: owner.signal,
    inputsOf: () => hooks.inputsOf(),
    prepare: (_settings: ResolvedSettings, signal: AbortSignal) => {
      prepareCalls.count += 1;
      return hooks.prepare(signal);
    },
    derive: (...args: unknown[]) => {
      derived.push(args);
      hooks.derive();
      return { serial: derived.length, inputs: args[3] };
    },
    retire: () => undefined,
    onWarning: (message) => void warnings.push(message),
  } as Parameters<typeof createPinnedDerivation<Built>>[0]) as PinnedDerivation<Built>;
  return { derivation, derived, warnings, prepareCalls };
};

const signal = (): AbortSignal => new AbortController().signal;

describe('createPinnedDerivation loads what the digest reads before it computes the digest', () => {
  it('prepare runs before the digest: the epoch is derived once when inputsOf reads state that prepare loads', async () => {
    let loaded = false;
    let prepared = false;
    const h = derivationWith({
      inputsOf: () => ({ v: loaded ? 1 : 0 }),
      prepare: () => {
        if (prepared) return undefined;
        prepared = true;
        return Promise.resolve().then(() => {
          loaded = true;
        });
      },
      derive: () => {
        loaded = true;
      },
    });
    const first = await h.derivation.acquire(signal());
    const second = await h.derivation.acquire(signal());
    expect(h.derived).toHaveLength(1);
    expect(second.value).toBe(first.value);
    expect(first.value.inputs).toEqual({ v: 1 });
  });

  it('derive receives the inputs of its digest', async () => {
    const returned: unknown[] = [];
    const h = derivationWith({
      inputsOf: () => {
        const inputs = { n: returned.length + 1 };
        returned.push(inputs);
        return inputs;
      },
      prepare: () => undefined,
      derive: () => undefined,
    });
    await h.derivation.acquire(signal());
    expect(returned).toHaveLength(1);
    expect(h.derived).toHaveLength(1);
    expect(h.derived[0]?.[3]).toBe(returned[0]);
    expect(h.derived[0]?.[3]).toEqual({ n: 1 });
  });

  it('a rejecting prepare keeps the last good epoch with one warning, and rejects an admit', async () => {
    let failing = false;
    const h = derivationWith({
      inputsOf: () => ({ v: 1 }),
      prepare: () => (failing ? Promise.reject(new Error('catalog corrupt')) : undefined),
      derive: () => undefined,
    });
    const good = await h.derivation.acquire(signal());
    failing = true;
    const kept = await h.derivation.acquire(signal());
    const keptAgain = await h.derivation.acquire(signal());
    expect(kept.value).toBe(good.value);
    expect(keptAgain.value).toBe(good.value);
    expect(h.warnings).toEqual(['the settings could not be applied: catalog corrupt; the last applied settings stay in use']);
    await expect(h.derivation.admit(signal())).rejects.toThrow('catalog corrupt');
    expect(h.derived).toHaveLength(1);
  });

  it('prepare returning undefined adds no derivation', async () => {
    const h = derivationWith({
      inputsOf: () => ({ v: 1 }),
      prepare: () => undefined,
      derive: () => undefined,
    });
    const first = await h.derivation.acquire(signal());
    const second = await h.derivation.acquire(signal());
    expect(second.value).toBe(first.value);
    expect(h.derived).toHaveLength(1);
    expect(h.prepareCalls.count).toBe(2);
  });

  it('a move of the served account while prepare awaits is seen: the epoch is derived from the inputs read after prepare', async () => {
    let served = 'A';
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const prepareReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let gated = false;
    const h = derivationWith({
      inputsOf: () => ({ served }),
      prepare: () => {
        if (gated) return undefined;
        gated = true;
        reached();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      derive: () => undefined,
    });
    const lease = h.derivation.acquire(signal());
    await Promise.race([prepareReached, lease.then(() => undefined)]);
    expect(h.prepareCalls.count).toBe(1);
    served = 'B';
    release();
    expect((await lease).value.inputs).toEqual({ served: 'B' });
    expect(h.derived.map((args) => args[3])).toEqual([{ served: 'B' }]);
  });
});
