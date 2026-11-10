import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as foundation from '../../src/index.ts';
import { isProcessAlive } from '../../src/process-alive.ts';

const PLATFORM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform');

const sourcesOf = (dir: string): Array<[string, string]> => fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);

describe('the Windows group has one form: the job of the keeper', () => {
  it('keeps no synchronous runner and no private Windows probe timeout', () => {
    expect(Object.keys(foundation)).not.toContain('nodeSyncCommandRunner');
    expect(Object.keys(foundation)).not.toContain('WINDOWS_PROBE_TIMEOUT_MS');
    for (const [name, text] of sourcesOf(PLATFORM)) {
      expect({ name, sync: /execFileSync|nodeSyncCommandRunner|SyncCommandRunner|WINDOWS_PROBE_TIMEOUT_MS/.test(text) }).toEqual({ name, sync: false });
    }
  });

  it('keeps no parent walk, no process table and no taskkill', () => {
    for (const [name, text] of sourcesOf(PLATFORM)) {
      expect({ name, walk: /groupMembers|GroupLedger|groupOfPid|PROCESS_TABLE_SCRIPT|createWindowsGroupControl|TASKKILL_NOT_FOUND_EXIT_CODE|taskkill|ParentProcessId/.test(text) }).toEqual({ name, walk: false });
    }
  });

  it('keeps the exit codes and the name formats of the keeper in the process contract', () => {
    const contract = fs.readFileSync(path.join(PLATFORM, '..', 'process-contract.ts'), 'utf8');
    const client = fs.readFileSync(path.join(PLATFORM, 'windows-keeper.ts'), 'utf8');
    for (const name of ['KEEPER_EXIT_CODES', 'KEEPER_JOB_PREFIX', 'KEEPER_PIPE_PREFIX', 'KEEPER_NAME_BYTES']) {
      expect({ name, inContract: new RegExp(`export const ${name}\\b`).test(contract), inClient: new RegExp(`export const ${name}\\b`).test(client) }).toEqual({ name, inContract: true, inClient: false });
    }
  });

  it('isProcessAlive of a positive pid stays synchronous', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
