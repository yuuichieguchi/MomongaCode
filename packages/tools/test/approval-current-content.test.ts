import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { approvalOf, makeBuiltins, resultOf } from './builtins/fixtures.ts';

describe('a Write or Edit approval carries the current file content', () => {
  it('shows the change a Write makes to the current text of an existing file', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('notes.txt', 'old line\n');
    tools.markRead(target);
    const asked = approvalOf(await tools.run('Write', { file_path: target, content: 'new line\n' }));
    expect(asked.shown.diff).toEqual({ hunks: [{ oldStart: 1, newStart: 1, lines: ['-old line', '+new line'] }], added: 1, removed: 1 });
  });

  it('shows the change an Edit makes', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('code.ts', 'const a = 1;\n');
    tools.markRead(target);
    const asked = approvalOf(await tools.run('Edit', { file_path: target, old_string: 'a = 1', new_string: 'a = 2' }));
    expect(asked.shown.diff).toMatchObject({ added: 1, removed: 1 });
  });

  it('asks again when the file changed after the question, and writes nothing', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('notes.txt', 'first\n');
    tools.markRead(target);
    const args = { file_path: target, content: 'mine\n' };
    const asked = approvalOf(await tools.run('Write', args, {}, undefined, 'w1'));
    fs.writeFileSync(target, 'someone else\n');
    tools.markRead(target);
    const again = approvalOf(await tools.run('Write', args, {}, { kind: 'allow_once', subjectDigest: asked.subjectDigest }, 'w1'));
    expect(again.subjectDigest).not.toBe(asked.subjectDigest);
    expect(fs.readFileSync(target, 'utf8')).toBe('someone else\n');
  });

  it('refuses a Write over a file that is not UTF-8 text before any question, showing no content', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('blob.bin', Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    tools.markRead(target);
    const result = resultOf(await tools.run('Write', { file_path: target, content: 'text\n' }));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('is not UTF-8 text');
  });
});
