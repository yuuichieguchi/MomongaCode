import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, generationLayout, readStopRecord, writeStopRecord } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';

const VALUES: StopValues = { closeGraceMs: 1200, managedServerStopGraceMs: 300, drainTimeoutMs: 4500, mcpCloseGraceMs: 60 };

const homeWithGeneration = (context: Parameters<typeof withTempDir>[0], generation: number): string => {
  const home = withTempDir(context);
  fs.mkdirSync(generationLayout(home, generation).dir, { recursive: true });
  return home;
};

describe('the stop record of a generation', () => {
  it('lives directly in the generation directory run/g<N>/', () => {
    const layout = generationLayout('/Users/alice', 3, 'darwin');
    expect(path.dirname(layout.stopRecord)).toBe('/Users/alice/.momonga/run/g3');
    expect(generationLayout('/Users/alice', 4, 'darwin').stopRecord).toBe(layout.stopRecord.replace('/g3/', '/g4/'));
  });

  it('round-trips the four values its stop read', async (context) => {
    const home = homeWithGeneration(context, 1);
    const layout = generationLayout(home, 1);
    await writeStopRecord(layout.stopRecord, VALUES);
    expect(await readStopRecord(layout.stopRecord)).toEqual(VALUES);
  });

  it('a later write of the same stop record replaces the earlier values', async (context) => {
    const home = homeWithGeneration(context, 1);
    const layout = generationLayout(home, 1);
    await writeStopRecord(layout.stopRecord, VALUES);
    await writeStopRecord(layout.stopRecord, DEFAULT_STOP_VALUES);
    expect(await readStopRecord(layout.stopRecord)).toEqual(DEFAULT_STOP_VALUES);
  });

  it('reads as unknown when the record is missing, as after the leftover cleanup removed the directory', async (context) => {
    const home = withTempDir(context);
    expect(await readStopRecord(generationLayout(home, 2).stopRecord)).toBeUndefined();
  });

  it.for([
    ['not JSON', 'stop'],
    ['an empty file', ''],
    ['two values only', JSON.stringify({ closeGraceMs: 1, managedServerStopGraceMs: 1 })],
    ['a drain over the maximum', JSON.stringify({ ...VALUES, drainTimeoutMs: 300_001 })],
    ['an MCP grace over the maximum', JSON.stringify({ ...VALUES, mcpCloseGraceMs: 30_001 })],
    ['a fraction', JSON.stringify({ ...VALUES, closeGraceMs: 0.5 })],
    ['an array', '[]'],
  ] as const)('reads as unknown when the record is invalid: %s', async ([, text], context) => {
    const home = homeWithGeneration(context, 1);
    const layout = generationLayout(home, 1);
    fs.writeFileSync(layout.stopRecord, text);
    expect(await readStopRecord(layout.stopRecord)).toBeUndefined();
  });
});
