import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { protectedPathsFor } from '@momonga/tools';
import { keyFor } from '../helpers.ts';
import { approvalOf, makeBuiltins, resultOf, sha256 } from './fixtures.ts';

const entriesOf = (dir: string): string[] => fs.readdirSync(dir).sort();

describe('Write', () => {
  it('creates a new file and reports its line count and a diff without old text', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.project, 'new.txt');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'a\nb\nc' }, { mode: 'acceptEdits' }));
    expect(result).toMatchObject({ status: 'completed', output: `Created ${file} (3 lines)` });
    expect(result.content).toEqual([{ type: 'diff', path: file, oldText: null, newText: 'a\nb\nc' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('a\nb\nc');
    expect(tools.session.readLedger.get(file)).toEqual({ sha256: sha256('a\nb\nc'), mtimeMs: fs.statSync(file).mtimeMs });
  });

  it('records path, preHash and postHash as the prepared state', async () => {
    const tools = await makeBuiltins();
    const created = path.join(tools.layout.project, 'p.txt');
    resultOf(await tools.run('Write', { file_path: created, content: 'one' }, { mode: 'acceptEdits' }));
    resultOf(await tools.run('Write', { file_path: created, content: 'two' }, { mode: 'acceptEdits' }));
    const metas = tools.idempotency.log.flatMap((entry) => (entry.op === 'begin' ? [entry.meta] : []));
    expect(metas).toEqual([
      { tool: 'Write', prepared: { path: created, preHash: null, postHash: sha256('one') } },
      { tool: 'Write', prepared: { path: created, preHash: sha256('one'), postHash: sha256('two') } },
    ]);
  });

  it('creates missing parent directories', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.project, 'deep', 'er', 'file.txt');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'x' }, { mode: 'acceptEdits' }));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
  });

  it('refuses to overwrite an existing file that was never read', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('existing.txt', 'original');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'replaced' }, { mode: 'acceptEdits' }));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/Read/);
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
  });

  it('refuses to overwrite a file that changed since it was read', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('existing.txt', 'original');
    resultOf(await tools.run('Read', { file_path: file }));
    fs.writeFileSync(file, 'changed by someone else');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'replaced' }, { mode: 'acceptEdits' }));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/changed/);
    expect(fs.readFileSync(file, 'utf8')).toBe('changed by someone else');
  });

  it('overwrites a file after Read and reports the old text in the diff', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('existing.txt', 'old\n');
    resultOf(await tools.run('Read', { file_path: file }));
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'new 1\nnew 2' }, { mode: 'acceptEdits' }));
    expect(result).toMatchObject({ status: 'completed', output: `Updated ${file} (2 lines)` });
    expect(result.content).toEqual([{ type: 'diff', path: file, oldText: 'old\n', newText: 'new 1\nnew 2' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('new 1\nnew 2');
    expect(tools.session.readLedger.get(file)?.sha256).toBe(sha256('new 1\nnew 2'));
  });

  it('allows consecutive writes because each write refreshes the ledger', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.project, 'twice.txt');
    resultOf(await tools.run('Write', { file_path: file, content: 'first' }, { mode: 'acceptEdits' }));
    const second = resultOf(await tools.run('Write', { file_path: file, content: 'second' }, { mode: 'acceptEdits' }));
    expect(second.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
  });

  it.each([0o755, 0o600, 0o640])('preserves the existing file mode %o', async (mode) => {
    const tools = await makeBuiltins();
    const file = tools.write('script.sh', '#!/bin/sh\n');
    fs.chmodSync(file, mode);
    tools.markRead(file);
    resultOf(await tools.run('Write', { file_path: file, content: '#!/bin/sh\necho hi\n' }, { mode: 'acceptEdits' }));
    expect(fs.statSync(file).mode & 0o777).toBe(mode);
  });

  it('gives new files 0o666 masked by the umask', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.project, 'fresh.txt');
    resultOf(await tools.run('Write', { file_path: file, content: 'x' }, { mode: 'acceptEdits' }));
    const umask = process.umask();
    expect(fs.statSync(file).mode & 0o777).toBe(0o666 & ~umask);
  });

  it('replaces the file atomically and leaves no temporary files behind', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('atomic.txt', 'before');
    const inode = fs.statSync(file).ino;
    tools.markRead(file);
    resultOf(await tools.run('Write', { file_path: file, content: 'after' }, { mode: 'acceptEdits' }));
    expect(entriesOf(tools.layout.project)).toEqual(['atomic.txt']);
    expect(fs.statSync(file).ino).not.toBe(inode);
  });

  it('writes the resolved target when the path is a symlink', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('target.txt', 'before');
    const link = path.join(tools.layout.project, 'link.txt');
    fs.symlinkSync(target, link);
    resultOf(await tools.run('Read', { file_path: link }));
    const result = resultOf(await tools.run('Write', { file_path: link, content: 'after' }, { mode: 'acceptEdits' }));
    expect(result.status).toBe('completed');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe('after');
    expect(tools.session.readLedger.get(target)?.sha256).toBe(sha256('after'));
  });

  it('asks before writing through a workspace symlink that resolves outside the roots', async () => {
    const tools = await makeBuiltins();
    const outsideFile = path.join(tools.layout.outside, 'target.txt');
    fs.writeFileSync(outsideFile, 'outside');
    const link = path.join(tools.layout.project, 'escape.txt');
    fs.symlinkSync(outsideFile, link);
    const outcome = await tools.run('Write', { file_path: link, content: 'x' }, { mode: 'acceptEdits' });
    expect(approvalOf(outcome).toolKind).toBe('edit');
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside');
  });

  it('asks before writing a protected path without suggesting a rule', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.project, '.envrc');
    const outcome = approvalOf(
      await tools.run('Write', { file_path: file, content: 'export X=1' }, { mode: 'acceptEdits', protectedPaths: protectedPathsFor([tools.layout.project]) }),
    );
    expect(outcome.decision.source).toBe('protected');
    expect('suggestedRule' in outcome).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects a relative path', async () => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('Write', { file_path: 'x.txt', content: '' }, { mode: 'acceptEdits' }));
    expect(result).toMatchObject({ status: 'failed', output: 'file_path must be an absolute path' });
  });

  it('is denied inside a readDenied path even with approval in bypass mode', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.home, 'Library', 'Keychains', 'login.keychain');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'x' }, { mode: 'bypassPermissions' }, 'allow_once'));
    expect(result).toEqual({ status: 'failed', output: `Permission denied: ${file} is blocked by the sandbox policy` });
    expect(fs.existsSync(file)).toBe(false);
  });

  describe('reconcile of an interrupted write', () => {
    const seedInterrupted = (tools: Awaited<ReturnType<typeof makeBuiltins>>, callId: string, prepared: Record<string, unknown>): string => {
      const key = keyFor('run-1', 1, callId);
      tools.idempotency.seed(key, 'PENDING', { tool: 'Write', prepared });
      return key;
    };

    it('reports already_applied when the file already holds the new content', async () => {
      const tools = await makeBuiltins();
      const file = tools.write('r.txt', 'new');
      seedInterrupted(tools, 'r1', { path: file, preHash: sha256('old'), postHash: sha256('new') });
      const outcome = await tools.run('Write', { file_path: file, content: 'new' }, { mode: 'acceptEdits' }, undefined, 'r1');
      expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied', result: { status: 'completed' } });
      expect(resultOf(outcome).output).not.toMatch(/^(Created|Updated) /);
      expect(fs.readFileSync(file, 'utf8')).toBe('new');
    });

    it('reports not_applied and performs the write when the file still holds the old content', async () => {
      const tools = await makeBuiltins();
      const file = tools.write('r.txt', 'old');
      seedInterrupted(tools, 'r2', { path: file, preHash: sha256('old'), postHash: sha256('new') });
      const outcome = await tools.run('Write', { file_path: file, content: 'new' }, { mode: 'acceptEdits' }, undefined, 'r2');
      expect(outcome).toMatchObject({ kind: 'result', reconciled: 'not_applied', result: { status: 'completed', output: `Updated ${file} (1 line)` } });
      expect(fs.readFileSync(file, 'utf8')).toBe('new');
    });

    it('reports not_applied for a new file that is still absent', async () => {
      const tools = await makeBuiltins();
      const file = path.join(tools.layout.project, 'absent.txt');
      seedInterrupted(tools, 'r3', { path: file, preHash: null, postHash: sha256('new') });
      const outcome = await tools.run('Write', { file_path: file, content: 'new' }, { mode: 'acceptEdits' }, undefined, 'r3');
      expect(outcome).toMatchObject({ kind: 'result', reconciled: 'not_applied', result: { status: 'completed' } });
      expect(fs.readFileSync(file, 'utf8')).toBe('new');
    });

    it('reports unknown and leaves the file alone when it holds something else', async () => {
      const tools = await makeBuiltins();
      const file = tools.write('r.txt', 'third party');
      seedInterrupted(tools, 'r4', { path: file, preHash: sha256('old'), postHash: sha256('new') });
      const outcome = await tools.run('Write', { file_path: file, content: 'new' }, { mode: 'acceptEdits' }, undefined, 'r4');
      expect(outcome).toMatchObject({ kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
      expect(fs.readFileSync(file, 'utf8')).toBe('third party');
    });
  });
});
