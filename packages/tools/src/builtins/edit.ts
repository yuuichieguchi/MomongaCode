import { sha256Hex } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { PreconditionContext } from '../types.ts';
import { NotUtf8Error, assertReadAndUnchanged, assertSameLocation, looksBinary, readUtf8File, regularFileProblem, updateLedgerAfterWrite, sha256OfFile, statIfExists, writeFileAtomically } from './files.ts';
import { diffOfReplacements } from './applied-diff.ts';
import type { TextReplacement } from './applied-diff.ts';
import { numberedLines, splitLines } from './format.ts';
import { accessedPathOf, canonicalPathOf, resolvedPathOf, shownPath } from './paths.ts';
import { approvalOfPreparedWrite, parsePreparedWrite, reconcileWrite } from './prepared.ts';
import type { PreparedWrite } from './prepared.ts';

type EditInput = { file_path: string; old_string: string; new_string: string; replace_all?: boolean };

const CONTEXT_LINES = 4;

type Replacement = { updated: string; firstStart: number; lastEnd: number; replaced: TextReplacement[] };

const occurrencesOf = (content: string, needle: string): number[] => {
  const found: number[] = [];
  for (let index = content.indexOf(needle); index !== -1; index = content.indexOf(needle, index + needle.length)) found.push(index);
  return found;
};

const replaceAt = (content: string, positions: readonly number[], oldString: string, newString: string): Replacement => {
  let updated = '';
  let cursor = 0;
  let firstStart = 0;
  let lastEnd = 0;
  positions.forEach((position, index) => {
    updated += content.slice(cursor, position);
    if (index === 0) firstStart = updated.length;
    updated += newString;
    lastEnd = updated.length;
    cursor = position + oldString.length;
  });
  updated += content.slice(cursor);
  return { updated, firstStart, lastEnd, replaced: positions.map((position) => ({ position, length: oldString.length, text: newString })) };
};

const computeReplacement = (content: string, input: EditInput, shown: string): Replacement => {
  let oldString = input.old_string;
  let newString = input.new_string;
  let positions = occurrencesOf(content, oldString);
  if (positions.length === 0 && content.includes('\r\n')) {
    oldString = oldString.replaceAll('\n', '\r\n');
    newString = newString.replaceAll('\n', '\r\n');
    positions = occurrencesOf(content, oldString);
  }
  if (positions.length === 0) {
    throw new ToolExecutionError(
      `old_string was not found in ${shown}. It must match the file exactly, including whitespace and indentation.`,
    );
  }
  if (positions.length > 1 && input.replace_all !== true) {
    throw new ToolExecutionError(`found ${positions.length} matches; add surrounding context to make old_string unique or set replace_all`);
  }
  return replaceAt(content, positions, oldString, newString);
};

const lineAt = (text: string, position: number): number => {
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < position; index = text.indexOf('\n', index + 1)) line += 1;
  return line;
};

const snippetOf = (replacement: Replacement): string => {
  const lines = splitLines(replacement.updated);
  const firstLine = lineAt(replacement.updated, replacement.firstStart);
  const lastLine = lineAt(replacement.updated, Math.max(replacement.firstStart, replacement.lastEnd - 1));
  const from = Math.max(1, firstLine - CONTEXT_LINES);
  const to = Math.min(lines.length, lastLine + CONTEXT_LINES);
  return numberedLines(lines.slice(from - 1, to), from);
};

const editableTextOf = (files: Pick<FileSystem, 'readFile'>, file: string, shown: string): Promise<string> =>
  readUtf8File(files, file).catch((error: unknown) => {
    if (error instanceof NotUtf8Error) throw new ToolExecutionError(`${shown} is not UTF-8 text and cannot be edited as text; its encoding is not guessed`);
    throw error;
  });

type PlannedEdit = { path: string; preHash: string; postHash: string; text: string; replacement: Replacement };

