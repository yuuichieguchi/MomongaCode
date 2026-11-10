import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import type { ResolvedSettings, UserSettingsCache, UserSettingsLoaded } from '@momonga/config';
import { canonicalJson } from '@momonga/foundation';
import { flush as flushTurns, ownedHarness, settled } from './derived-fixture.ts';

type Lease<T> = { readonly value: T; release(): void };

type PinnedDerivation<T> = {
  acquire(signal: AbortSignal): Promise<Lease<T>>;
  admit(signal: AbortSignal): Promise<Lease<T>>;
};

type PinnedDerivationOptions<T> = {
  cache: UserSettingsCache;
  signal: AbortSignal;
  inputsOf(settings: ResolvedSettings): unknown;
  derive(settings: ResolvedSettings, previous: T | undefined): T | Promise<T>;
  retire(object: T): void | Promise<void>;
  onWarning(message: string): void;
};

const exported = <F>(name: string): F => {
  const value = (config as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new Error(`@momonga/config does not export ${name} (increment S0, packages/config/src/derived.ts)`);
  return value as F;
};

const createPinnedDerivation = <T>(options: PinnedDerivationOptions<T>): PinnedDerivation<T> =>
  exported<(options: PinnedDerivationOptions<T>) => PinnedDerivation<T>>('createPinnedDerivation')(options);

const settingsInputsDigest = (inputs: unknown): string => exported<(inputs: unknown) => string>('settingsInputsDigest')(inputs);

type FakeCache = UserSettingsCache & { reads: number; set(settings: Record<string, unknown>): void };

const fakeCache = (initial: Record<string, unknown>): FakeCache => {
  let current = initial;
  const loaded = (): UserSettingsLoaded => ({ settings: current as unknown as ResolvedSettings, user: { warnings: [] } as unknown as UserSettingsLoaded['user'] });
  const cache = {
    reads: 0,
    set: (settings: Record<string, unknown>) => {
      current = settings;
    },
    get: () => {
      cache.reads += 1;
      return loaded().settings;
    },
    read: () => {
      cache.reads += 1;
      return loaded();
    },
    snapshot: () => {
      cache.reads += 1;
      return loaded();
    },
    kept: {} as UserSettingsCache['kept'],
  };
  return cache;
};

type Built = { readonly network: unknown; readonly serial: number };

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const harness = (initial: Record<string, unknown>) => {
  const cache = fakeCache(initial);
  const derivations: Array<{ network: unknown; previous: Built | undefined }> = [];
  const retired: Built[] = [];
  const warnings: string[] = [];
  let failWith: Error | undefined;
  let hold: Deferred<void> | undefined;
  const derivation = createPinnedDerivation<Built>({
    cache,
    signal: new AbortController().signal,
    inputsOf: (settings) => (settings as unknown as Record<string, unknown>)['network'] ?? null,
    derive: async (settings, previous) => {
      const network = (settings as unknown as Record<string, unknown>)['network'];
      derivations.push({ network, previous });
      if (hold !== undefined) await hold.promise;
      if (failWith !== undefined) throw failWith;
      return { network, serial: derivations.length };
    },
    retire: (object) => {
      retired.push(object);
    },
    onWarning: (message) => warnings.push(message),
  });
  return {
    cache,
    derivation,
    derivations,
    retired,
    warnings,
    failNext: (error: Error | undefined) => {
      failWith = error;
    },
    holdDerivations: () => {
      hold = deferred<void>();
      return hold;
    },
    releaseHold: () => {
      hold?.resolve();
      hold = undefined;
    },
  };
};

const signal = (): AbortSignal => new AbortController().signal;

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

describe('S0: the pinned derivation (design-settings-live section 2)', () => {
  it('the inputs digest is SHA-256 of the canonical JSON of the inputs', () => {
    const inputs = { httpsProxy: 'http://proxy.corp:3128', caFiles: ['/etc/ca.pem'] };
    const expected = crypto.createHash('sha256').update(canonicalJson(inputs)).digest('hex');
    expect(settingsInputsDigest(inputs)).toBe(expected);
    expect(settingsInputsDigest({ caFiles: ['/etc/ca.pem'], httpsProxy: 'http://proxy.corp:3128' })).toBe(expected);
  });

  it('acquire takes exactly one snapshot from the cache', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' } });
    const first = await h.derivation.acquire(signal());
    expect(h.cache.reads).toBe(1);
    const second = await h.derivation.acquire(signal());
    expect(h.cache.reads).toBe(2);
    first.release();
    second.release();
  });

  it('a change to another section does not rebuild the object', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' }, sandbox: 'seatbelt' });
    const first = await h.derivation.acquire(signal());
    h.cache.set({ network: { httpsProxy: 'http://a:1' }, sandbox: 'none' });
    const second = await h.derivation.acquire(signal());
    expect(h.derivations).toHaveLength(1);
    expect(second.value).toBe(first.value);
  });

  it('a change of the inputs derives a new object with the previous one available, and the old lease keeps its object', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' } });
    const before = await h.derivation.acquire(signal());
    h.cache.set({ network: { httpsProxy: 'http://b:2' } });
    const after = await h.derivation.acquire(signal());
    expect(after.value).toEqual({ network: { httpsProxy: 'http://b:2' }, serial: 2 });
    expect(h.derivations[1]?.previous).toBe(before.value);
    expect(before.value).toEqual({ network: { httpsProxy: 'http://a:1' }, serial: 1 });
  });

  it('two concurrent callers share one derivation', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' } });
    h.holdDerivations();
    const one = h.derivation.acquire(signal());
    const two = h.derivation.acquire(signal());
    await flush();
    h.releaseHold();
    const [a, b] = await Promise.all([one, two]);
    expect(h.derivations).toHaveLength(1);
    expect(a.value).toBe(b.value);
  });

  it('a caller that arrives after a newer edit waits out the older derivation and gets its own target, never the older object', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' } });
    (await h.derivation.acquire(signal())).release();
    h.cache.set({ network: { httpsProxy: 'http://b:2' } });
    h.holdDerivations();
    const olderCaller = h.derivation.acquire(signal());
    await flush();
    h.cache.set({ network: { httpsProxy: 'http://c:3' } });
    const newerCaller = h.derivation.acquire(signal());
    await flush();
    expect(h.derivations).toHaveLength(2);
    h.releaseHold();
    const older = await olderCaller;
    const newer = await newerCaller;
    expect(older.value.network).toEqual({ httpsProxy: 'http://b:2' });
    expect(newer.value.network).toEqual({ httpsProxy: 'http://c:3' });
    expect(h.derivations.map((entry) => entry.network)).toEqual([{ httpsProxy: 'http://a:1' }, { httpsProxy: 'http://b:2' }, { httpsProxy: 'http://c:3' }]);
  });

  it('a failed derivation keeps the previous object current, warns once with the design text, and the next acquire retries once', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' } });
    const good = await h.derivation.acquire(signal());
    h.cache.set({ network: { httpsProxy: 'http://broken:9' } });
    h.failNext(new Error('proxy refused'));
    const fallback = await h.derivation.acquire(signal());
    expect(fallback.value).toBe(good.value);
    expect(h.derivations).toHaveLength(2);
    const again = await h.derivation.acquire(signal());
    expect(again.value).toBe(good.value);
    expect(h.derivations).toHaveLength(3);
    expect(h.warnings).toEqual(['the settings could not be applied: proxy refused; the last applied settings stay in use']);
    h.failNext(undefined);
    const fixed = await h.derivation.acquire(signal());
    expect(fixed.value).toEqual({ network: { httpsProxy: 'http://broken:9' }, serial: 4 });
  });

  it('admit throws the derivation failure where acquire returns the previous object', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' } });
    const good = await h.derivation.acquire(signal());
    h.cache.set({ network: { httpsProxy: 'http://broken:9' } });
    h.failNext(new Error('proxy refused'));
    await expect(h.derivation.admit(signal())).rejects.toThrow('proxy refused');
    expect((await h.derivation.acquire(signal())).value).toBe(good.value);
  });

  it('an object that is replaced is retired once, on the release of its last lease, never while a lease holds it', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' } });
    const first = await h.derivation.acquire(signal());
    const second = await h.derivation.acquire(signal());
    h.cache.set({ network: { httpsProxy: 'http://b:2' } });
    const replacement = await h.derivation.acquire(signal());
    await flush();
    expect(h.retired).toEqual([]);
    first.release();
    await flush();
    expect(h.retired).toEqual([]);
    second.release();
    await flush();
    expect(h.retired).toEqual([first.value]);
    replacement.release();
    await flush();
    expect(h.retired).toEqual([first.value]);
  });

  it('an object with no lease is retired in the call that replaces it', async () => {
    const h = harness({ network: { httpsProxy: 'http://a:1' } });
    const first = await h.derivation.acquire(signal());
    first.release();
    await flush();
    expect(h.retired).toEqual([]);
    h.cache.set({ network: { httpsProxy: 'http://b:2' } });
    (await h.derivation.acquire(signal())).release();
    await flush();
    expect(h.retired).toEqual([first.value]);
  });
});

