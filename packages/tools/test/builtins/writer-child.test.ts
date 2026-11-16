import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bsdFileLock } from '@momonga/foundation';
import { createUnsandboxed } from '@momonga/sandbox';
import { writeInWriterChild } from '@momonga/tools';
import type { WriterLaunch } from '@momonga/tools';
import { HAS_REAL_SANDBOX, HOST_SANDBOX_KIND, createHostSandbox, makeLayout, policyFor } from '../helpers.ts';
import { TEST_WRITER_LAUNCH, makeBuiltins, resultOf } from './fixtures.ts';

const REFUSING_LAUNCH: WriterLaunch = { argv: ['/bin/sh', '-c', 'echo "the test writer refuses" >&2; exit 3'] };

const ACCEPT_EDITS = { mode: 'acceptEdits' } as const;

const UNCONFINED = createUnsandboxed({ protection: { kind: 'unprotected', reason: 'the test runs its writer launch without a sandbox' }, platform: process.platform });

describe('Edit and Write write through the writer child', () => {
  it('an Edit whose writer child fails reports the failure and leaves the file as it was', async () => {
    const tools = await makeBuiltins({ sandbox: UNCONFINED, executor: { writerLaunch: REFUSING_LAUNCH } });
    const file = tools.write('add.js', 'export const add = (a, b) => a - b;\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a - b', new_string: 'a + b' }, ACCEPT_EDITS));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('the test writer refuses');
    expect(fs.readFileSync(file, 'utf8')).toBe('export const add = (a, b) => a - b;\n');
  });

  it('a Write of a new file goes through the writer child too', async () => {
    const tools = await makeBuiltins({ sandbox: UNCONFINED, executor: { writerLaunch: REFUSING_LAUNCH } });
    const file = path.join(path.dirname(tools.write('seed.txt', '')), 'nested', 'new.txt');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'new\n' }, ACCEPT_EDITS));
    expect(result.status).toBe('failed');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('the test writer launch writes the file, creating its missing directories', async () => {
    const tools = await makeBuiltins({ executor: { writerLaunch: TEST_WRITER_LAUNCH } });
    const file = path.join(path.dirname(tools.write('seed.txt', '')), 'deep', 'er', 'new.txt');
    expect(resultOf(await tools.run('Write', { file_path: file, content: 'made\n' }, ACCEPT_EDITS)).status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('made\n');
  });

  it('with sandbox none the result says that only the path check confined the write', async () => {
    const tools = await makeBuiltins({ sandbox: UNCONFINED, executor: { writerLaunch: TEST_WRITER_LAUNCH } });
    const file = path.join(path.dirname(tools.write('seed.txt', '')), 'plain.txt');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'x\n' }, ACCEPT_EDITS));
    expect(result.output).toContain('the sandbox is off, so only the path check kept this write inside the writable roots');
  });
});

describe.runIf(HAS_REAL_SANDBOX)(`the writer child under the ${HOST_SANDBOX_KIND} sandbox (macOS seatbelt; Linux bubblewrap, run in the Linux container)`, () => {
  it('is refused by the kernel when it is asked to write outside the writable roots, and the file outside is unchanged', async () => {
    const layout = makeLayout();
    const tmpRoot = path.join(layout.root, 'sandbox-tmp');
    fs.mkdirSync(tmpRoot);
    const sandbox = createHostSandbox({ tmpRoot, killGraceMs: 300 });
    const sandboxPolicy = await policyFor({ layout });
    const outside = path.join(fs.realpathSync(layout.outside), 'secret.txt');
    fs.writeFileSync(outside, 'kept\n');
    const answer = await writeInWriterChild(
      { sandbox, sandboxPolicy, launch: TEST_WRITER_LAUNCH, cwd: layout.project, env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal },
      { target: outside, content: 'overwritten\n', mode: 0o644, lock: bsdFileLock.name },
    );
    expect(answer.kind).toBe('failed');
    expect(fs.readFileSync(outside, 'utf8')).toBe('kept\n');
  });

  it('writes inside the writable roots', async () => {
    const layout = makeLayout();
    const tmpRoot = path.join(layout.root, 'sandbox-tmp');
    fs.mkdirSync(tmpRoot);
    const sandbox = createHostSandbox({ tmpRoot, killGraceMs: 300 });
    const sandboxPolicy = await policyFor({ layout });
    const inside = path.join(fs.realpathSync(layout.project), 'made.txt');
    const answer = await writeInWriterChild(
      { sandbox, sandboxPolicy, launch: TEST_WRITER_LAUNCH, cwd: layout.project, env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal },
      { target: inside, content: 'inside\n', mode: 0o644, lock: bsdFileLock.name },
    );
    expect(answer).toEqual({ kind: 'written' });
    expect(fs.readFileSync(inside, 'utf8')).toBe('inside\n');
  });
});
