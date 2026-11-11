import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeBuiltins, resultOf, sha256 } from './fixtures.ts';

const ACCEPT = { mode: 'acceptEdits' } as const;

const SHIFT_JIS = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x20, 0x3d, 0x20, 0x31, 0x0a]);
const LATE_INVALID = Buffer.concat([Buffer.from(`${'plain line\n'.repeat(20_000)}`), Buffer.from([0xff, 0xfe, 0x0a])]);
const WITH_BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('value = 1\n')]);

describe('a file that is not UTF-8 text', () => {
  it('is not read as text: Read says it is not UTF-8 and records nothing in the read ledger', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('legacy.txt', SHIFT_JIS);
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result).toMatchObject({ status: 'failed', output: `legacy.txt is not UTF-8 text (${SHIFT_JIS.length} bytes) and cannot be read as text; its encoding is not guessed` });
    expect(tools.session.readLedger.has(file)).toBe(false);
  });

  it('is found not to be UTF-8 wherever the first undecodable byte stands', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('late.txt', LATE_INVALID);
    const result = resultOf(await tools.run('Read', { file_path: file, limit: 2 }));
    expect(result).toMatchObject({ status: 'failed', output: expect.stringContaining('late.txt is not UTF-8 text') });
    expect(tools.session.readLedger.has(file)).toBe(false);
  });

  it('is not edited: Edit refuses with that reason and the bytes of the file stay as they were', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('legacy.txt', SHIFT_JIS);
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'value = 1', new_string: 'value = 2' }, ACCEPT));
    expect(result).toMatchObject({ status: 'failed', output: 'legacy.txt is not UTF-8 text and cannot be edited as text; its encoding is not guessed' });
    expect(sha256(fs.readFileSync(file))).toBe(sha256(SHIFT_JIS));
  });

  it('is refused by Edit with that reason before the read ledger is asked, since Read cannot read it', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('legacy.txt', SHIFT_JIS);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'value = 1', new_string: 'value = 2' }, ACCEPT));
    expect(result.output).toBe('legacy.txt is not UTF-8 text and cannot be edited as text; its encoding is not guessed');
  });

  it('is not replaced by Write, with that reason, and its bytes stay as they were', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('legacy.txt', SHIFT_JIS);
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'value = 2\n' }, ACCEPT));
    expect(result).toMatchObject({ status: 'failed', output: 'legacy.txt is not UTF-8 text and is not replaced by Write; its encoding is not guessed' });
    expect(sha256(fs.readFileSync(file))).toBe(sha256(SHIFT_JIS));
  });
});

describe('a file that is UTF-8 text', () => {
  it('is read and edited as before under a Japanese name with Japanese content', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('日本語.txt', '一行目\n値 = 1\n');
    expect(resultOf(await tools.run('Read', { file_path: file })).output).toContain('値 = 1');
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: '値 = 1', new_string: '値 = 2' }, ACCEPT));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('一行目\n値 = 2\n');
  });

  it('keeps its byte order mark through an edit', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('bom.txt', WITH_BOM);
    expect(resultOf(await tools.run('Read', { file_path: file })).status).toBe('completed');
    expect(resultOf(await tools.run('Edit', { file_path: file, old_string: 'value = 1', new_string: 'value = 2' }, ACCEPT)).status).toBe('completed');
    expect(fs.readFileSync(file)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('value = 2\n')]));
  });
});
