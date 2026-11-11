import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { probeKeyOf } from '@momonga/config';
import type { KnownProbeKey } from '@momonga/config';
import { managedCurrencyOf, saveProbeRecord } from '@momonga/gateway';
import type { ManagedServer, ManagedTargetOptions } from '@momonga/gateway';
import { FM_SERVER, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Probing, ProbeReport } from '@momonga/protocol';
import { FAKE_OS_BUILD, testKernelLock } from '@momonga/testkit';
import { makeReport } from './report-fixture.ts';

export const FM_CURRENCY = managedCurrencyOf(FM_SERVER, { userDialects: {} });

export type StartProbe = (key: KnownProbeKey) => Promise<Probing>;

export const FAKE_FM_LISTED_MODEL = 'system';

export const fmRecordKey = (binarySha256: string, osBuild: string = FAKE_OS_BUILD, model: string = FAKE_FM_LISTED_MODEL): KnownProbeKey => {
  const key = probeKeyOf({
    subject: FM_SERVER.id,
    identity: FM_SERVER.identity,
    readings: { binarySha256: { kind: 'read', value: binarySha256 }, hostOsBuild: { kind: 'read', value: osBuild } },
    model,
  });
  if (key.kind !== 'known') throw new Error('a key built from read components is known');
  return key;
};

export const NO_AUTO_PROBE: StartProbe = async (key) => {
  throw new Error(`this test keeps a probe record and expects no automatic probe of ${key.canonical}`);
};

export const NO_PROBE_START = async (): Promise<Probing> => {
  throw new Error('this test keeps a probe record and expects no automatic probe');
};

export const probingAnswer = (): Probing => ({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 });

export const IDLE_AUTO_PROBE: StartProbe = async () => probingAnswer();

export const recordKeyOptions = (key: KnownProbeKey, startProbe: StartProbe = NO_AUTO_PROBE) => ({ readKey: async () => key, startProbe });

export const idleServer: ManagedServer = {
  restarts: 0,
  start: async () => ({ kind: 'unix', path: '/unused.sock' }),
  ensureRunning: async () => ({ kind: 'unix', path: '/unused.sock' }),
  stop: async () => undefined,
  health: async () => ({ ok: true }),
};

export const fmTargetBase = (target = 'fm'): Omit<ManagedTargetOptions, 'server' | 'exec' | 'binary' | 'probeRecordDir' | 'readKey' | 'startProbe' | 'toolCallingSetting'> => ({
  description: FM_SERVER,
  target,
  requestLimitMs: 300_000,
  isUsableBinary: async () => true,
  onInstanceEnd: () => undefined,
  instanceProbe: () => {
    throw new Error('this test reads every probe key component, so no instance probe runs');
  },
  currency: FM_CURRENCY,
});

export const primed = async <Managed extends { capabilities: (target: { name: string; display: string; model: string }) => Promise<unknown> }>(managed: Promise<Managed>, target: string): Promise<Managed> => {
  const ready = await managed;
  await ready.capabilities({ name: target, display: target, model: target });
  return ready;
};

export const saveFakeFmRecord = async (home: string, binaryPath: string, report: ProbeReport = makeReport(1, 1), model: string = FAKE_FM_LISTED_MODEL): Promise<void> => {
  const key = fmRecordKey(createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'), FAKE_OS_BUILD, model);
  await saveProbeRecord(path.join(home, '.momonga', 'state', 'probe'), key, report, FM_CURRENCY, testKernelLock());
};

type Connection = Record<string, unknown> & { models?: Array<Record<string, unknown>> };

type SettingsTree = { models?: { connections?: Connection[] } } & Record<string, unknown>;

const isFmConnection = (connection: Connection): boolean => connection['adapter'] === 'managed' && connection['server'] === FM_SERVER.id;

const fmConnectionsOf = (settings: unknown): Connection[] => ((settings as SettingsTree).models?.connections ?? []).filter(isFmConnection);

export const withFakeBinary = <Settings>(settings: Settings, binaryPath: string): Settings => {
  const tree = settings as SettingsTree;
  const connections = tree.models?.connections;
  if (connections === undefined) return settings;
  const placed = connections.map((connection) => (isFmConnection(connection) && connection['binary'] === undefined ? { ...connection, binary: binaryPath } : connection));
  return { ...tree, models: { ...tree.models, connections: placed } } as Settings;
};

export const saveFakeFmRecordsFor = async (home: string, settings: unknown, binaryPath: string, report: ProbeReport = makeReport(1, 1)): Promise<void> => {
  const models = new Set(fmConnectionsOf(settings).flatMap((connection) => (connection.models ?? []).map((entry) => (typeof entry['id'] === 'string' ? entry['id'] : undefined))));
  for (const model of models) await saveFakeFmRecord(home, binaryPath, report, model);
};

export const placeFakeFm = async (home: string, binaryPath: string, report: ProbeReport = makeReport(1, 1)): Promise<void> => {
  const file = path.join(home, '.momonga', 'settings.json');
  const settings: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const placed = withFakeBinary(settings, binaryPath);
  fs.writeFileSync(file, JSON.stringify(placed), { mode: 0o600 });
  await saveFakeFmRecordsFor(home, placed, binaryPath, report);
};

export const FM_PROBE_ROUTES = { readyPath: FM_SERVER.ready.path, listPath: FM_SERVER.models.listPath, idPath: FM_SERVER.models.idPath };
