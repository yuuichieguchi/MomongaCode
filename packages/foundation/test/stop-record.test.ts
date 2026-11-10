import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, generationLayout, generationMemberOf, readStopRecord, writeStopRecord } from '@momonga/foundation';
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

  it('is named stop-values.json, beside the sockets and the locks of the generation (design 4.3a)', () => {
    const layout = generationLayout('/Users/alice', 3, 'darwin');
    expect(layout.stopRecord).toBe('/Users/alice/.momonga/run/g3/stop-values.json');
  });

  it('is a known entry of the generation directory, with the staged names of its atomic write (update design 14.15)', () => {
    expect(generationMemberOf('stop-values.json')).toEqual({ name: 'stop-values.json', kind: 'file', removal: 'always', hasAtomicTemporaries: true });
    expect(generationMemberOf('.stop-values.json.0a1b2c3d.tmp')?.name).toBe('stop-values.json');
  });

  it('is one line of JSON holding the generation and the four values, mode 0600, with no temporary file left beside it', async (context) => {
    const home = homeWithGeneration(context, 3);
    const layout = generationLayout(home, 3);
    await writeStopRecord(layout.stopRecord, 3, VALUES);
    const text = fs.readFileSync(layout.stopRecord, 'utf8');
    expect(text.trimEnd()).toBe('{"generation":3,"values":{"closeGraceMs":1200,"managedServerStopGraceMs":300,"drainTimeoutMs":4500,"mcpCloseGraceMs":60}}');
    expect(text.trimEnd().includes('\n')).toBe(false);
    expect(fs.statSync(layout.stopRecord).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(layout.dir)).toEqual(['stop-values.json']);
  });

  it('round-trips the four values its stop read', async (context) => {
    const home = homeWithGeneration(context, 1);
    const layout = generationLayout(home, 1);
    await writeStopRecord(layout.stopRecord, 1, VALUES);
    expect(await readStopRecord(layout.stopRecord)).toEqual(VALUES);
  });

  it('a later write of the same stop record replaces the earlier values', async (context) => {
    const home = homeWithGeneration(context, 1);
    const layout = generationLayout(home, 1);
    await writeStopRecord(layout.stopRecord, 1, VALUES);
    await writeStopRecord(layout.stopRecord, 1, DEFAULT_STOP_VALUES);
    expect(await readStopRecord(layout.stopRecord)).toEqual(DEFAULT_STOP_VALUES);
  });

  it('reads as unknown when the record is missing, as after the leftover cleanup removed the directory', async (context) => {
    const home = withTempDir(context);
    expect(await readStopRecord(generationLayout(home, 2).stopRecord)).toBeUndefined();
  });

  it.for([
    ['not JSON', 'stop'],
    ['an empty file', ''],
    ['two values only', JSON.stringify({ generation: 1, values: { closeGraceMs: 1, managedServerStopGraceMs: 1 } })],
    ['a drain over the maximum', JSON.stringify({ generation: 1, values: { ...VALUES, drainTimeoutMs: 300_001 } })],
    ['an MCP grace over the maximum', JSON.stringify({ generation: 1, values: { ...VALUES, mcpCloseGraceMs: 30_001 } })],
    ['a fraction', JSON.stringify({ generation: 1, values: { ...VALUES, closeGraceMs: 0.5 } })],
    ['the values without the generation', JSON.stringify(VALUES)],
    ['a field beside the generation and the values', JSON.stringify({ generation: 1, values: VALUES, extra: 1 })],
    ['an array', '[]'],
  ] as const)('reads as unknown when the record is invalid: %s', async ([, text], context) => {
    const home = homeWithGeneration(context, 1);
    const layout = generationLayout(home, 1);
    fs.writeFileSync(layout.stopRecord, text);
    expect(await readStopRecord(layout.stopRecord)).toBeUndefined();
  });
});
