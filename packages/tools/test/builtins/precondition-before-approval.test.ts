import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call } from '../harness.ts';
import { approvalOf, makeBuiltins, resultOf } from './fixtures.ts';

const MANUAL = { mode: 'manual' } as const;

describe('a precondition that needs no person is checked before a person is asked', () => {
  it('fails an Edit of a file that was not read without asking for its approval', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('add.js', 'export const add = (a, b) => a - b;\n');
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a - b', new_string: 'a + b' }, MANUAL));
    expect(result).toMatchObject({ status: 'failed', output: 'add.js has not been read in this session; Read it first before modifying it' });
    expect(fs.readFileSync(file, 'utf8')).toBe('export const add = (a, b) => a - b;\n');
  });

  it('fails an Edit whose old text is not in the file without asking', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('add.js', 'export const add = (a, b) => a - b;\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a * b', new_string: 'a + b' }, MANUAL));
    expect(result.status).toBe('failed');
  });

  it('asks about an Edit that can run, and runs it once approved', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('add.js', 'export const add = (a, b) => a - b;\n');
    tools.markRead(file);
    const input = { file_path: file, old_string: 'a - b', new_string: 'a + b' };
    const callId = tools.nextCallId();
    const asked = approvalOf(await tools.run('Edit', input, MANUAL, undefined, callId));
    const result = resultOf(await tools.run('Edit', input, MANUAL, { kind: 'allow_once', subjectDigest: asked.subjectDigest }, callId));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('export const add = (a, b) => a + b;\n');
  });

  it('shows the whole line a partial match changes in the diff of its approval', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('add.js', 'export const add = (a, b) => a - b;\n');
    tools.markRead(file);
    const asked = approvalOf(await tools.run('Edit', { file_path: file, old_string: 'a - b', new_string: 'a + b' }, MANUAL));
    expect(asked.shown.diff).toMatchObject({ hunks: [{ oldStart: 1, newStart: 1, lines: ['-export const add = (a, b) => a - b;', '+export const add = (a, b) => a + b;'] }], added: 1, removed: 1 });
  });

  it('fails a Write over a file that was not read without asking, and asks about a new file', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('notes.txt', 'old\n');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'new\n' }, MANUAL));
    expect(result).toMatchObject({ status: 'failed', output: 'notes.txt has not been read in this session; Read it first before modifying it' });
    expect(approvalOf(await tools.run('Write', { file_path: 'fresh.txt', content: 'new\n' }, MANUAL)).kind).toBe('needs_approval');
  });

  it('checks an Edit that follows the Read of its file in one batch after the Read ran', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('add.js', 'export const add = (a, b) => a - b;\n');
    const outcomes = await tools.executor.runBatch(
      await tools.input(tools.toolSet, [call('c-read', 'Read', { file_path: file }), call('c-edit', 'Edit', { file_path: file, old_string: 'a - b', new_string: 'a + b' })], { ...MANUAL, sandboxPolicy: tools.sandboxPolicy, tmpDir: tools.tmpDir }),
    );
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['result', 'needs_approval']);
  });
});
