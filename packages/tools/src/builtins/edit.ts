import fs from 'node:fs';
import { sha256Hex } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import { assertReadAndUnchanged, assertSameLocation, looksBinary, regularFileProblem, updateLedgerAfterWrite, sha256OfFile, statIfExists, writeFileAtomically } from './files.ts';
import { numberedLines, splitLines } from './format.ts';
import { canonicalPathOf, requireAbsolute } from './paths.ts';
import { parsePreparedWrite, reconcileWrite } from './prepared.ts';

type EditInput = { file_path: string; old_string: string; new_string: string; replace_all?: boolean };

const CONTEXT_LINES = 4;

type Replacement = { updated: string; firstStart: number; lastEnd: number };

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
  return { updated, firstStart, lastEnd };
};

const computeReplacement = (content: string, input: EditInput): Replacement => {
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
      `old_string was not found in ${input.file_path}. It must match the file exactly, including whitespace and indentation.`,
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

export const editTool = defineTool<EditInput>({
  name: 'Edit',
  description:
    'Replaces text in an existing file. file_path must be absolute. The file must have been read with Read first and must be unchanged since. old_string must match exactly once (include surrounding context to make it unique) unless replace_all is true.',
  kind: 'edit',
  sideEffect: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to modify' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  title: (input) => `Edit ${input.file_path}`,
  locations: (input) => [{ path: input.file_path }],
  subject: (input) => ({ kind: 'path', tool: 'Edit', paths: [requireAbsolute('file_path', input.file_path)], access: 'write' }),
  prepare: async (input, ctx) => {
    if (input.old_string === '') throw new ToolExecutionError('old_string must not be empty; use Write to create or replace a file');
    if (input.old_string === input.new_string) throw new ToolExecutionError('old_string and new_string are identical; nothing to change');
    const target = canonicalPathOf('file_path', input.file_path);
    const stat = await statIfExists(target);
    if (stat === undefined) throw new ToolExecutionError(`File does not exist: ${input.file_path}`);
    if (stat.isDirectory()) throw new ToolExecutionError(`${input.file_path} is a directory, not a file`);
    const problem = regularFileProblem(stat, input.file_path);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    if (await looksBinary(target)) throw new ToolExecutionError(`${input.file_path} is a binary file and cannot be edited as text`);
    const preHash = await assertReadAndUnchanged(ctx.session, target);
    const replacement = computeReplacement(await fs.promises.readFile(target, 'utf8'), input);
    return { path: target, preHash, postHash: sha256Hex(replacement.updated) };
  },
  execute: async (input, ctx, prepared) => {
    const plan = parsePreparedWrite(prepared);
    assertSameLocation(input.file_path, plan.path, canonicalPathOf('file_path', input.file_path));
    const stat = await statIfExists(plan.path);
    const problem = stat === undefined ? undefined : regularFileProblem(stat, input.file_path);
    if (problem !== undefined) throw new ToolExecutionError(problem);
    if (stat === undefined || (await sha256OfFile(plan.path)) !== plan.preHash) {
      throw new ToolExecutionError(`${plan.path} has changed since it was last read; Read it again before modifying it`);
    }
    const original = await fs.promises.readFile(plan.path, 'utf8');
    const replacement = computeReplacement(original, input);
    if (sha256Hex(replacement.updated) !== plan.postHash) throw new ToolExecutionError('Edit result does not match the prepared state');
    const warning = await writeFileAtomically({
      target: plan.path,
      requestedPath: input.file_path,
      content: replacement.updated,
      mode: stat.mode & 0o777,
      onRenamed: () => updateLedgerAfterWrite(ctx.session, plan.path, plan.postHash),
    });
    return {
      status: 'completed',
      output: `The file ${plan.path} has been updated. Here is the result of running cat -n on a snippet of the edited file:\n${snippetOf(replacement)}${warning === undefined ? '' : `\n${warning}`}`,
      content: [{ type: 'diff', path: plan.path, oldText: original, newText: replacement.updated }],
      files: [{ path: plan.path, sha256: plan.postHash, access: 'write' }],
    };
  },
  reconcile: async (_input, record) => reconcileWrite(record, 'Edit'),
});
