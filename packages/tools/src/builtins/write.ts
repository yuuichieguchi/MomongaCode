import { sha256Hex } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { PreconditionContext } from '../types.ts';
import { assertReadAndUnchanged, assertSameLocation, isUtf8File, newFileMode, readUtf8File, regularFileProblem, updateLedgerAfterWrite, sha256OfFile, statIfExists, writeFileAtomically } from './files.ts';
import { DIFF_FILE_TOO_LARGE, DIFF_MAX_BYTES, diffOfContents } from './applied-diff.ts';
import type { AppliedDiff } from './applied-diff.ts';
import { pluralize, splitLines } from './format.ts';
import { accessedPathOf, canonicalPathOf, resolvedPathOf, shownPath } from './paths.ts';
import { approvalOfPreparedWrite, parsePreparedWrite, reconcileWrite } from './prepared.ts';
import type { PreparedWrite } from './prepared.ts';

type WriteInput = { file_path: string; content: string };

type PlannedWrite = { path: string; preHash: string | null; postHash: string; existingBytes: number | undefined };

const planWrite = async (input: WriteInput, ctx: PreconditionContext): Promise<PlannedWrite> => {
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
  return { path: target, preHash, postHash: sha256Hex(input.content), existingBytes: stat?.size };
};

const diffOfWrite = async (files: PreconditionContext['files'], target: string, existingBytes: number | undefined, content: string): Promise<AppliedDiff> => {
  if (existingBytes === undefined) return diffOfContents(null, content);
  if (existingBytes > DIFF_MAX_BYTES) return { diffOmitted: DIFF_FILE_TOO_LARGE };
  return diffOfContents(await readUtf8File(files, target), content);
};

const prepareWrite = async (input: WriteInput, ctx: PreconditionContext): Promise<PreparedWrite> => {
  const { path, preHash, postHash, existingBytes } = await planWrite(input, ctx);
  return { path, preHash, postHash, diff: await diffOfWrite(ctx.files, path, existingBytes, input.content) };
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
  approval: async (input, ctx) => approvalOfPreparedWrite(await prepareWrite(input, ctx)),
  prepare: prepareWrite,
  execute: async (input, ctx, prepared) => {
    const plan = parsePreparedWrite(prepared);
    if (sha256Hex(input.content) !== plan.postHash) throw new ToolExecutionError('Write content does not match the prepared state');
    const requested = resolvedPathOf(ctx, input.file_path);
    const shown = await shownPath(ctx, requested);
    await assertSameLocation(ctx, requested, plan.path, await canonicalPathOf(ctx, 'file_path', input.file_path));
    const stat = await statIfExists(ctx.files, plan.path);
    const problem = stat === undefined ? undefined : regularFileProblem(stat, shown);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    if ((stat === undefined ? null : await sha256OfFile(ctx.files, plan.path)) !== plan.preHash) {
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
      lock: ctx.kernelLock,
      onRenamed: () => updateLedgerAfterWrite(ctx.files, ctx.session, plan.path, plan.postHash),
    });
    const lines = pluralize(splitLines(input.content).length, 'line', 'lines');
    return {
      status: 'completed',
      output: `${stat === undefined ? 'Created' : 'Updated'} ${shown} (${lines})${warning === undefined ? '' : `\n${warning}`}`,
      files: [{ path: plan.path, sha256: plan.postHash, access: 'write' }],
      ...plan.diff,
    };
  },
  reconcile: async (input, record, ctx) => reconcileWrite(record, 'Write', ctx, resolvedPathOf(ctx, input.file_path)),
});