const planEdit = async (input: EditInput, ctx: PreconditionContext): Promise<PlannedEdit> => {
  if (input.old_string === '') throw new ToolExecutionError('old_string must not be empty; use Write to create or replace a file');
  if (input.old_string === input.new_string) throw new ToolExecutionError('old_string and new_string are identical; nothing to change');
  const target = await canonicalPathOf(ctx, 'file_path', input.file_path);
  const shown = await shownPath(ctx, resolvedPathOf(ctx, input.file_path));
  const stat = await statIfExists(ctx.files, target);
  if (stat === undefined) throw new ToolExecutionError(`File does not exist: ${shown}`);
  if (stat.isDirectory()) throw new ToolExecutionError(`${shown} is a directory, not a file`);
  const problem = regularFileProblem(stat, shown);
  if (problem !== undefined) throw new ToolExecutionError(problem);
  if (await looksBinary(ctx.files, target)) throw new ToolExecutionError(`${shown} is a binary file and cannot be edited as text`);
  const text = await editableTextOf(ctx.files, target, shown);
  const preHash = await assertReadAndUnchanged(ctx.files, ctx.session, target, shown);
  const replacement = computeReplacement(text, input, shown);
  return { path: target, preHash, postHash: sha256Hex(replacement.updated), text, replacement };
};

const prepareEdit = async (input: EditInput, ctx: PreconditionContext): Promise<PreparedWrite> => {
  const { path, preHash, postHash, text, replacement } = await planEdit(input, ctx);
  return { path, preHash, postHash, diff: diffOfReplacements(text, replacement.replaced) };
};

export const editTool = defineTool<EditInput>({
  name: 'Edit',
  companionOf: 'Read',
  description:
    'Replaces text in an existing file. file_path may be absolute or relative; a relative path is resolved against the working directory. The file must have been read with Read first and must be unchanged since. old_string must match exactly once (include surrounding context to make it unique) unless replace_all is true.',
  conciseDescription:
    'Replaces text in a file you have Read and that is unchanged since. A relative file_path is resolved against the working directory. old_string must match exactly once unless replace_all is true.',
  conciseParameterDescriptions: {
    file_path: 'File to modify; a relative path is resolved against the working directory',
    old_string: 'Exact text to replace',
    new_string: 'Replacement text',
    replace_all: 'Replace every occurrence',
  },
  kind: 'edit',
  sideEffect: 'write',
  subjectKind: 'path',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to modify; a relative path is resolved against the working directory' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  title: async (input, ctx) => `Edit ${await shownPath(ctx, await accessedPathOf(ctx, input.file_path))}`,
  locations: (input, ctx) => [{ path: resolvedPathOf(ctx, input.file_path) }],
  subject: (input, ctx) => ({ kind: 'path', tool: 'Edit', paths: [resolvedPathOf(ctx, input.file_path)], access: 'write' }),
  approval: async (input, ctx) => approvalOfPreparedWrite(await prepareEdit(input, ctx)),
  prepare: prepareEdit,
  execute: async (input, ctx, prepared) => {
    const plan = parsePreparedWrite(prepared);
    const requested = resolvedPathOf(ctx, input.file_path);
    const shown = await shownPath(ctx, requested);
    await assertSameLocation(ctx, requested, plan.path, await canonicalPathOf(ctx, 'file_path', input.file_path));
    const stat = await statIfExists(ctx.files, plan.path);
    const problem = stat === undefined ? undefined : regularFileProblem(stat, shown);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    if (stat === undefined || (await sha256OfFile(ctx.files, plan.path)) !== plan.preHash) {
      throw new ToolExecutionError(`${shown} has changed since it was last read; Read it again before modifying it`);
    }
    const original = await editableTextOf(ctx.files, plan.path, shown);
    const replacement = computeReplacement(original, input, shown);
    if (sha256Hex(replacement.updated) !== plan.postHash) throw new ToolExecutionError('Edit result does not match the prepared state');
    const warning = await writeFileAtomically({
      files: ctx.files,
      random: ctx.random,
      scope: ctx,
      target: plan.path,
      requestedPath: requested,
      content: replacement.updated,
      mode: stat.mode & 0o777,
      lock: ctx.kernelLock,
      onRenamed: () => updateLedgerAfterWrite(ctx.files, ctx.session, plan.path, plan.postHash),
    });
    return {
      status: 'completed',
      output: `The file ${shown} has been updated. Here is the result of running cat -n on a snippet of the edited file:\n${snippetOf(replacement)}${warning === undefined ? '' : `\n${warning}`}`,
      files: [{ path: plan.path, sha256: plan.postHash, access: 'write' }],
      ...plan.diff,
    };
  },
  reconcile: async (input, record, ctx) => reconcileWrite(record, 'Edit', ctx, resolvedPathOf(ctx, input.file_path)),
});
