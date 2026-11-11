import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { EMPTY_PROTECTED_SET, canonicalJson, protectedSetFor, sha256Hex, ruleEnforcementOf, momongaLayout } from '@momonga/foundation';
import { fakePolicyFilesystem, testProbes, NEVER_CANCELLED, testPaths, testKernelLock } from '@momonga/testkit';
import { computeFileRules, parseRule } from '@momonga/policy';
import { buildSandboxPolicy } from '@momonga/tools';
import type { LeaseFence, LeasedIdempotencyPort } from '@momonga/tools';
import type { PermissionRule, RuleEffect } from '@momonga/policy';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, heldMountPoints, validateSandboxPolicy } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';

const SEATBELT_PATH = '/usr/bin/sandbox-exec';

export const HAS_REAL_SANDBOX = (process.platform === 'darwin' && fs.existsSync(SEATBELT_PATH)) || (process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH));

export const HOST_SANDBOX_KIND = process.platform === 'darwin' ? ('seatbelt' as const) : ('bubblewrap' as const);

export const createHostSandbox = (options: { tmpRoot: string; killGraceMs: number }): Sandbox =>
  process.platform === 'darwin' ? createSeatbeltSandbox({ lock: testKernelLock(), ...options }) : createBubblewrapSandbox({ lock: testKernelLock(), ...options, journal: createPlaceholderJournal(`${options.tmpRoot}-journal`), holders: () => heldMountPoints() });

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export type Layout = { root: string; home: string; project: string; outside: string };

export const makeLayout = (): Layout => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = { root, home: path.join(root, 'home'), project: path.join(root, 'project'), outside: path.join(root, 'outside') };
  for (const dir of [layout.home, layout.project, layout.outside]) fs.mkdirSync(dir, { recursive: true });
  return layout;
};

export const ruleFor =
  (layout: Layout) =>
  (effect: RuleEffect, text: string): PermissionRule =>
    parseRule(text, { effect, origin: 'user', source: 'user-settings', settingsRoot: layout.project, home: layout.home, cwd: layout.project });

export type FakeClock = { now(): number; set(value: number): void };

export const makeClock = (start = 1_000_000): FakeClock => {
  let current = start;
  return { now: () => current, set: (value) => void (current = value) };
};

type FakeRecord = {
  key: string;
  state: 'PENDING' | 'UNKNOWN';
  meta: Record<string, unknown>;
  pgid?: number;
  startedAt?: number;
  authorisedAt?: number;
  createdAt: number;
  expiresAt: number;
};

type FakeBegin =
  | { s: 'NEW' }
  | { s: 'PENDING'; rec: FakeRecord }
  | { s: 'UNKNOWN'; rec: FakeRecord }
  | { s: 'COMPLETED'; result: unknown };

type Entry = { kind: 'open'; rec: FakeRecord } | { kind: 'completed'; result: unknown; pgid?: number };

export type IdempotencyLog =
  | { op: 'begin'; key: string; expiresAt: number; meta: Record<string, unknown>; s: FakeBegin['s'] }
  | { op: 'attachProcess'; key: string; pgid: number; startedAt: number }
  | { op: 'checkpoint'; key: string; state: Record<string, unknown> | undefined }
  | { op: 'complete'; key: string; result: unknown }
  | { op: 'markUnknown'; key: string }
  | { op: 'markUnknownIfPending'; key: string; changed: boolean };

