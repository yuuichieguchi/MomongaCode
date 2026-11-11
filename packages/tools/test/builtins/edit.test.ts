import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyFor } from '../helpers.ts';
import { catN, makeBuiltins, range, resultOf, sha256 } from './fixtures.ts';

const ACCEPT = { mode: 'acceptEdits' } as const;

describe('Edit', () => {
  it('replaces a unique match, shows a numbered snippet, and returns the hunks of the change with no file text beside them', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('e.txt', 'one\ntwo\nthree\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'two', new_string: 'TWO' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('one\nTWO\nthree\n');
    expect(result.output).toContain(catN(['one', 'TWO', 'three']));
    expect(result.content).toBeUndefined();
    expect(result).toMatchObject({ hunks: [{ oldStart: 1, newStart: 1, lines: [' one', '-two', '+TWO', ' three'] }], added: 1, removed: 1 });
    expect(tools.session.readLedger.get(file)).toEqual({ sha256: sha256('one\nTWO\nthree\n'), mtimeMs: fs.statSync(file).mtimeMs });
  });

  it('reports the edited file with the hash of the edited content as a structured fact', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('fact.txt', 'one\ntwo\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'two', new_string: 'TWO' }, ACCEPT));
    expect(result.files).toEqual([{ path: file, sha256: sha256('one\nTWO\n'), access: 'write' }]);
  });

  it('records path, preHash, postHash and the diff as the prepared state', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('p.txt', 'a\n');
    tools.markRead(file);
    resultOf(await tools.run('Edit', { file_path: file, old_string: 'a', new_string: 'b' }, ACCEPT));
    const begin = tools.idempotency.log.find((entry) => entry.op === 'begin');
    expect(begin?.op === 'begin' ? begin.meta : undefined).toEqual({ tool: 'Edit', runId: 'run-1', prepared: { path: file, preHash: sha256('a\n'), postHash: sha256('b\n'), diff: { hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }], added: 1, removed: 1 } }, facts: { files: [{ path: file, access: 'write' }] } });
  });

  it('limits the snippet to four lines of context around the edit', async () => {
    const tools = await makeBuiltins();
    const lines = range(1, 20).map((n) => `line${n}`);
    const file = tools.write('ctx.txt', `${lines.join('\n')}\n`);
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'line10', new_string: 'changed10' }, ACCEPT));
    expect(result.output).toContain(catN(['line6', 'line7', 'line8', 'line9', 'changed10', 'line11', 'line12', 'line13', 'line14'], 6));
    expect(result.output).not.toMatch(/^ {5}5\t/m);
    expect(result.output).not.toMatch(/^ {4}15\t/m);
  });

  it('inserts the replacement literally without expanding replacement patterns', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('lit.txt', 'price = X\n');
    tools.markRead(file);
    resultOf(await tools.run('Edit', { file_path: file, old_string: 'X', new_string: "$& $1 $$ $'" }, ACCEPT));
    expect(fs.readFileSync(file, 'utf8')).toBe("price = $& $1 $$ $'\n");
  });

  it('requires the file to have been read first', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('unread.txt', 'a\n');
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a', new_string: 'b' }, ACCEPT));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/Read/);
    expect(fs.readFileSync(file, 'utf8')).toBe('a\n');
  });

  it('refuses when the file changed since it was read', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('moved.txt', 'a\n');
    tools.markRead(file);
    fs.writeFileSync(file, 'a\nb\n');
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a', new_string: 'z' }, ACCEPT));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/changed/);
    expect(fs.readFileSync(file, 'utf8')).toBe('a\nb\n');
  });

  it('allows a second edit without rereading because the edit refreshed the ledger', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('chain.txt', 'a b\n');
    tools.markRead(file);
    resultOf(await tools.run('Edit', { file_path: file, old_string: 'a', new_string: 'x' }, ACCEPT));
    const second = resultOf(await tools.run('Edit', { file_path: file, old_string: 'b', new_string: 'y' }, ACCEPT));
    expect(second.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('x y\n');
  });

  it('rejects an empty old_string and points to Write', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('x.txt', 'a\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: '', new_string: 'b' }, ACCEPT));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/Write/);
    expect(fs.readFileSync(file, 'utf8')).toBe('a\n');
  });

  it('rejects identical old_string and new_string', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('x.txt', 'a\n');
    tools.markRead(file);
    const before = fs.statSync(file).mtimeMs;
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a', new_string: 'a' }, ACCEPT));
    expect(result.status).toBe('failed');
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('reports a missing match with a whitespace and indentation hint', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('x.txt', '  indented\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: '\tindented', new_string: 'b' }, ACCEPT));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/not found/i);
    expect(result.output).toMatch(/whitespace/i);
    expect(result.output).toMatch(/indentation/i);
  });

  it('reports multiple matches without replace_all', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('dup.txt', 'foo\nbar\nfoo\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'foo', new_string: 'baz' }, ACCEPT));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('found 2 matches; add surrounding context to make old_string unique or set replace_all');
    expect(fs.readFileSync(file, 'utf8')).toBe('foo\nbar\nfoo\n');
  });

  it('replaces every match with replace_all', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('dup.txt', 'foo\nbar\nfoo\nfoofoo\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'foo', new_string: 'baz', replace_all: true }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('baz\nbar\nbaz\nbazbaz\n');
  });

  it('retries with CRLF line endings when the file uses CRLF', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('crlf.txt', 'a\r\nb\r\nc\r\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a\nb', new_string: 'x\ny' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('x\r\ny\r\nc\r\n');
  });

  it('refuses a binary file', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('blob.bin', Buffer.from([97, 0, 98]));
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a', new_string: 'z' }, ACCEPT));
    expect(result.status).toBe('failed');
    expect(fs.readFileSync(file)).toEqual(Buffer.from([97, 0, 98]));
  });

  it('preserves the file mode', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('run.sh', 'echo a\n');
    fs.chmodSync(file, 0o750);
    tools.markRead(file);
    resultOf(await tools.run('Edit', { file_path: file, old_string: 'a', new_string: 'b' }, ACCEPT));
    expect(fs.statSync(file).mode & 0o777).toBe(0o750);
    expect(fs.readdirSync(tools.layout.project)).toEqual(['run.sh']);
  });

  it('edits the resolved target of a symlink', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('real.txt', 'hello\n');
    const link = path.join(tools.layout.project, 'alias.txt');
    fs.symlinkSync(target, link);
    tools.markRead(target);
    const result = resultOf(await tools.run('Edit', { file_path: link, old_string: 'hello', new_string: 'bye' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('bye\n');
  });

  it('resolves a relative path against the working directory', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('x.txt', 'a\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(result.output.split('\n')[0]).toBe('The file x.txt has been updated. Here is the result of running cat -n on a snippet of the edited file:');
    expect(fs.readFileSync(file, 'utf8')).toBe('b\n');
  });

  describe('reconcile of an interrupted edit', () => {
    const OLD = 'value = 1\n';
    const NEW = 'value = 2\n';

    it.each([
      ['already_applied', NEW, 'completed', NEW],
      ['not_applied', OLD, 'completed', NEW],
      ['unknown', 'value = 3\n', 'failed', 'value = 3\n'],
    ] as const)('reports %s from the current file hash', async (reconciled, current, status, after) => {
      const tools = await makeBuiltins();
      const file = tools.write('cfg.txt', current);
      const callId = `edit-${reconciled}`;
      tools.idempotency.seed(keyFor('run-1', 1, callId), 'PENDING', {
        tool: 'Edit',
        prepared: { path: file, preHash: sha256(OLD), postHash: sha256(NEW) },
      });
      const outcome = await tools.run('Edit', { file_path: file, old_string: '1', new_string: '2' }, ACCEPT, undefined, callId);
      expect(outcome).toMatchObject({ kind: 'result', reconciled, result: { status } });
      expect(fs.readFileSync(file, 'utf8')).toBe(after);
    });
  });
});
