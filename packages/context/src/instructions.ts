import path from 'node:path';
import { containsByComponents, homeLayout, sha256Hex } from '@momonga/foundation';
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
  pinnedPaths: readonly string[];
  platform: NodeJS.Platform;
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

export const instructionPathsOf = (platform: NodeJS.Platform): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix);

export const projectRootOf = (platform: NodeJS.Platform, projectRoot: string): string => instructionPathsOf(platform).resolve(projectRoot);

const scopeOf = (paths: path.PlatformPath, directory: string): string => `${directory}${paths.sep}**`;

export const recordedNestedFile = (platform: NodeJS.Platform, filePath: string, text: string): LoadedInstructionFile => {
  const paths = instructionPathsOf(platform);
  return loadedFile(filePath, filePath, 'nested', scopeOf(paths, paths.dirname(filePath)), text);
};

export const nestedInstructionCandidates = (roots: readonly string[], projectRoot: string, touchedPaths: readonly TouchedPath[], platform: NodeJS.Platform): string[] => {
  const paths = instructionPathsOf(platform);
  const candidates = new Set<string>();
  for (const touched of touchedPaths) {
    const normalized = paths.resolve(touched.path);
    const root = roots.find((entry) => containsByComponents({ existing: entry, tail: [] }, { existing: normalized, tail: [] }, false, paths));
    if (root === undefined) continue;
    const segments = paths.relative(root, normalized).split(paths.sep).filter((segment) => segment !== '');
    const depth = touched.kind === 'file' ? segments.length - 1 : segments.length;
    for (let length = 1; length <= depth; length += 1) {
      candidates.add(paths.join(projectRoot, ...segments.slice(0, length), FILE_NAME));
    }
  }
  return [...candidates];
};

export const discoverInstructions = async (options: DiscoverOptions): Promise<DiscoveredInstructions> => {
  const { reader, home, trusted, touchedPaths } = options;
  const paths = instructionPathsOf(reader.platform);
  const projectRoot = projectRootOf(reader.platform, options.projectRoot);
  const realRoot = await reader.realpath(projectRoot);
  if (realRoot === undefined) throw new Error(`project root ${projectRoot} does not exist`);
  const notices: ContextNotice[] = [];

  const userPath = paths.join(homeLayout(home, reader.platform).root, FILE_NAME);
  const userFile = await reader.read(userPath);
  const user =
    userFile === undefined ? undefined : loadedFile(userPath, userFile.realPath, 'user', 'all projects', userFile.text);

  const readInProject = async (filePath: string): Promise<{ realPath: string; text: string } | undefined> => {
    const file = await reader.read(filePath);
    if (file === undefined) return undefined;
    if (!(await reader.contains(realRoot, file.realPath))) {
      notices.push({
        code: 'instructions_outside_project',
        message: `${filePath} resolves to ${file.realPath}, outside the project, and was ignored`,
      });
      return undefined;
    }
    return file;
  };

  const rootPath = paths.join(projectRoot, FILE_NAME);
  let root: LoadedInstructionFile | undefined;
  if (trusted) {
    const file = await readInProject(rootPath);
    if (file !== undefined) root = loadedFile(rootPath, file.realPath, 'root', scopeOf(paths, projectRoot), file.text);
  } else if (await reader.exists(rootPath)) {
    notices.push({
      code: 'root_instructions_untrusted',
      message: `${rootPath} was skipped because the project is not trusted`,
    });
  }

  const nested: LoadedInstructionFile[] = [];
  const candidates = nestedInstructionCandidates([...new Set([projectRoot, realRoot])], projectRoot, touchedPaths, reader.platform);
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
    return { user, root, nested, notices, pinnedPaths: [userPath, rootPath], platform: reader.platform };
  }
  for (const candidate of candidates) {
    const file = await readInProject(candidate);
    if (file === undefined) continue;
    nested.push(loadedFile(candidate, file.realPath, 'nested', scopeOf(paths, paths.dirname(candidate)), file.text));
  }

  return { user, root, nested, notices, pinnedPaths: [userPath, rootPath], platform: reader.platform };
};