export const makeIdempotency = (clock: { now(): number }) => {
  const records = new Map<string, Entry>();
  const log: IdempotencyLog[] = [];
  const lookups: string[] = [];
  const lease = { held: true };
  const fences: LeaseFence[] = [];
  const authorised: string[] = [];
  const port = {
    get(key: string): Exclude<FakeBegin, { s: 'NEW' }> | undefined {
      lookups.push(key);
      const existing = records.get(key);
      if (existing === undefined) return undefined;
      if (existing.kind === 'completed') return { s: 'COMPLETED', result: existing.result };
      return existing.rec.state === 'UNKNOWN' ? { s: 'UNKNOWN', rec: existing.rec } : { s: 'PENDING', rec: existing.rec };
    },
    processGroupOf(key: string): number | undefined {
      const existing = records.get(key);
      if (existing === undefined) return undefined;
      return existing.kind === 'completed' ? existing.pgid : existing.rec.pgid;
    },
    begin(key: string, options: { expiresAt: number; meta: Record<string, unknown> }): FakeBegin {
      const existing = records.get(key);
      let result: FakeBegin;
      if (existing === undefined) {
        records.set(key, { kind: 'open', rec: { key, state: 'PENDING', meta: options.meta, createdAt: clock.now(), expiresAt: options.expiresAt } });
        result = { s: 'NEW' };
      } else if (existing.kind === 'completed') {
        result = { s: 'COMPLETED', result: existing.result };
      } else if (existing.rec.state === 'UNKNOWN') {
        result = { s: 'UNKNOWN', rec: existing.rec };
      } else {
        result = { s: 'PENDING', rec: existing.rec };
      }
      log.push({ op: 'begin', key, expiresAt: options.expiresAt, meta: options.meta, s: result.s });
      return result;
    },
    attachProcess(key: string, processInfo: { pgid: number; startedAt: number }): void {
      log.push({ op: 'attachProcess', key, ...processInfo });
      const existing = records.get(key);
      if (existing?.kind === 'open') existing.rec = { ...existing.rec, ...processInfo };
    },
    checkpoint(key: string, state: Record<string, unknown> | undefined): void {
      log.push({ op: 'checkpoint', key, state });
      const existing = records.get(key);
      if (existing?.kind !== 'open') return;
      const { checkpoint: _previous, ...meta } = existing.rec.meta;
      existing.rec = { ...existing.rec, meta: state === undefined ? meta : { ...meta, checkpoint: state } };
    },
    complete(key: string, result: unknown): void {
      log.push({ op: 'complete', key, result });
      const existing = records.get(key);
      const pgid = existing?.kind === 'open' ? existing.rec.pgid : undefined;
      records.set(key, { kind: 'completed', result, ...(pgid === undefined ? {} : { pgid }) });
    },
    clearCheckpoint(key: string): void {
      port.checkpoint(key, undefined);
    },
    holding(fence: LeaseFence): LeasedIdempotencyPort {
      fences.push(fence);
      const lost = { kind: 'lease_lost' } as const;
      const ok = { kind: 'ok' } as const;
      return {
        begin: (key, options) => (lease.held ? port.begin(key, options) : { s: 'LEASE_LOST' }),
        authorise: (key, purpose) => {
          if (!lease.held) return lost;
          authorised.push(key);
          const existing = records.get(key);
          if (existing?.kind === 'open' && purpose !== 'reconcile') existing.rec = { ...existing.rec, authorisedAt: clock.now() };
          return ok;
        },
        attachProcess: (key, processInfo) => {
          if (!lease.held) return lost;
          port.attachProcess(key, processInfo);
          return ok;
        },
        checkpoint: (key, state) => {
          if (!lease.held) return lost;
          port.checkpoint(key, state);
          return ok;
        },
        complete: (key, result) => {
          if (!lease.held) return lost;
          port.complete(key, result);
          return ok;
        },
      };
    },
    markUnknown(key: string): void {
      log.push({ op: 'markUnknown', key });
      const existing = records.get(key);
      if (existing?.kind === 'open') existing.rec = { ...existing.rec, state: 'UNKNOWN' };
    },
    markUnknownIfPending(key: string): boolean {
      const existing = records.get(key);
      const changed = existing?.kind === 'open' && existing.rec.state === 'PENDING';
      if (changed) existing.rec = { ...existing.rec, state: 'UNKNOWN' };
      log.push({ op: 'markUnknownIfPending', key, changed });
      return changed;
    },
  };
  const seed = (key: string, state: 'PENDING' | 'UNKNOWN', meta: Record<string, unknown>): FakeRecord => {
    const rec: FakeRecord = { key, state, meta, createdAt: clock.now() - 1000, expiresAt: clock.now() + 60_000 };
    records.set(key, { kind: 'open', rec });
    return rec;
  };
  const stateOf = (key: string): 'PENDING' | 'UNKNOWN' | 'COMPLETED' | undefined => {
    const entry = records.get(key);
    if (entry === undefined) return undefined;
    return entry.kind === 'completed' ? 'COMPLETED' : entry.rec.state;
  };
  return { port, records, log, lookups, lease, fences, authorised, seed, stateOf };
};

