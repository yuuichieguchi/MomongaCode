import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFiles } from '../src/node-ports.ts';
import { copyProbeRecord } from '../src/eval/context-effects.ts';

const directories: string[] = [];

const temporary = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-probe-test-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('copyProbeRecord', () => {
  const record = JSON.stringify({ binarySha256: 'a'.repeat(64), osBuild: '25A1', report: { anything: true } });

  it('copies the record of a target byte for byte, keyed by the same name', async () => {
    const from = temporary();
    const to = path.join(temporary(), 'state', 'probe');
    fs.writeFileSync(path.join(from, 'system.json'), record);
    expect(await copyProbeRecord(nodeFiles, from, to, 'system')).toBe(true);
    expect(fs.readFileSync(path.join(to, 'system.json'), 'utf8')).toBe(record);
    expect(fs.statSync(path.join(to, 'system.json')).mode & 0o777).toBe(0o600);
  });

  it('copies nothing when the person never probed the target, so the case sees the same answer', async () => {
    const from = temporary();
    const to = path.join(temporary(), 'probe');
    expect(await copyProbeRecord(nodeFiles, from, to, 'system')).toBe(false);
    expect(fs.existsSync(to)).toBe(false);
  });
});
