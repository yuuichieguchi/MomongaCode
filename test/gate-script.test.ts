import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from '@momonga/testkit/child-process';
import { createTempDir, removeTempDir } from '@momonga/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '..');
const GATE = path.join(REPO, 'scripts', 'gate.ts');

let root = '';
let head = '';

const git = (args: readonly string[]): string =>
  execFileSync('git', ['-c', 'user.name=gate test', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();

const recordPath = (): string => path.join(root, '.git', 'momonga-gate.json');

const gate = (args: readonly string[]) => {
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

beforeEach(() => {
  root = createTempDir();
  git(['init', '-q']);
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
  git(['add', 'file.txt']);
  git(['commit', '-q', '-m', 'one']);
  head = git(['rev-parse', 'HEAD']);
});

afterEach(async () => {
  await removeTempDir(root);
});

describe('scripts/gate.ts', () => {
  it('opens a gate on the current head with no whole runs', () => {
    expect(gate(['open']).status).toBe(0);
    const record: unknown = JSON.parse(fs.readFileSync(recordPath(), 'utf8'));
    expect(record).toMatchObject({ format: 'momonga-gate/1', head, wholeRuns: {} });
    const openedAt = (record as { openedAt: string }).openedAt;
    expect(new Date(openedAt).toISOString()).toBe(openedAt);
  });

  it('refuses to open a second gate, naming the open gate head, and keeps the record', () => {
    expect(gate(['open']).status).toBe(0);
    const before = fs.readFileSync(recordPath(), 'utf8');
    fs.writeFileSync(path.join(root, 'file.txt'), 'two\n');
    git(['commit', '-q', '-am', 'two']);
    const second = gate(['open']);
    expect(second.status).not.toBe(0);
    expect(second.output).toContain(head);
    expect(fs.readFileSync(recordPath(), 'utf8')).toBe(before);
  });

  it('shows the gate head, its opening time and each recorded whole run', () => {
    expect(gate(['open']).status).toBe(0);
    const record = JSON.parse(fs.readFileSync(recordPath(), 'utf8')) as { openedAt: string };
    const runHead = 'd'.repeat(40);
    fs.writeFileSync(recordPath(), JSON.stringify({ ...record, format: 'momonga-gate/1', head, wholeRuns: { unit: { head: runHead, startedAt: '2026-11-18T10:00:00.000Z' } } }));
    const status = gate(['status']);
    expect(status.status).toBe(0);
    expect(status.output).toContain(head);
    expect(status.output).toContain(record.openedAt);
    expect(status.output).toContain('unit');
    expect(status.output).toContain(runHead);
    expect(status.output).toContain('2026-11-18T10:00:00.000Z');
  });

  it('says no gate is open when there is no record', () => {
    const status = gate(['status']);
    expect(status.status).toBe(0);
    expect(status.output.toLowerCase()).toContain('no gate');
  });

  it('closes an open gate by removing its record', () => {
    expect(gate(['open']).status).toBe(0);
    expect(gate(['close']).status).toBe(0);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it('refuses to close when no gate is open', () => {
    const close = gate(['close']);
    expect(close.status).not.toBe(0);
    expect(close.output.toLowerCase()).toContain('no gate');
  });

  it('prints usage and exits 64 for an unknown argument or none', () => {
    for (const args of [['frobnicate'], []]) {
      const result = gate(args);
      expect(result.status).toBe(64);
      expect(result.output).toContain('usage: node scripts/gate.ts <open|status|close>');
    }
  });
});