export const blobHandle = (index: number): string => createHash('sha256').update(`blob-${index}`).digest('hex');

export const makeBlobs = () => {
  const stored = new Map<string, { text: string; mediaType: string }>();
  const puts: Array<{ handle: string; mediaType: string }> = [];
  const port = {
    async put(data: string | Uint8Array, options: { mediaType: string }) {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      const handle = blobHandle(stored.size + 1);
      stored.set(handle, { text, mediaType: options.mediaType });
      puts.push({ handle, mediaType: options.mediaType });
      return {
        handle,
        sha256: createHash('sha256').update(text).digest('hex'),
        byteLength: Buffer.byteLength(text),
        lineCount: text.split('\n').length,
      };
    },
    read(handle: string, range: { lineStart: number; lineEnd: number } | { offset: number; length: number }) {
      const entry = stored.get(handle);
      if (entry === undefined) return Promise.reject(Object.assign(new Error(`no blob ${handle}`), { code: 'BLOB_NOT_FOUND' }));
      const lines = entry.text.split('\n');
      const base = { totalLines: lines.length, totalBytes: Buffer.byteLength(entry.text) };
      if ('lineStart' in range) return Promise.resolve({ ...base, text: lines.slice(range.lineStart - 1, range.lineEnd).join('\n') });
      return Promise.resolve({ ...base, text: entry.text.slice(range.offset, range.offset + range.length), offset: range.offset, length: range.length });
    },
  } as {
    put(data: string | Uint8Array, options: { mediaType: string }): Promise<{ handle: string; sha256: string; byteLength: number; lineCount: number }>;
    read(handle: string, range: { lineStart: number; lineEnd: number }): Promise<{ text: string; totalLines: number; totalBytes: number }>;
    read(
      handle: string,
      range: { offset: number; length: number },
    ): Promise<{ text: string; totalLines: number; totalBytes: number; offset: number; length: number }>;
  };
  return { port, stored, puts };
};

export const fakeSandbox: Sandbox = {
  kind: 'seatbelt',
  spawn: () => {
    throw new Error('sandbox is not used by executor tests');
  },
};

export const noneSandbox: Sandbox = {
  kind: 'none',
  spawn: () => {
    throw new Error('sandbox is not used by executor tests');
  },
};

export const sessionsTmpRootOf = (layout: Layout): string => path.join(layout.root, 'sessions');

export const sessionTmpDirOf = (layout: Layout): string => {
  const tmpDir = path.join(sessionsTmpRootOf(layout), 'session-0');
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
};

export type PolicyInputs = { layout: Layout; rules?: readonly PermissionRule[]; roots?: readonly string[]; tmpDir?: string };

export const minimalPolicyFor = async ({ layout, rules = [], roots = [layout.project], tmpDir }: PolicyInputs): Promise<SandboxPolicy> => {
  const policy: SandboxPolicy = {
    writableRoots: [layout.project],
    writeDenied: [],
    writeDeniedLiterals: [],
    readDenied: [],
    network: 'deny',
    fileRules: await computeFileRules(rules, roots, tmpDir ?? null, ruleEnforcementOf(HOST_SANDBOX_KIND), testProbes()),
    protectedSet: EMPTY_PROTECTED_SET,
  };
  await validateSandboxPolicy(policy, tmpDir === undefined ? {} : { tmpDir }, testPaths());
  return policy;
};

export const policyFor = async ({ layout, rules = [], roots = [layout.project], tmpDir = sessionTmpDirOf(layout) }: PolicyInputs): Promise<SandboxPolicy> =>
  await buildSandboxPolicy({
    layout: momongaLayout(layout.home, process.platform, process.env),
    roots: [...roots],
    home: layout.home,
    tmpDir,
    sessionsTmpRoot: sessionsTmpRootOf(layout),
    fileRules: await computeFileRules(rules, roots, tmpDir, ruleEnforcementOf(HOST_SANDBOX_KIND), testProbes()),
    protectedSet: await protectedSetFor(roots, fakePolicyFilesystem()),
    network: 'deny',
  }, NEVER_CANCELLED);

export const keyFor = (runId: string, step: number, callId: string): string => sha256Hex(canonicalJson([runId, step, callId]));

export type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
