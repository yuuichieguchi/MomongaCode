import { canonicalJson, isRecord, sha256Hex } from '@momonga/foundation';
import type { ResolvedSettings } from './load-settings.ts';
import type { UserSettingsCache } from './user-settings.ts';

export type SettingsKeyPath = 'context.unboundedOutputReserve' | 'credentials.plaintextTokenFiles';

export type SettingsSection = 'models' | 'network' | 'pricing' | 'telemetry' | 'sandbox' | SettingsKeyPath;

export type DerivedObjectDeclaration = { readonly id: DerivedObjectId; readonly inputs: readonly SettingsSection[] };

export const DERIVED_OBJECTS = [
  { id: 'D1', inputs: ['models', 'network', 'pricing', 'context.unboundedOutputReserve'] },
  { id: 'D2', inputs: ['network', 'telemetry'] },
  { id: 'D3', inputs: ['sandbox'] },
  { id: 'D4', inputs: ['network'] },
  { id: 'D5', inputs: ['network', 'credentials.plaintextTokenFiles'] },
] as const satisfies readonly { id: string; inputs: readonly SettingsSection[] }[];

export type DerivedObjectId = (typeof DERIVED_OBJECTS)[number]['id'];

export const settingsInputsDigest = (inputs: unknown): string => sha256Hex(canonicalJson(inputs));

const plainOf = (value: unknown): unknown => {
  if (value instanceof Map) return [...value].map(([key, entry]) => [key, plainOf(entry)]);
  if (Array.isArray(value)) return value.map(plainOf);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (entry === undefined ? [] : [[key, plainOf(entry)]])));
  return value;
};

const inputValueOf = (settings: ResolvedSettings, input: SettingsSection): unknown => {
  const [section, key] = input.split('.');
  const value = (settings as Record<string, unknown>)[section as string];
  if (key === undefined) return plainOf(value ?? null);
  return plainOf((value as Record<string, unknown> | undefined)?.[key] ?? null);
};

export const derivedInputsOf =
  (id: DerivedObjectId) =>
  (settings: ResolvedSettings): Record<string, unknown> => {
    const declaration = DERIVED_OBJECTS.find((object) => object.id === id);
    if (declaration === undefined) throw new Error(`unknown derived object ${id}`);
    return Object.fromEntries(declaration.inputs.map((input) => [input, inputValueOf(settings, input)]));
  };

export type Lease<T> = { readonly value: T; release(): void };

export type PinnedDerivation<T> = {
  acquire(signal: AbortSignal): Promise<Lease<T>>;
  admit(signal: AbortSignal): Promise<Lease<T>>;
  current(): T;
  retireAll(): Promise<void>;
};

export type PinnedDerivationOptions<T> = {
  cache: Pick<UserSettingsCache, 'loadOrKeep'>;
  signal: AbortSignal;
  inputsOf(settings: ResolvedSettings): unknown;
  prepare?(settings: ResolvedSettings, signal: AbortSignal): Promise<void> | undefined;
  derive(settings: ResolvedSettings, previous: T | undefined, signal: AbortSignal, inputs: unknown): T | Promise<T>;
  retire(object: T): void | Promise<void>;
  onWarning(message: string): void;
};

type Entry<T> = { readonly digest: string; readonly value: T; leases: number; retired: boolean };

type Waiter<T> = { readonly admitting: boolean; resolve(lease: Lease<T>): void; reject(error: unknown): void; readonly signal: AbortSignal; detach(): void };

type InFlight<T> = { readonly digest: string; readonly waiters: Set<Waiter<T>>; settled: Promise<void> };

export const derivationFailureText = (reason: string): string => `the settings could not be applied: ${reason}; the last applied settings stay in use`;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Prepared = { failed: false } | { failed: true; error: unknown };

