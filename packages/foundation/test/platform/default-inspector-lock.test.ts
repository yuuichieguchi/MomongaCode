import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '@momonga/testkit';
import { resolveLayoutLocks } from '../../src/platform/lock-capability.ts';
import { layoutProcessInspector } from '../../src/platform/process-inspector.ts';
import { createMarker } from '../../src/platform/marker-file.ts';
import { ensureMomongaDirs, momongaLayout } from '../../src/momonga-paths.ts';

const children: Array<ReturnType<typeof spawn>> = [];
const homes: string[] = [];

const makeSocketBindableHome = (): string => {
  const home = createTempDir({ asHome: true });
  homes.push(home);
  return home;
};

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const home of homes.splice(0)) await removeTempDir(home);
});

describe.runIf(process.platform === 'darwin')('F: the inspector of a layout carries the lock capability of that layout', () => {
  it('on a proved marker directory it answers from the lock: a process holding the file without the lock is not a holder', async () => {
    const paths = momongaLayout(makeSocketBindableHome(), process.platform, {}) as ReturnType<typeof momongaLayout> & { lockProof: string };
    await ensureMomongaDirs(paths);
    const { capability } = resolveLayoutLocks(paths);
    expect(await capability.of(paths.markers.tools)).toBe('proved');
    const marker = path.join(paths.markers.tools, 'call');
    (await createMarker(marker, { capability })).close();
    const plain = fs.openSync(marker, 'r');
    const child = spawn('/bin/sleep', ['30'], { stdio: ['ignore', 'ignore', 'ignore', plain] });
    children.push(child);
    fs.closeSync(plain);
    await new Promise((resolve) => child.once('spawn', resolve));
    expect(await layoutProcessInspector(capability).markerState(marker, { signal: new AbortController().signal })).toBe('free');
  });
});
