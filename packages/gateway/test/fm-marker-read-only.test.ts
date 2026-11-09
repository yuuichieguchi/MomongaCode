import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup } from '@momonga/testkit';
import { createGroupSpawn } from '../src/managed/fm-processes.ts';
import { registerCleanup } from './gateway-helpers.ts';
import { MINIMAL_PATH, makeHome, until } from './gateway-process-helpers.ts';

const WRITE_THROUGH_MARKER = [
  "const fs = require('node:fs');",
  "let outcome = 'written';",
  "try { fs.writeSync(3, 'g0000000001\\n', 0); } catch (error) { outcome = error.code; }",
  'fs.writeFileSync(process.argv[1], outcome);',
].join(' ');

describe('the marker descriptor the fm group spawn hands to its child', () => {
  it('is read-only: the child writing through fd 3 gets EBADF', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const dir = makeHome();
    const markers = path.join(dir, 'markers');
    fs.mkdirSync(markers, { mode: 0o700 });
    const outcomeFile = path.join(dir, 'outcome');
    createGroupSpawn({ env: { PATH: MINIMAL_PATH, HOME: dir, TMPDIR: dir }, markerDirectory: markers, onWarning: () => undefined })(process.execPath, ['-e', WRITE_THROUGH_MARKER, outcomeFile]);
    const [marker] = fs.readdirSync(markers);
    const pid = Number(fs.readFileSync(path.join(markers, marker ?? ''), 'utf8').trim());
    registerCleanup(() => killGroupsForCleanup([pid]));
    await until(() => fs.existsSync(outcomeFile) && fs.readFileSync(outcomeFile, 'utf8') !== '', 'the child to report its write');
    expect(fs.readFileSync(outcomeFile, 'utf8')).toBe('EBADF');
  });
});
