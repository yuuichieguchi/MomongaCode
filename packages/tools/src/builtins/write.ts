import fs from 'node:fs';
import { sha256Hex } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import { assertReadAndUnchanged, assertSameLocation, newFileMode, regularFileProblem, updateLedgerAfterWrite, sha256OfFile, statIfExists, writeFileAtomically } from './files.ts';
import { pluralize, splitLines } from './format.ts';
import { canonicalPathOf, requireAbsolute } from './paths.ts';
import { parsePreparedWrite, reconcileWrite } from './prepared.ts';

type WriteInput = { file_path: string; content: string };

export const writeTool = defineTool<WriteInput>({
  name: 'Write',
  description:
    'Writes a file, creating missing parent directories. file_path must be absolute. An existing file must have been read with Read first and must be unchanged since. Replaces the whole file; prefer Edit for partial changes.',
  kind: 'edit',
  sideEffect: 'write',
  subjectKind: 'path',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to write' },
      content: { type: 'string', description: 'Full new content of the file' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  title: (input) => `Write ${input.file_path}`,
  locations: (input) => [{ path: input.file_path }],
  subject: (input) => ({ kind: 'path', tool: 'Write', paths: [requireAbsolute('file_path', input.file_path)], access: 'write' }),
  prepare: async (input, ctx) => {
    const target = canonicalPathOf('file_path', input.file_path);
    const stat = await statIfExists(target);
    if (stat?.isDirectory() === true) throw new ToolExecutionError(`${input.file_path} is a directory, not a file`);
    const problem = stat === undefined ? undefined : regularFileProblem(stat, input.file_path);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    const preHash = stat === undefined ? null : await assertReadAndUnchanged(ctx.session, target);
    return { path: target, preHash, postHash: sha256Hex(input.content) };
  },
  execute: async (input, ctx, prepared) => {
    const plan = parsePreparedWrite(prepared);
    if (sha256Hex(input.content) !== plan.postHash) throw new ToolExecutionError('Write content does not match the prepared state');
    assertSameLocation(input.file_path, plan.path, canonicalPathOf('file_path', input.file_path));
    const stat = await statIfExists(plan.path);
    const problem = stat === undefined ? undefined : regularFileProblem(stat, input.file_path);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    let oldText: string | null = null;
    if (stat !== undefined) {
      if ((await sha256OfFile(plan.path)) !== plan.preHash) {
        throw new ToolExecutionError(`${plan.path} has changed since it was last read; Read it again before modifying it`);
      }
      oldText = await fs.promises.readFile(plan.path, 'utf8');
    } else if (plan.preHash !== null) {
      throw new ToolExecutionError(`${plan.path} has changed since it was last read; Read it again before modifying it`);
    }
    const warning = await writeFileAtomically({
      target: plan.path,
      requestedPath: input.file_path,
      content: input.content,
      mode: stat === undefined ? newFileMode() : stat.mode & 0o777,
      onRenamed: () => updateLedgerAfterWrite(ctx.session, plan.path, plan.postHash),
    });
    const lines = pluralize(splitLines(input.content).length, 'line', 'lines');
    return {
      status: 'completed',
      output: `${stat === undefined ? 'Created' : 'Updated'} ${plan.path} (${lines})${warning === undefined ? '' : `\n${warning}`}`,
      content: [{ type: 'diff', path: plan.path, oldText, newText: input.content }],
      files: [{ path: plan.path, sha256: plan.postHash, access: 'write' }],
    };
  },
  reconcile: async (_input, record) => reconcileWrite(record, 'Write'),
});
