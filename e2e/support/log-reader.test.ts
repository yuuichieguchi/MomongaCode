import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { readLog, supervisorLog, supervisorPidsOf } from './log-reader.ts';

const line = (pid: number, msg: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', level: 'info', service: 'supervisor', pid, msg, ...extra })}\n`;

describe('readLog', () => {
  it('returns no records for a file that does not exist yet', (context) => {
    const dir = withTempDir(context);
    expect(readLog(path.join(dir, 'supervisor.log'))).toEqual([]);
  });

  it('ignores a half-written last line', (context) => {
    const file = path.join(withTempDir(context), 'supervisor.log');
    fs.writeFileSync(file, `${line(10, 'a')}${line(10, 'b')}{"ts":"2026-01-01T00:00:00.000Z","lev`);
    expect(readLog(file).map((record) => record.msg)).toEqual(['a', 'b']);
  });

  it('throws on a complete line that is not JSON', (context) => {
    const file = path.join(withTempDir(context), 'supervisor.log');
    fs.writeFileSync(file, `${line(10, 'a')}not json\n`);
    expect(() => readLog(file)).toThrow(/JSON/);
  });
});

describe('supervisorLog', () => {
  it('keeps only the records of one supervisor, rotated file first', (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    fs.mkdirSync(path.dirname(paths.logFiles.supervisor), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${paths.logFiles.supervisor}.1`, `${line(100, 'child.spawn', { child: 'runtime' })}${line(200, 'orphans.waiting')}`);
    fs.writeFileSync(paths.logFiles.supervisor, `${line(100, 'child.exit')}${line(200, 'orphans.reaped')}${line(200, 'child.spawn', { child: 'gateway' })}`);
    expect(supervisorLog(paths, 200).map((record) => record.msg)).toEqual(['orphans.waiting', 'orphans.reaped', 'child.spawn']);
    expect(supervisorLog(paths, 100).map((record) => record.msg)).toEqual(['child.spawn', 'child.exit']);
    expect(supervisorLog(paths, 300)).toEqual([]);
  });

  it('returns no records before any log exists', (context) => {
    const home = withTempDir(context, { asHome: true });
    expect(supervisorLog(momongaPaths(home, process.platform, process.env), 1)).toEqual([]);
  });
});

describe('supervisorPidsOf', () => {
  it('lists every supervisor that ever wrote to the log of the home, so a second supervisor beside the one asked is seen', (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    fs.mkdirSync(path.dirname(paths.logFiles.supervisor), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${paths.logFiles.supervisor}.1`, `${line(100, 'child.spawn', { child: 'runtime' })}`);
    fs.writeFileSync(paths.logFiles.supervisor, `${line(100, 'child.exit')}${line(200, 'child.spawn', { child: 'gateway' })}`);
    expect(supervisorPidsOf(paths)).toEqual([100, 200]);
  });
});
