import path from 'node:path';
import { comparableContains, sha256Hex } from '@momonga/foundation';
import type { MessageInputItem } from '@momonga/protocol';
import type {
  ContextNotice,
  InstructionReader,
  InstructionScope,
  LoadedInstruction,
  TouchedPath,
} from './types.ts';

export const INSTRUCTION_FILE_LIMIT_BYTES = 32768;

const FILE_NAME = 'AGENTS.md';
const TRUNCATION_NOTE = '[truncated: file exceeds 32 KiB]';
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BITS = 0x80;

export type LoadedInstructionFile = { instruction: LoadedInstruction; message: MessageInputItem };

export type DiscoveredInstructions = {
  user: LoadedInstructionFile | undefined;
  root: LoadedInstructionFile | undefined;
  nested: LoadedInstructionFile[];
  notices: ContextNotice[];
};

export type DiscoverOptions = {
  reader: InstructionReader;
  home: string;
  projectRoot: string;
  trusted: boolean;
  touchedPaths: readonly TouchedPath[];
};

const capText = (text: string): { text: string; truncated: boolean } => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= INSTRUCTION_FILE_LIMIT_BYTES) return { text, truncated: false };
  let end = INSTRUCTION_FILE_LIMIT_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) end -= 1;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
};

const loadedFile = (
  filePath: string,
  realPath: string,
  scope: InstructionScope,
  appliesTo: string,
  rawText: string,
): LoadedInstructionFile => {
  const capped = capText(rawText);
  const body = capped.truncated ? `${capped.text}\n${TRUNCATION_NOTE}` : capped.text;
  return {
    instruction: { path: filePath, realPath, scope, truncated: capped.truncated, text: capped.text, textSha256: sha256Hex(capped.text) },
    message: {
      type: 'message',
      role: 'developer',
      content: `Instructions from ${filePath} (applies to ${appliesTo}):\n${body}`,
    },
  };
};

export const recordedNestedFile = (filePath: string, text: string): LoadedInstructionFile =>
  loadedFile(filePath, filePath, 'nested', `${path.posix.dirname(filePath)}/**`, text);

const nestedCandidates = (roots: readonly string[], projectRoot: string, touchedPaths: readonly TouchedPath[]): string[] => {
  const candidates = new Set<string>();
  for (const touched of touchedPaths) {
    const normalized = path.posix.normalize(touched.path);
    const root = roots.find((entry) => normalized.startsWith(`${entry}/`));
    if (root === undefined) continue;
    const segments = normalized.slice(root.length + 1).split('/').filter((segment) => segment !== '');
    const depth = touched.kind === 'file' ? segments.length - 1 : segments.length;
    for (let length = 1; length <= depth; length += 1) {
      candidates.add(`${projectRoot}/${segments.slice(0, length).join('/')}/${FILE_NAME}`);
    }
  }
  return [...candidates];
};

export const discoverInstructions = async (options: DiscoverOptions): Promise<DiscoveredInstructions> => {
  const { reader, home, trusted, touchedPaths } = options;
  const projectRoot = path.posix.normalize(options.projectRoot).replace(/\/+$/, '');
  const realRoot = await reader.realpath(projectRoot);
  if (realRoot === undefined) throw new Error(`project root ${projectRoot} does not exist`);
  const notices: ContextNotice[] = [];

  const userPath = `${home}/.momonga/${FILE_NAME}`;
  const userFile = await reader.read(userPath);
  const user =
    userFile === undefined ? undefined : loadedFile(userPath, userFile.realPath, 'user', 'all projects', userFile.text);

  const readInProject = async (filePath: string): Promise<{ realPath: string; text: string } | undefined> => {
    const file = await reader.read(filePath);
    if (file === undefined) return undefined;
    if (!comparableContains(realRoot, file.realPath)) {
      notices.push({
        code: 'instructions_outside_project',
        message: `${filePath} resolves to ${file.realPath}, outside the project, and was ignored`,
      });
      return undefined;
    }
    return file;
  };

  const rootPath = `${projectRoot}/${FILE_NAME}`;
  let root: LoadedInstructionFile | undefined;
  if (trusted) {
    const file = await readInProject(rootPath);
    if (file !== undefined) root = loadedFile(rootPath, file.realPath, 'root', `${projectRoot}/**`, file.text);
  } else if (await reader.exists(rootPath)) {
    notices.push({
      code: 'root_instructions_untrusted',
      message: `${rootPath} was skipped because the project is not trusted`,
    });
  }

  const nested: LoadedInstructionFile[] = [];
  const candidates = nestedCandidates([...new Set([projectRoot, realRoot])], projectRoot, touchedPaths);
  if (!trusted) {
    for (const candidate of candidates) {
      if (await reader.exists(candidate)) {
        notices.push({
          code: 'nested_instructions_untrusted',
          message: 'nested AGENTS.md files were skipped because the project is not trusted',
        });
        break;
      }
    }
    return { user, root, nested, notices };
  }
  for (const candidate of candidates) {
    const file = await readInProject(candidate);
    if (file === undefined) continue;
    const dir = path.posix.dirname(candidate);
    nested.push(loadedFile(candidate, file.realPath, 'nested', `${dir}/**`, file.text));
  }

  return { user, root, nested, notices };
};
