import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { LOG_KEEP, LOG_MAX_BYTES, createRotatingLogFile } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, spawnTracked, withTempDir } from '@momonga/testkit';

const APPEND = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'append-lines.ts');

const LINE_BYTES = 50;
const MAX_BYTES = 200;

const line = (tag: string): string => {
  const prefix = `{"tag":"${tag}","pad":"`;
  const suffix = '"}';
  return `${prefix}${'x'.repeat(LINE_BYTES - 1 - prefix.length - suffix.length)}${suffix}`;
};

const tagsIn = (file: string): string[] => {
  const text = fs.readFileSync(file, 'utf8');
  expect(text.endsWith('\n'), file).toBe(true);
  return text
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => (JSON.parse(entry) as { tag: string }).tag);
};

const sinkAt = (file: string, maxBytes = MAX_BYTES) => createRotatingLogFile({ path: file, maxBytes, keep: LOG_KEEP });

const writeTags = (sink: ReturnType<typeof sinkAt>, tags: readonly string[]): void => {
  for (const tag of tags) sink.write(line(tag));
};

const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, index) => `l${from + index}`);

describe('createRotatingLogFile', () => {
  it('pins LOG_MAX_BYTES and LOG_KEEP', () => {
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(LOG_KEEP).toBe(4);
  });

  it('rotates at the size limit', (context) => {
    expect(line('l1').length + 1).toBe(LINE_BYTES);
    const file = path.join(withTempDir(context), 'runtime.log');
    const sink = sinkAt(file);
    writeTags(sink, range(1, 10));
    sink.close();
    expect(tagsIn(file)).toEqual(range(9, 10));
    expect(tagsIn(`${file}.1`)).toEqual(range(5, 8));
    expect(tagsIn(`${file}.2`)).toEqual(range(1, 4));
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    for (const generation of [file, `${file}.1`, `${file}.2`]) expect(fs.statSync(generation).size).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('keeps LOG_KEEP generations', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const sink = sinkAt(file);
    writeTags(sink, range(1, 28));
    sink.close();
    expect(tagsIn(file)).toEqual(range(25, 28));
    expect(tagsIn(`${file}.1`)).toEqual(range(21, 24));
    expect(tagsIn(`${file}.2`)).toEqual(range(17, 20));
    expect(tagsIn(`${file}.3`)).toEqual(range(13, 16));
    expect(tagsIn(`${file}.4`)).toEqual(range(9, 12));
    expect(fs.existsSync(`${file}.5`)).toBe(false);
  });

  it('appends a newline only when the line lacks one', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const sink = sinkAt(file);
    sink.write(`${line('a')}\n`);
    sink.write(line('b'));
    sink.close();
    expect(fs.readFileSync(file, 'utf8')).toBe(`${line('a')}\n${line('b')}\n`);
  });

  it('reopens in append mode after a restart', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const first = sinkAt(file);
    writeTags(first, ['a1', 'a2', 'a3']);
    first.close();
    const second = sinkAt(file);
    writeTags(second, ['b1']);
    expect(tagsIn(file)).toEqual(['a1', 'a2', 'a3', 'b1']);
    writeTags(second, ['b2']);
    second.close();
    expect(tagsIn(`${file}.1`)).toEqual(['a1', 'a2', 'a3', 'b1']);
    expect(tagsIn(file)).toEqual(['b2']);
  });

  it('files are 0600 and the directory 0700', (context) => {
    const dir = path.join(withTempDir(context), 'logs');
    const file = path.join(dir, 'runtime.log');
    const sink = sinkAt(file);
    writeTags(sink, range(1, 5));
    sink.close();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600);
  });

  it('an oversize line is written whole into a fresh file', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const sink = sinkAt(file, 100);
    const big = JSON.stringify({ tag: 'big', pad: 'y'.repeat(300) });
    sink.write(line('small'));
    sink.write(big);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe(`${line('small')}\n`);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${big}\n`);
    sink.write(line('after'));
    sink.close();
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe(`${big}\n`);
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toBe(`${line('small')}\n`);
    expect(tagsIn(file)).toEqual(['after']);
  });

  it('inode check: an overlapping rotation is not repeated', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const a = sinkAt(file);
    const b = sinkAt(file);
    writeTags(a, ['a1', 'a2', 'a3', 'a4', 'a5']);
    writeTags(b, ['b1']);
    a.close();
    b.close();
    expect(tagsIn(`${file}.1`)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    expect(tagsIn(file)).toEqual(['a5', 'b1']);
  });

  it('a small write after another sink rotated lands in the current file', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const a = sinkAt(file);
    const b = sinkAt(file);
    writeTags(b, ['b0']);
    writeTags(a, ['a1', 'a2', 'a3', 'a4']);
    writeTags(b, ['b1']);
    a.close();
    b.close();
    expect(tagsIn(`${file}.1`)).toEqual(['b0', 'a1', 'a2', 'a3']);
    expect(tagsIn(file)).toEqual(['a4', 'b1']);
    expect(fs.existsSync(`${file}.2`)).toBe(false);
  });

  it('size is shared between writers', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const a = sinkAt(file);
    const b = sinkAt(file);
    writeTags(a, ['a1']);
    writeTags(b, ['b1']);
    writeTags(a, ['a2']);
    writeTags(b, ['b2']);
    writeTags(a, ['a3']);
    a.close();
    b.close();
    expect(tagsIn(`${file}.1`)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(tagsIn(file)).toEqual(['a3']);
  });

  it('the constructor throws when the file cannot be opened', (context) => {
    const dir = withTempDir(context);
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    expect(() => sinkAt(path.join(blocker, 'runtime.log'))).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(ENOTDIR|EEXIST)$/) }));
  });

  it('no method throws after construction, even when the directory disappears', (context) => {
    const dir = path.join(withTempDir(context), 'logs');
    const file = path.join(dir, 'runtime.log');
    const sink = sinkAt(file);
    writeTags(sink, ['a1']);
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, '');
    expect(() => writeTags(sink, ['a2'])).not.toThrow();
    expect(() => sink.close()).not.toThrow();
    expect(() => writeTags(sink, ['a3'])).not.toThrow();
  });

  it('a missing shift source is ignored', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    fs.writeFileSync(`${file}.1`, `${line('old1')}\n`, { mode: 0o600 });
    fs.writeFileSync(`${file}.3`, `${line('old3')}\n`, { mode: 0o600 });
    fs.writeFileSync(file, `${[1, 2, 3, 4].map((index) => line(`c${index}`)).join('\n')}\n`, { mode: 0o600 });
    const sink = sinkAt(file);
    expect(() => writeTags(sink, ['next'])).not.toThrow();
    sink.close();
    expect(tagsIn(file)).toEqual(['next']);
    expect(tagsIn(`${file}.1`)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(tagsIn(`${file}.2`)).toEqual(['old1']);
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    expect(tagsIn(`${file}.4`)).toEqual(['old3']);
  });

  it('a deleted file is recreated', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const sink = sinkAt(file);
    writeTags(sink, ['a1']);
    fs.unlinkSync(file);
    writeTags(sink, ['a2']);
    sink.close();
    expect(tagsIn(file)).toEqual(['a2']);
    expect(fs.existsSync(`${file}.1`)).toBe(false);
  });

  it('a short write is continued with the remainder', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    let shortened = false;
    const writeSync = ((fd: number, buffer: string | NodeJS.ArrayBufferView, ...rest: unknown[]): number => {
      const bytes =
        typeof buffer === 'string'
          ? Buffer.from(buffer, 'utf8')
          : Buffer.from(buffer.buffer, buffer.byteOffset + ((rest[0] as number | undefined) ?? 0), (rest[1] as number | undefined) ?? buffer.byteLength - ((rest[0] as number | undefined) ?? 0));
      const length = shortened ? bytes.length : Math.floor(bytes.length / 2);
      shortened = true;
      return fs.writeSync(fd, bytes, 0, length);
    }) as typeof fs.writeSync;
    const sink = createRotatingLogFile({ path: file, maxBytes: MAX_BYTES, keep: LOG_KEEP, writeSync });
    sink.write(line('whole'));
    sink.close();
    expect(fs.readFileSync(file, 'utf8')).toBe(`${line('whole')}\n`);
    expect(sink.droppedLines).toBe(0);
  });

  it('write failure counts a drop and reports', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    let failNext = true;
    const writeSync = ((...args: Parameters<typeof fs.writeSync>): number => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return (fs.writeSync as (...inner: unknown[]) => number)(...args);
    }) as typeof fs.writeSync;
    const onWriteFailure = vi.fn();
    const sink = createRotatingLogFile({ path: file, maxBytes: MAX_BYTES, keep: LOG_KEEP, writeSync, onWriteFailure });
    expect(() => sink.write(line('lost'))).not.toThrow();
    expect(sink.droppedLines).toBe(1);
    expect(onWriteFailure).toHaveBeenCalledTimes(1);
    expect((onWriteFailure.mock.calls[0]?.[0] as NodeJS.ErrnoException).code).toBe('ENOSPC');
    sink.write(line('kept'));
    expect(sink.droppedLines).toBe(1);
    expect(tagsIn(file)).toEqual(['kept']);
    sink.close();
  });

  it('writes after close are counted as dropped', (context) => {
    const file = path.join(withTempDir(context), 'runtime.log');
    const sink = sinkAt(file);
    writeTags(sink, ['a1']);
    sink.close();
    expect(() => writeTags(sink, ['a2'])).not.toThrow();
    expect(sink.droppedLines).toBe(1);
    expect(tagsIn(file)).toEqual(['a1']);
  });

  it('two real processes append without tearing', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async (context) => {
    const file = path.join(withTempDir(context), 'shared.log');
    const runs = ['p', 'q'].map((tag) => {
      const child = spawnTracked(context, process.execPath, [APPEND, file, tag, '2000'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      return new Promise<string>((resolve) => child.once('close', (code) => resolve(`${code}${code === 0 ? '' : `: ${stderr}`}`)));
    });
    expect(await Promise.all(runs)).toEqual(['0', '0']);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '');
    expect(lines).toHaveLength(4000);
    const seen = { p: new Set<number>(), q: new Set<number>() };
    for (const entry of lines) {
      const parsed = JSON.parse(entry) as { tag: 'p' | 'q'; index: number; pad: string };
      expect(parsed.pad).toBe(parsed.tag.repeat(1000));
      seen[parsed.tag].add(parsed.index);
    }
    expect(seen.p.size).toBe(2000);
    expect(seen.q.size).toBe(2000);
  });
});