type DerivedId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';

const declaredObjects = (): readonly { id: DerivedId; inputs: readonly string[] }[] => config.DERIVED_OBJECTS as unknown as readonly { id: DerivedId; inputs: readonly string[] }[];

const derivedDigestsOf = (settings: Record<string, unknown>): Record<DerivedId, string> => {
  const inputsOf = exported<(id: DerivedId) => (settings: ResolvedSettings) => unknown>('derivedInputsOf');
  const ids = declaredObjects().map((object) => object.id);
  return Object.fromEntries(ids.map((id) => [id, settingsInputsDigest(inputsOf(id)(settings as unknown as ResolvedSettings))])) as Record<DerivedId, string>;
};

const changedObjects = (before: Record<string, unknown>, after: Record<string, unknown>): DerivedId[] => {
  const a = derivedDigestsOf(before);
  const b = derivedDigestsOf(after);
  return (Object.keys(a) as DerivedId[]).filter((id) => a[id] !== b[id]).sort();
};

const BASE_SETTINGS: Record<string, unknown> = {
  models: { connections: [{ adapter: 'chat-completions', provider: 'remote', baseUrl: 'https://api.example.com/v1', models: [{ id: 'gpt-x' }] }], fallback: [] },
  sandbox: 'seatbelt',
  gateway: { closeGraceMs: 10_000, managedServerStopGraceMs: 3000 },
};

