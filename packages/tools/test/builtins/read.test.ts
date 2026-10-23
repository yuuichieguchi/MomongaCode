import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalOf, catN, makeBuiltins, range, resultOf, sha256 } from './fixtures.ts';

describe('Read', () => {
  it('formats lines cat -n style with six-wide right-aligned numbers and a tab', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('notes.txt', 'alpha\nbeta\n');
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result).toMatchObject({ status: 'completed', output: '     1\talpha\n     2\tbeta' });
  });

  it('reads at most 2000 lines by default and notes where to continue', async () => {
    const tools = await makeBuiltins({ maxInlineOutputChars: 100_000 });
    const file = tools.write('long.txt', range(1, 2500).map((n) => `row ${n}`).join('\n'));
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result.output).toBe(`${catN(range(1, 2000).map((n) => `row ${n}`))}\n[Showed lines 1–2000. Continue with offset=2001.]`);
    expect(result.handle).toBeUndefined();
  });

  it('adds no continuation note when the file ends exactly at the line limit', async () => {
    const tools = await makeBuiltins({ maxInlineOutputChars: 100_000 });
    const file = tools.write('exact.txt', `${range(1, 2000).map((n) => `row ${n}`).join('\n')}\n`);
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result.output).toBe(catN(range(1, 2000).map((n) => `row ${n}`)));
  });

  it('notes the continuation for an explicit limit', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('five.txt', 'l1\nl2\nl3\nl4\nl5\n');
    const result = resultOf(await tools.run('Read', { file_path: file, offset: 2, limit: 2 }));
    expect(result.output).toBe(`${catN(['l2', 'l3'], 2)}\n[Showed lines 2–3. Continue with offset=4.]`);
  });

  it('pages itself within the default budget and continues exactly where it stopped', async () => {
    const tools = await makeBuiltins();
    const lines = range(1, 2200).map((n) => `${String(n).padStart(5, '0')} ${'x'.repeat(40)}`);
    const file = tools.write('paged.txt', `${lines.join('\n')}\n`);
    const pages: string[] = [];
    let offset = 1;
    for (let guard = 0; guard < 20; guard += 1) {
      const result = resultOf(await tools.run('Read', { file_path: file, offset, limit: 2200 - offset + 1 }));
      expect(result.handle).toBeUndefined();
      expect(result.output.length).toBeLessThanOrEqual(30_000);
      expect(result.output).not.toContain('full output saved as');
      const note = /\n\[Showed lines (\d+)–(\d+)\. Continue with offset=(\d+)\.\]$/.exec(result.output);
      if (note === null) {
        pages.push(result.output);
        break;
      }
      expect(Number(note[1])).toBe(offset);
      expect(Number(note[3])).toBe(Number(note[2]) + 1);
      pages.push(result.output.slice(0, note.index));
      offset = Number(note[3]);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('\n')).toBe(catN(lines));
  });

  it('cuts a single line that alone exceeds the budget', async () => {
    const tools = await makeBuiltins({ maxInlineOutputChars: 200 });
    const file = tools.write('one-wide.txt', `${'w'.repeat(1500)}\nnext\n`);
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result.handle).toBeUndefined();
    expect(result.output.length).toBeLessThanOrEqual(200);
    const [first, note] = result.output.split('\n');
    expect(first?.startsWith('     1\twww')).toBe(true);
    expect(first?.endsWith('… [line truncated]')).toBe(true);
    expect(note).toBe('[Showed lines 1–1. Continue with offset=2.]');
  });

  it('cuts lines longer than 2000 characters', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('wide.txt', `${'a'.repeat(2500)}\nshort\n`);
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result.output).toBe(`     1\t${'a'.repeat(2000)}… [line truncated]\n     2\tshort`);
  });

  it('keeps a line of exactly 2000 characters intact', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('edge.txt', `${'b'.repeat(2000)}\n`);
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result.output).toBe(`     1\t${'b'.repeat(2000)}`);
  });

  it('reads the tail of a large file correctly', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('huge.txt', `${range(1, 100_000).map((n) => `line-${n}`).join('\n')}\n`);
    const result = resultOf(await tools.run('Read', { file_path: file, offset: 99_999, limit: 5 }));
    expect(result.output).toBe(catN(['line-99999', 'line-100000'], 99_999));
  });

  it('decodes multi-byte UTF-8 characters', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('utf8.txt', 'もものが\n絵文字 🐿️\n');
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result.output).toBe(catN(['もものが', '絵文字 🐿️']));
  });

  it('reports an empty file', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('empty.txt', '');
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result).toMatchObject({ status: 'completed', output: '(file is empty)' });
  });

  it('reports an offset past the end of the file', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('three.txt', 'a\nb\nc\n');
    const result = resultOf(await tools.run('Read', { file_path: file, offset: 5 }));
    expect(result.output).toBe('offset 5 is past the end of the file (3 lines)');
  });

  it('refuses a binary file and reports its size', async () => {
    const tools = await makeBuiltins();
    const bytes = Buffer.concat([Buffer.from('PNG'), Buffer.from([0]), Buffer.alloc(1230, 7)]);
    const file = tools.write('image.bin', bytes);
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('1234');
    expect(tools.session.readLedger.has(file)).toBe(false);
  });

  it('treats a NUL byte after the first 8192 bytes as text', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('late-nul.txt', Buffer.concat([Buffer.from(`${'x'.repeat(8192)}\n`), Buffer.from([0])]));
    const result = resultOf(await tools.run('Read', { file_path: file, limit: 1 }));
    expect(result.status).toBe('completed');
    expect(result.output).toBe(`     1\t${'x'.repeat(2000)}… [line truncated]\n[Showed lines 1–1. Continue with offset=2.]`);
  });

  it('suggests Glob or Bash ls for a directory', async () => {
    const tools = await makeBuiltins();
    const dir = path.join(tools.layout.project, 'src');
    fs.mkdirSync(dir);
    const result = resultOf(await tools.run('Read', { file_path: dir }));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/Glob/);
    expect(result.output).toMatch(/\bls\b/);
  });

  it('reports a missing file', async () => {
    const tools = await makeBuiltins();
    const missing = path.join(tools.layout.project, 'missing.txt');
    const result = resultOf(await tools.run('Read', { file_path: missing }));
    expect(result).toMatchObject({ status: 'failed', output: `File does not exist: ${missing}` });
  });

  it('rejects a relative path', async () => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('Read', { file_path: 'notes.txt' }));
    expect(result).toMatchObject({ status: 'failed', output: 'file_path must be an absolute path' });
  });

  it.each([{ offset: 0 }, { limit: 0 }, { offset: 1.5 }])('rejects invalid paging %o', async (paging) => {
    const tools = await makeBuiltins();
    const file = tools.write('a.txt', 'a\n');
    const result = resultOf(await tools.run('Read', { file_path: file, ...paging }));
    expect(result.status).toBe('failed');
    expect(tools.session.readLedger.size).toBe(0);
  });

  it('records the whole-file sha256 and mtime in the ledger even for a partial read', async () => {
    const tools = await makeBuiltins();
    const content = `${range(1, 50).map((n) => `v${n}`).join('\n')}\n`;
    const file = tools.write('ledger.txt', content);
    fs.utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    resultOf(await tools.run('Read', { file_path: file, offset: 10, limit: 2 }));
    expect(tools.session.readLedger.get(file)).toEqual({ sha256: sha256(content), mtimeMs: fs.statSync(file).mtimeMs });
  });

  it('keys the ledger by the canonical path when read through a symlink', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('real.txt', 'real\n');
    const link = path.join(tools.layout.project, 'alias.txt');
    fs.symlinkSync(target, link);
    const result = resultOf(await tools.run('Read', { file_path: link }));
    expect(result.output).toBe('     1\treal');
    expect([...tools.session.readLedger.keys()]).toEqual([target]);
  });

  it('asks before reading a workspace symlink that resolves outside the roots', async () => {
    const tools = await makeBuiltins();
    const outsideFile = path.join(tools.layout.outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'outside\n');
    const link = path.join(tools.layout.project, 'escape.txt');
    fs.symlinkSync(outsideFile, link);
    const outcome = await tools.run('Read', { file_path: link });
    expect(approvalOf(outcome).toolKind).toBe('read');
  });

  it('exposes the title and locations when asking for approval', async () => {
    const tools = await makeBuiltins();
    const outsideFile = path.join(tools.layout.outside, 'other.txt');
    fs.writeFileSync(outsideFile, 'x\n');
    const outcome = approvalOf(await tools.run('Read', { file_path: outsideFile, offset: 3 }));
    expect(outcome.title).toBe(`Read ${outsideFile}`);
    expect(outcome.locations).toEqual([{ path: outsideFile, line: 3 }]);
  });

  it.each(['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const)('is denied inside a readDenied path in %s mode', async (mode) => {
    const tools = await makeBuiltins();
    const secretDir = path.join(tools.layout.home, '.momonga');
    fs.mkdirSync(secretDir);
    const secret = path.join(secretDir, 'credentials.json');
    fs.writeFileSync(secret, '{}');
    const result = resultOf(await tools.run('Read', { file_path: secret }, { mode }, 'allow_once'));
    expect(result).toEqual({ status: 'failed', output: `Permission denied: ${secret} is blocked by the sandbox policy` });
  });
});