export const createPinnedDerivation = <T>({ cache, signal: owner, inputsOf, prepare, derive, retire, onWarning }: PinnedDerivationOptions<T>): PinnedDerivation<T> => {
  let current: Entry<T> | undefined;
  let inFlight: InFlight<T> | undefined;
  const warned = new Set<string>();
  const warnedPrepareReasons = new Set<string>();
  const live = new Set<Entry<T>>();
  const retirements = new Set<Promise<void>>();

  const retireNow = (entry: Entry<T>): Promise<void> => {
    entry.retired = true;
    live.delete(entry);
    return Promise.resolve().then(() => retire(entry.value));
  };

  const retireIfIdle = (entry: Entry<T>): void => {
    if (entry === current || entry.leases > 0 || entry.retired) return;
    const retirement = retireNow(entry)
      .catch((error: unknown) => onWarning(`a replaced settings object could not be closed: ${reasonOf(error)}`))
      .finally(() => retirements.delete(retirement));
    retirements.add(retirement);
  };

  const leaseOf = (entry: Entry<T>): Lease<T> => {
    entry.leases += 1;
    let released = false;
    return {
      value: entry.value,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        retireIfIdle(entry);
      },
    };
  };

  const settle = (flight: InFlight<T>, outcome: { entry: Entry<T> } | { error: unknown }): void => {
    for (const waiter of flight.waiters) {
      waiter.detach();
      if ('entry' in outcome) waiter.resolve(leaseOf(outcome.entry));
      else if (waiter.admitting || current === undefined) waiter.reject(outcome.error);
      else waiter.resolve(leaseOf(current));
    }
    flight.waiters.clear();
  };

  const start = (digest: string, settings: ResolvedSettings, inputs: unknown): InFlight<T> => {
    const previous = current;
    const flight: InFlight<T> = { digest, waiters: new Set<Waiter<T>>(), settled: Promise.resolve() };
    flight.settled = (async () => {
      await Promise.resolve();
      try {
        const value = await derive(settings, previous?.value, owner, inputs);
        const entry: Entry<T> = { digest, value, leases: 0, retired: false };
        live.add(entry);
        current = entry;
        warned.delete(digest);
        inFlight = undefined;
        settle(flight, { entry });
        if (previous !== undefined) retireIfIdle(previous);
      } catch (error) {
        if (!owner.aborted && !warned.has(digest)) {
          warned.add(digest);
          onWarning(derivationFailureText(reasonOf(error)));
        }
        inFlight = undefined;
        settle(flight, { error });
      }
    })();
    return flight;
  };

  const join = (flight: InFlight<T>, admitting: boolean, signal: AbortSignal): Promise<Lease<T>> =>
    new Promise<Lease<T>>((resolve, reject) => {
      const onAbort = (): void => {
        flight.waiters.delete(waiter);
        reject(signal.reason);
      };
      const waiter: Waiter<T> = { admitting, resolve, reject, signal, detach: () => signal.removeEventListener('abort', onAbort) };
      flight.waiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });

  const awaitSettled = (flight: InFlight<T>, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void flight.settled.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });

  const awaitPrepared = (pending: Promise<void>, signal: AbortSignal): Promise<Prepared> =>
    new Promise<Prepared>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      const settled = (outcome: Prepared): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      pending.then(
        () => settled({ failed: false }),
        (error: unknown) => settled({ failed: true, error }),
      );
    });

  const warnPrepareFailure = (error: unknown): void => {
    const reason = reasonOf(error);
    if (owner.aborted || warnedPrepareReasons.has(reason)) return;
    warnedPrepareReasons.add(reason);
    onWarning(derivationFailureText(reason));
  };

  const takeFor = async (settings: ResolvedSettings, admitting: boolean, signal: AbortSignal): Promise<Lease<T>> => {
    const inputs = inputsOf(settings);
    const digest = settingsInputsDigest(inputs);
    for (;;) {
      if (current !== undefined && current.digest === digest) return leaseOf(current);
      if (inFlight === undefined) {
        inFlight = start(digest, settings, inputs);
        return join(inFlight, admitting, signal);
      }
      if (inFlight.digest === digest) return join(inFlight, admitting, signal);
      await awaitSettled(inFlight, signal);
    }
  };

  const take = async (admitting: boolean, signal: AbortSignal): Promise<Lease<T>> => {
    for (;;) {
      signal.throwIfAborted();
      const { settings } = await cache.loadOrKeep(signal);
      const pending = prepare?.(settings, signal);
      if (pending === undefined) return takeFor(settings, admitting, signal);
      const prepared = await awaitPrepared(pending, signal);
      if (prepared.failed) {
        warnPrepareFailure(prepared.error);
        if (admitting || current === undefined) throw prepared.error;
        return leaseOf(current);
      }
      warnedPrepareReasons.clear();
    }
  };

  return {
    acquire: (signal) => take(false, signal),
    admit: (signal) => take(true, signal),
    current: () => {
      if (current === undefined) throw new Error('no settings object has been derived yet');
      return current.value;
    },
    retireAll: async () => {
      if (inFlight !== undefined) await inFlight.settled;
      current = undefined;
      const failures: unknown[] = [];
      await Promise.all([...live].map((entry) => retireNow(entry).catch((error: unknown) => failures.push(error))));
      await Promise.all([...retirements]);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'one or more settings objects failed to close');
    },
  };
};