describe('S0: the digest cases moved from the deleted supervisor plan tests (design-settings-live section 9)', () => {
  it('a models change rebuilds only the gateway object D1', () => {
    expect(changedObjects(BASE_SETTINGS, { ...BASE_SETTINGS, models: { ...(BASE_SETTINGS['models'] as object), start: 'remote/gpt-x' } })).toEqual(['D1']);
  });

  it('a sandbox change rebuilds only the sandbox object D3', () => {
    expect(changedObjects(BASE_SETTINGS, { ...BASE_SETTINGS, sandbox: 'none' })).toEqual(['D3']);
  });

  it('a telemetry change, present against absent, rebuilds only the telemetry object D2', () => {
    expect(changedObjects(BASE_SETTINGS, { ...BASE_SETTINGS, telemetry: { otlp: { endpoint: 'http://127.0.0.1:4318' } } })).toEqual(['D2']);
  });

  it('a network change, present against absent, rebuilds every object that makes outbound connections (D1, D2, D4, D5) and not the sandbox', () => {
    expect(changedObjects(BASE_SETTINGS, { ...BASE_SETTINGS, network: { httpsProxy: 'http://proxy.corp:3128' } })).toEqual(['D1', 'D2', 'D4', 'D5']);
    expect(changedObjects({ ...BASE_SETTINGS, network: { httpsProxy: 'http://proxy.corp:3128' } }, { ...BASE_SETTINGS, network: { httpsProxy: 'http://proxy.corp:8080' } })).toEqual(['D1', 'D2', 'D4', 'D5']);
  });

  it('a change of the stop values rebuilds nothing (they are read at the stop begin)', () => {
    expect(changedObjects(BASE_SETTINGS, { ...BASE_SETTINGS, gateway: { closeGraceMs: 0, managedServerStopGraceMs: 60_000 } })).toEqual([]);
  });

  it('reformatting, the same sections with keys in another order, rebuilds nothing', () => {
    const reordered = { gateway: BASE_SETTINGS['gateway'], sandbox: 'seatbelt', models: { fallback: [], connections: (BASE_SETTINGS['models'] as { connections: unknown }).connections } };
    expect(changedObjects(BASE_SETTINGS, reordered)).toEqual([]);
  });
});

