import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { saveProbeRecord } from '@momonga/gateway';
import type { AutoProbe, ProbeRecordKey } from '@momonga/gateway';
import type { ProbeReport } from '@momonga/protocol';
import { FAKE_OS_BUILD } from '@momonga/testkit';
import { makeReport } from './report-fixture.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';

export const NO_AUTO_PROBE: AutoProbe = {
  start: async (key) => {
    throw new Error(`this test keeps a probe record and expects no automatic probe of ${key.target}`);
  },
  close: async () => undefined,
};

export const IDLE_AUTO_PROBE: AutoProbe = { start: async () => undefined, close: async () => undefined };

export const recordKeyOptions = (key: ProbeRecordKey, autoProbe: AutoProbe = NO_AUTO_PROBE) => ({ target: key.target, readRecordKey: async () => key, autoProbe });

export const primed = async <Managed extends { capabilities: (target: { name: string; model: string }) => Promise<unknown> }>(managed: Promise<Managed>, target: string): Promise<Managed> => {
  const ready = await managed;
  await ready.capabilities({ name: target, model: target });
  return ready;
};

export const saveFakeFmRecord = async (home: string, target: string, binaryPath: string, report: ProbeReport = makeReport(1, 1)): Promise<void> => {
  const key = { target, binarySha256: createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'), osBuild: FAKE_OS_BUILD };
  await saveProbeRecord(path.join(home, '.momonga', 'state', 'probe'), key, report, CURRENT_DIALECTS);
};
