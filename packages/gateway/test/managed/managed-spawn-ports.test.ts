import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { nodeFileSystemSync, systemRandom } from '@momonga/foundation';
import type { FileSystemSync, Random } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_UNPROTECTED_LAUNCH, createTempDir, testProcessInspector } from '@momonga/testkit';
import { createGroupSpawn } from '../../src/managed/processes.ts';
import { MINIMAL_PATH } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MARKER_ID = 'fixed-marker-id';
const STAY_ALIVE = 'setInterval(() => undefined, 1000);';
const REAP_GRACE_MS = 200;

describe('the managed server spawn takes the random and file ports it is given', () => {
  it('names its marker with the random port and creates the marker through the file port', async () => {
    const folder = createTempDir();
    const markerDirectory = path.join(folder, 'markers');
    fs.mkdirSync(markerDirectory);
    const opened: string[] = [];
    const fileSystem: FileSystemSync = {
      ...nodeFileSystemSync,
      openSync: (file, flags, mode) => {
        opened.push(file);
        return nodeFileSystemSync.openSync(file, flags, mode);
      },
    };
    const random: Random = { ...systemRandom, uuid: () => MARKER_ID };
    const child = await createGroupSpawn({ env: { PATH: MINIMAL_PATH }, markerDirectory, onWarning: () => undefined, inspector: testProcessInspector(), random, fileSystem })(process.execPath, ['-e', STAY_ALIVE], TEST_UNPROTECTED_LAUNCH.protection);
    try {
      expect(opened).toEqual([path.join(markerDirectory, MARKER_ID)]);
      expect(fs.readdirSync(markerDirectory)).toEqual([MARKER_ID]);
    } finally {
      await child.kill('SIGKILL');
      await child.finalize?.(REAP_GRACE_MS);
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