describe('O-R5-6 (K) 3: context.unboundedOutputReserve is an input of the gateway object D1 (design-chatgpt-plan section 2 item 7)', () => {
  const withReserve = (unboundedOutputReserve: boolean): Record<string, unknown> => ({ ...BASE_SETTINGS, context: { unboundedOutputReserve } });

  it('turning the reserve on rebuilds exactly D1, whose inputs are models, network, pricing and the key context.unboundedOutputReserve', () => {
    expect(declaredObjects().find((object) => object.id === 'D1')?.inputs).toEqual(['models', 'network', 'pricing', 'context.unboundedOutputReserve']);
    expect(changedObjects(withReserve(false), withReserve(true))).toEqual(['D1']);
  });

  it('turning the reserve off rebuilds exactly D1', () => {
    expect(declaredObjects().find((object) => object.id === 'D1')?.inputs).toEqual(['models', 'network', 'pricing', 'context.unboundedOutputReserve']);
    expect(changedObjects(withReserve(true), withReserve(false))).toEqual(['D1']);
  });
});

describe('O-R5-6 L5: a key-path input and the plan scope object D5 (design-chatgpt-plan O-R5-6 L1, L5)', () => {
  const withContext = (context: Record<string, unknown>): Record<string, unknown> => ({ ...BASE_SETTINGS, context });
  const withPlaintext = (plaintextTokenFiles: boolean): Record<string, unknown> => ({ ...BASE_SETTINGS, credentials: { plaintextTokenFiles } });

  it('a key path input digests the key, not the section', () => {
    const inputsOf = exported<(id: DerivedId) => (settings: ResolvedSettings) => Record<string, unknown>>('derivedInputsOf');
    const settings = withContext({ unboundedOutputReserve: true, other: 1 }) as unknown as ResolvedSettings;
    expect(inputsOf('D1')(settings)).toEqual({ models: BASE_SETTINGS['models'], network: null, pricing: null, 'context.unboundedOutputReserve': true });
    expect(inputsOf('D1')(BASE_SETTINGS as unknown as ResolvedSettings)).toEqual({ models: BASE_SETTINGS['models'], network: null, pricing: null, 'context.unboundedOutputReserve': null });
    expect(changedObjects(withContext({ unboundedOutputReserve: true, other: 1 }), withContext({ unboundedOutputReserve: true, other: 2 }))).toEqual([]);
  });

  it('D5 rebuilds on network or credentials.plaintextTokenFiles only', () => {
    expect(declaredObjects().find((object) => object.id === 'D5')?.inputs).toEqual(['network', 'credentials.plaintextTokenFiles']);
    expect(changedObjects(withPlaintext(false), withPlaintext(true))).toEqual(['D5']);
    expect(changedObjects(withContext({ unboundedOutputReserve: false }), withContext({ unboundedOutputReserve: true }))).toEqual(['D1']);
    expect(changedObjects(withContext({ unboundedOutputReserve: false }), withContext({ unboundedOutputReserve: false, compactAt: 0.5 }))).toEqual([]);
    expect(changedObjects(BASE_SETTINGS, { ...BASE_SETTINGS, network: { httpsProxy: 'http://proxy.corp:3128' } })).toContain('D5');
  });
});

