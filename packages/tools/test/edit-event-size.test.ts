import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ReconcileUndecidedError } from '../src/index.ts';
import { DIFF_FILE_TOO_LARGE, DIFF_HUNK_TEXT_MAX_BYTES, DIFF_TOO_LARGE } from '../src/builtins/applied-diff.ts';
import { keyFor } from './helpers.ts';
import { makeBuiltins, resultOf, sha256 } from './builtins/fixtures.ts';

const ACCEPT = { mode: 'acceptEdits' } as const;

const MEGABYTE = 1024 * 1024;

const LINE = 'line 0000000 holds a value that an edit may change\n';

const largeText = (): string => {
  const lines: string[] = [];
  for (let index = 0; lines.length * LINE.length < MEGABYTE; index += 1) lines.push(LINE.replace('0000000', String(index).padStart(7, '0')));
  return lines.join('');
};

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

const preparedOf = (tools: Awaited<ReturnType<typeof makeBuiltins>>): Record<string, unknown> => {
  const begin = tools.idempotency.log.find((entry) => entry.op === 'begin');
  if (begin?.op !== 'begin') throw new Error('the call began no idempotency record');
  return begin.meta['prepared'] as Record<string, unknown>;
};

describe('what an edit or a write leaves on its event', () => {
  it('carries the change of a 1 MB file as hunks of the changed region, never the old or the new text', async () => {
    const tools = await makeBuiltins();
    const text = largeText();
    const file = tools.write('large.txt', text);
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'line 0000500 holds', new_string: 'line 0000500 keeps' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(result.content).toBeUndefined();
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(result.hunks).toEqual([
      {
        oldStart: 498,
        newStart: 498,
        lines: [497, 498, 499].map((index) => ` ${LINE.replace('0000000', String(index).padStart(7, '0')).trimEnd()}`).concat(
          `-${LINE.replace('0000000', '0000500').trimEnd()}`,
          `+${LINE.replace('0000000', '0000500').replace('holds', 'keeps').trimEnd()}`,
          [501, 502, 503].map((index) => ` ${LINE.replace('0000000', String(index).padStart(7, '0')).trimEnd()}`),
        ),
      },
    ]);
    expect(bytesOf(result)).toBeLessThan(4 * 1024);
  });

  it('bounds the event of an edit that changes every line of a 1 MB file', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('every.txt', largeText());
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'holds', new_string: 'keeps', replace_all: true }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(result.content).toBeUndefined();
    expect(result.diffOmitted).toBe(DIFF_TOO_LARGE);
    expect(bytesOf(result)).toBeLessThan(2 * DIFF_HUNK_TEXT_MAX_BYTES);
  });

  it('carries no text of a write over a 1 MB file', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('over.txt', largeText());
    tools.markRead(file);
    const result = resultOf(await tools.run('Write', { file_path: file, content: largeText().replaceAll('holds', 'keeps') }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(result.content).toBeUndefined();
    expect(result.hunks).toBeUndefined();
    expect(result.diffOmitted).toBe(DIFF_FILE_TOO_LARGE);
    expect(bytesOf(result)).toBeLessThan(2 * 1024);
  });

  it('carries the change of a small write as hunks and no content', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('small.txt', 'keep\nold\nend\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'keep\nnew\nend\n' }, ACCEPT));
    expect(result.content).toBeUndefined();
    expect(result).toMatchObject({ hunks: [{ oldStart: 1, newStart: 1, lines: [' keep', '-old', '+new', ' end'] }], added: 1, removed: 1 });
  });
});

describe('the change of an interrupted edit or write', () => {
  it('is recorded with the prepared state before the file is touched', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('p.txt', 'a\nb\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'b', new_string: 'c' }, ACCEPT));
    const diff = { hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+c'] }], added: 1, removed: 1 };
    expect(preparedOf(tools)).toEqual({ path: file, preHash: sha256('a\nb\n'), postHash: sha256('a\nc\n'), diff });
    expect(result).toMatchObject(diff);
  });

  it('is recorded for a write as well', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('w.txt', 'old\n');
    tools.markRead(file);
    resultOf(await tools.run('Write', { file_path: file, content: 'new\n' }, ACCEPT));
    expect(preparedOf(tools)).toEqual({ path: file, preHash: sha256('old\n'), postHash: sha256('new\n'), diff: { hunks: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }], added: 1, removed: 1 } });
  });

  it.each(['Edit', 'Write'] as const)('reaches the settled result of an %s that had already been applied', async (name) => {
    const tools = await makeBuiltins();
    const file = tools.write('r.txt', 'value = 2\n');
    const diff = { hunks: [{ oldStart: 1, newStart: 1, lines: ['-value = 1', '+value = 2'] }], added: 1, removed: 1 };
    tools.idempotency.seed(keyFor('run-1', 1, 'call-applied'), 'PENDING', { tool: name, prepared: { path: file, preHash: sha256('value = 1\n'), postHash: sha256('value = 2\n'), diff } });
    const input = name === 'Edit' ? { file_path: file, old_string: '1', new_string: '2' } : { file_path: file, content: 'value = 2\n' };
    const outcome = await tools.run(name, input, ACCEPT, undefined, 'call-applied');
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied', result: { status: 'completed', ...diff } });
    expect(resultOf(outcome).content).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('value = 2\n');
  });

  it('carries the omission of a diff the same way', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('r.txt', 'new');
    tools.idempotency.seed(keyFor('run-1', 1, 'call-omitted'), 'PENDING', { tool: 'Write', prepared: { path: file, preHash: sha256('old'), postHash: sha256('new'), diff: { diffOmitted: DIFF_FILE_TOO_LARGE } } });
    const outcome = await tools.run('Write', { file_path: file, content: 'new' }, ACCEPT, undefined, 'call-omitted');
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied', result: { diffOmitted: DIFF_FILE_TOO_LARGE } });
    expect(resultOf(outcome).hunks).toBeUndefined();
  });

  it('settles with no diff when the file holds neither state', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('r.txt', 'value = 3\n');
    const diff = { hunks: [{ oldStart: 1, newStart: 1, lines: ['-value = 1', '+value = 2'] }], added: 1, removed: 1 };
    tools.idempotency.seed(keyFor('run-1', 1, 'call-unknown'), 'PENDING', { tool: 'Edit', prepared: { path: file, preHash: sha256('value = 1\n'), postHash: sha256('value = 2\n'), diff } });
    const outcome = await tools.run('Edit', { file_path: file, old_string: '1', new_string: '2' }, ACCEPT, undefined, 'call-unknown');
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
    expect(resultOf(outcome).hunks).toBeUndefined();
  });

  it('refuses a prepared state whose diff is not a diff: the reconcile cannot decide, so the run cannot go on and the record is kept for the next attempt', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('r.txt', 'new');
    const key = keyFor('run-1', 1, 'call-bad');
    tools.idempotency.seed(key, 'PENDING', { tool: 'Write', prepared: { path: file, preHash: sha256('old'), postHash: sha256('new'), diff: { hunks: 'everything' } } });
    const outcome = tools.run('Write', { file_path: file, content: 'new' }, ACCEPT, undefined, 'call-bad');
    await expect(outcome).rejects.toBeInstanceOf(ReconcileUndecidedError);
    await expect(outcome).rejects.toThrow('prepared state is malformed: its diff is not a diff');
    expect(tools.idempotency.stateOf(key)).toBe('PENDING');
  });
});
