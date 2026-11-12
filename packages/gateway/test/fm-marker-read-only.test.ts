import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readMarkerGroup } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, testProcessInspector, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { createGroupSpawn } from '../src/managed/fm-processes.ts';
import { registerCleanup } from './gateway-helpers.ts';
import { MINIMAL_PATH, makeHome, until } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const WRITE_THROUGH_MARKER = [
  "const fs = require('node:fs');",
  "let outcome = 'written';",
  "try { fs.writeSync(3, 'g0000000001\\n', 0); } catch (error) { outcome = error.code; }",
  'fs.writeFileSync(process.argv[1], outcome);',
].join(' ');

describe('the marker descriptor the managed group spawn hands to its child, whose marker holds the attempt record of decision 12', () => {
  it('is read-only: the child writing through fd 3 gets EBADF', async () => {
    const dir = makeHome();
    const markers = path.join(dir, 'markers');
    fs.mkdirSync(markers, { mode: 0o700 });
    const outcomeFile = path.join(dir, 'outcome');
    await createGroupSpawn({ inspector: testProcessInspector(), env: { PATH: MINIMAL_PATH, HOME: dir, TMPDIR: dir }, markerDirectory: markers, onWarning: () => undefined })(process.execPath, ['-e', WRITE_THROUGH_MARKER, outcomeFile], TEST_UNPROTECTED_LAUNCH.protection);
    const [marker] = fs.readdirSync(markers);
    const markerFile = path.join(markers, marker ?? '');
    await until(() => fs.readFileSync(markerFile, 'utf8').includes('\ng'), 'the group line of the attempt record');
    const pid = (await readMarkerGroup(markerFile)) ?? 0;
    expect(pid).toBeGreaterThan(1);
    registerCleanup(() => killGroupsForCleanup([pid]));
    await until(() => fs.existsSync(outcomeFile) && fs.readFileSync(outcomeFile, 'utf8') !== '', 'the child to report its write');
    expect(fs.readFileSync(outcomeFile, 'utf8')).toBe('EBADF');
    expect(fs.readFileSync(markerFile, 'utf8')).toBe(`r00000\ng${String(pid).padStart(10, '0')}\n`);
  });
});