describe('S0: a derivation runs under its owner signal; a caller abort detaches only that caller (design-settings-live 15.6, AbortIsolated)', () => {
  const ready = async () => {
    const h = ownedHarness();
    const first = h.derivation.acquire(new AbortController().signal);
    await flushTurns();
    h.gates.shift()?.release();
    (await first).release();
    h.edit();
    return h;
  };

  it('derive receives the owner signal, not the signal of the caller that started it', async () => {
    const h = await ready();
    const starter = new AbortController();
    void h.derivation.acquire(starter.signal).catch(() => undefined);
    await flushTurns();
    expect(h.derived.at(-1)?.signal).toBe(h.owner.signal);
  });

  it('the starter abort rejects only the starter; another waiter gets the new object, the flight completes, nothing is logged', async () => {
    const h = await ready();
    const starter = new AbortController();
    const started = settled(h.derivation.acquire(starter.signal));
    const waiter = settled(h.derivation.admit(new AbortController().signal));
    await flushTurns();
    starter.abort(new Error('the starter went away'));
    await flushTurns();
    expect(started.outcome).toBe('rejected');
    expect(waiter.outcome).toBe('pending');
    h.gates.shift()?.release();
    await flushTurns();
    expect(waiter.outcome).toBe('resolved');
    expect(waiter.value?.value.version).toBe(2);
    expect(h.derived).toHaveLength(2);
    expect(h.warnings).toEqual([]);
  });

  it('a flight whose waiters all left still finishes and becomes current', async () => {
    const h = await ready();
    const starter = new AbortController();
    const started = settled(h.derivation.acquire(starter.signal));
    await flushTurns();
    starter.abort(new Error('the only waiter went away'));
    await flushTurns();
    expect(started.outcome).toBe('rejected');
    h.gates.shift()?.release();
    await flushTurns();
    const next = settled(h.derivation.acquire(new AbortController().signal));
    await flushTurns();
    expect(h.derived).toHaveLength(2);
    expect(next.outcome).toBe('resolved');
    expect(next.value?.value.version).toBe(2);
    expect(h.warnings).toEqual([]);
  });

  it('an owner abort ends the flight silently', async () => {
    const h = await ready();
    const waiter = settled(h.derivation.acquire(new AbortController().signal));
    await flushTurns();
    h.owner.abort(new Error('the process is stopping'));
    await flushTurns();
    expect(waiter.outcome).not.toBe('pending');
    expect(h.warnings).toEqual([]);
  });

  it('an acquire under an already aborted signal rejects with its reason, derives nothing and takes no lease', async () => {
    const h = await ready();
    const reason = new Error('gone');
    const aborted = new AbortController();
    aborted.abort(reason);
    const outcome = h.derivation.acquire(aborted.signal);
    await expect(outcome).rejects.toBe(reason);
    await flushTurns();
    expect(h.derived).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  it('the failure is logged only when derive itself throws', async () => {
    const h = await ready();
    const waiter = settled(h.derivation.acquire(new AbortController().signal));
    await flushTurns();
    h.gates.shift()?.fail(new Error('proxy refused'));
    await flushTurns();
    expect(waiter.outcome).toBe('resolved');
    expect(h.warnings).toEqual(['the settings could not be applied: proxy refused; the last applied settings stay in use']);
  });
});
