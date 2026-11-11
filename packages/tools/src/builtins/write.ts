import { sha256Hex } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { PreconditionContext } from '../types.ts';
import { assertReadAndUnchanged, assertSameLocation, isUtf8File, newFileMode, readUtf8File, regularFileProblem, updateLedgerAfterWrite, sha256OfFile, statIfExists, writeFileAtomically } from './files.ts';
import { diffOfContents } from './applied-diff.ts';
import { pluralize, splitLines } from './format.ts';
import { accessedPathOf, canonicalPathOf, resolvedPathOf, shownPath } from './paths.ts';
import { parsePreparedWrite, reconcileWrite } from './prepared.ts';

type WriteInput = { file_path: string; content: string };

const planWrite = async (input: WriteInput, ctx: PreconditionContext): Promise<{ path: string; preHash: string | null; postHash: string }> => {
  const target = await canonicalPathOf(ctx, 'file_path', input.file_path);
  const shown = await shownPath(ctx, resolvedPathOf(ctx, input.file_path));
  const stat = await statIfExists(ctx.files, target);
  if (stat?.isDirectory() === true) throw new ToolExecutionError(`${shown} is a directory, not a file`);
  const problem = stat === undefined ? undefined : regularFileProblem(stat, shown);
  if (problem !== undefined) throw new ToolExecutionError(problem);
  if (stat !== undefined && !(await isUtf8File(ctx.files, target))) {
    throw new ToolExecutionError(`${shown} is not UTF-8 text and is not replaced by Write; its encoding is not guessed`);
  }
  const preHash = stat === undefined ? null : await assertReadAndUnchanged(ctx.files, ctx.session, target, shown);
  return { path: target, preHash, postHash: sha256Hex(input.content) };
};

export const writeTool = defineTool<WriteInput>({
  name: 'Write',
  description:
    'Writes a file, creating missing parent directories. file_path may be absolute or relative; a relative path is resolved against the working directory. An existing file must have been read with Read first and must be unchanged since. Replaces the whole file; prefer Edit for partial changes.',
  conciseDescription:
    'Writes a whole file, creating parent directories. A relative file_path is resolved against the working directory. Read an existing file first; it must be unchanged since. Prefer Edit for partial changes.',
  conciseParameterDescriptions: {
    file_path: 'File to write; a relative path is resolved against the working directory',
    content: 'Full new content',
  },
  kind: 'edit',
  sideEffect: 'write',
  subjectKind: 'path',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to write; a relative path is resolved against the working directory' },
      content: { type: 'string', description: 'Full new content of the file' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  title: async (input, ctx) => `Write ${await shownPath(ctx, await accessedPathOf(ctx, input.file_path))}`,
  locations: (input, ctx) => [{ path: resolvedPathOf(ctx, input.file_path) }],
  subject: (input, ctx) => ({ kind: 'path', tool: 'Write', paths: [resolvedPathOf(ctx, input.file_path)], access: 'write' }),
  precondition: async (input, ctx) => void (await planWrite(input, ctx)),
  prepare: planWrite,
  execute: async (input, ctx, prepared) => {
    const plan = parsePreparedWrite(prepared);
    if (sha256Hex(input.content) !== plan.postHash) throw new ToolExecutionError('Write content does not match the prepared state');
    const requested = resolvedPathOf(ctx, input.file_path);
    const shown = await shownPath(ctx, requested);
    await assertSameLocation(ctx, requested, plan.path, await canonicalPathOf(ctx, 'file_path', input.file_path));
    const stat = await statIfExists(ctx.files, plan.path);
    const problem = stat === undefined ? undefined : regularFileProblem(stat, shown);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    let oldText: string | null = null;
    if (stat !== undefined) {
      if ((await sha256OfFile(ctx.files, plan.path)) !== plan.preHash) {
        throw new ToolExecutionError(`${shown} has changed since it was last read; Read it again before modifying it`);
      }
      oldText = await readUtf8File(ctx.files, plan.path);
    } else if (plan.preHash !== null) {
      throw new ToolExecutionError(`${shown} has changed since it was last read; Read it again before modifying it`);
    }
    const warning = await writeFileAtomically({
      files: ctx.files,
      random: ctx.random,
      scope: ctx,
      target: plan.path,
      requestedPath: requested,
      content: input.content,
      mode: stat === undefined ? newFileMode() : stat.mode & 0o777,
      onRenamed: () => updateLedgerAfterWrite(ctx.files, ctx.session, plan.path, plan.postHash),
    });
    const lines = pluralize(splitLines(input.content).length, 'line', 'lines');
    return {
      status: 'completed',
      output: `${stat === undefined ? 'Created' : 'Updated'} ${shown} (${lines})${warning === undefined ? '' : `\n${warning}`}`,
      content: [{ type: 'diff', path: plan.path, oldText, newText: input.content }],
      files: [{ path: plan.path, sha256: plan.postHash, access: 'write' }],
      ...diffOfContents(oldText, input.content),
    };
  },
  reconcile: async (input, record, ctx) => reconcileWrite(record, 'Write', ctx, resolvedPathOf(ctx, input.file_path)),
});
