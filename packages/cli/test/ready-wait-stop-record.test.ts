import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs, generationLayout, momongaPaths, publishCurrentGeneration, writeStopRecord } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { readyWaitBoundMs } from '../src/daemon/ensure-daemon.ts';

const PREDECESSOR: StopValues = { closeGraceMs: 1, managedServerStopGraceMs: 2, drainTimeoutMs: 7000, mcpCloseGraceMs: 40 };
const PREDECESSOR_READY_MS = (7000 + 5000 + 10_000 + 8 * 40 + 120) + (5000 + 10_000 + 8 * 40 + 120) + 60_000;
const READY_WAIT_WHEN_UNKNOWN_MS = 870_240;

const homeWithCurrent = async (context: TestContext, generation: number) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  const layout = generationLayout(home, generation);
  fs.mkdirSync(layout.dir, { recursive: true });
  await publishCurrentGeneration(paths, { generation, version: '1.0.0', sockets: layout.sockets });
  return { home, paths, layout };
};

describe('the ready wait for a new daemon covers its predecessor stop, read from the stop record', () => {
  it('waits requirementOfStop of the recorded values plus the start-up timeout', async (context) => {
    const { paths, layout } = await homeWithCurrent(context, 3);
    await writeStopRecord(layout.stopRecord, PREDECESSOR);
    expect(await readyWaitBoundMs(paths)).toBe(PREDECESSOR_READY_MS);
  });

  it('reads the record of the generation run/current names, not another generation', async (context) => {
    const { home, paths } = await homeWithCurrent(context, 3);
    fs.mkdirSync(generationLayout(home, 2).dir, { recursive: true });
    await writeStopRecord(generationLayout(home, 2).stopRecord, PREDECESSOR);
    expect(await readyWaitBoundMs(paths)).toBe(READY_WAIT_WHEN_UNKNOWN_MS);
  });

  it('waits the bound of the allowed maxima when the record is missing, as after the leftover cleanup', async (context) => {
    const { paths, layout } = await homeWithCurrent(context, 1);
    fs.rmSync(layout.dir, { recursive: true, force: true });
    expect(await readyWaitBoundMs(paths)).toBe(READY_WAIT_WHEN_UNKNOWN_MS);
  });

  it('waits the bound of the allowed maxima when the record is invalid', async (context) => {
    const { paths, layout } = await homeWithCurrent(context, 1);
    fs.writeFileSync(layout.stopRecord, JSON.stringify({ ...PREDECESSOR, drainTimeoutMs: 300_001 }));
    expect(await readyWaitBoundMs(paths)).toBe(READY_WAIT_WHEN_UNKNOWN_MS);
  });

  it('waits the bound of the allowed maxima when no generation is current', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    expect(await readyWaitBoundMs(paths)).toBe(READY_WAIT_WHEN_UNKNOWN_MS);
  });
});
