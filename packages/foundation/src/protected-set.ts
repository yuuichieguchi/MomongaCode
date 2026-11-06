import path from 'node:path';
import { EMPTY_FILE_RULES, compileFileRuleSet, fileRuleBlocks, lexicallyWithin } from './file-rules.ts';
import type { FileRuleSet, FileRuleSpec } from './file-rules.ts';
import { containsByComponents, walkPath } from './path-compare.ts';
import { flavourOf, patternPathOf } from './path-flavour.ts';
import type { PathFlavour } from './path-flavour.ts';
import type { StepReader, WalkResult } from './path-compare.ts';
import type { PathResolution, Unresolved, UnresolvableReason } from './path-resolution.ts';

export const MAX_POINTER_FILE_BYTES = 1033;

const GIT_NAME = '.git';
const COMMONDIR_NAME = 'commondir';
const GITDIR_PREFIX = 'gitdir: ';
const WORKSPACE_CONTROL_NAMES = ['.momonga', '.mcp.json', '.envrc', '.vscode', '.idea'] as const;
const GIT_DIRECTORY_ENTRIES = ['hooks', 'config', 'config.worktree', COMMONDIR_NAME] as const;
const NESTED_GIT_DIRECTORY_PATTERNS = [
  { anchor: 'modules', pattern: 'modules/**/hooks' },
  { anchor: 'modules', pattern: 'modules/**/config' },
  { anchor: 'modules', pattern: 'modules/**/config.worktree' },
  { anchor: 'worktrees', pattern: 'worktrees/*/config.worktree' },
] as const;
const PROTECTED_NAMES = [GIT_NAME] as const;
const PATTERN_PROVENANCE = { ruleText: 'protected set', layer: 'protected', source: 'momonga' } as const;
const PATTERN_ENFORCEMENT = 'exact-paths' as const;
const EMPTY_FILE_FORM: PlaceholderForm = { kind: 'file', bytes: '' };
const COMMONDIR_FORM: PlaceholderForm = { kind: 'file', bytes: '.\n' };
const DIRECTORY_FORM: PlaceholderForm = { kind: 'directory' };
const GLOB_CHARACTERS = /[\\*?[]/g;

export type EntryRead =
  | { kind: 'absent' }
  | { kind: 'directory'; canonical: string }
  | { kind: 'file'; text: string }
  | { kind: 'oversize' }
  | Unresolved;

export type GitEntryReader = (absolutePath: string) => EntryRead;

export type ProtectedSetPorts = {
  readEntry: GitEntryReader;
  readNoFollow: StepReader;
  canonicalise: (absolute: string) => PathResolution;
  volumeProbe: (directory: string) => boolean;
  platform: NodeJS.Platform;
};

export type GitPointerIssue = {
  root: string;
  file: string;
  problem: 'malformed' | 'oversize' | 'missing-target' | 'unresolvable';
  reason?: UnresolvableReason;
};

export type PlaceholderForm = { kind: 'file'; bytes: string } | { kind: 'directory' };

export type ProtectedSet = {
  forms: Readonly<Record<string, PlaceholderForm>>;
  roots: readonly string[];
  paths: readonly string[];
  lexicalPaths: readonly string[];
  literals: readonly string[];
  names: readonly string[];
  moduleAnchors: readonly string[];
  worktreeAnchors: readonly string[];
  patterns: FileRuleSet;
  issues: readonly GitPointerIssue[];
};

export const EMPTY_PROTECTED_SET: ProtectedSet = {
  forms: {},
  roots: [],
  paths: [],
  lexicalPaths: [],
  literals: [],
  names: [],
  moduleAnchors: [],
  worktreeAnchors: [],
  patterns: EMPTY_FILE_RULES,
  issues: [],
};

const controlPathsOf = (root: string): string[] => WORKSPACE_CONTROL_NAMES.map((name) => path.join(root, name));

export const defaultProtectedPaths = (root: string): string[] => [
  path.join(root, GIT_NAME, 'hooks'),
  path.join(root, GIT_NAME, 'config'),
  ...controlPathsOf(root),
];

type Collected = {
  forms: Map<string, PlaceholderForm>;
  paths: Set<string>;
  lexicalPaths: Set<string>;
  literals: Set<string>;
  moduleAnchors: Set<string>;
  worktreeAnchors: Set<string>;
  patternSpecifiers: Set<string>;
  issues: GitPointerIssue[];
};

const stripLineEnd = (text: string): string => text.replace(/[\r\n]+$/, '').split('\0', 1)[0] as string;

export const gitFileTarget = (text: string): string | undefined => {
  const body = stripLineEnd(text);
  const target = body.startsWith(GITDIR_PREFIX) ? body.slice(GITDIR_PREFIX.length) : '';
  return target === '' ? undefined : target;
};

export const commondirTarget = (text: string): string | undefined => {
  const target = stripLineEnd(text);
  return target === '' ? undefined : target;
};

const componentsOf = (value: string, flavour: PathFlavour): string[] => value.split(flavour === 'win32' ? /[\\/]/ : '/').filter((component) => component !== '');

const lexicallyContains = (base: string, candidate: string, fold: boolean, flavour: PathFlavour): boolean =>
  containsByComponents({ existing: '/', tail: componentsOf(base, flavour) }, { existing: '/', tail: componentsOf(candidate, flavour) }, fold);

const entriesOf = (directory: string, names: readonly string[]): string[] => names.map((name) => path.join(directory, name));

const declareEntries = (collected: Collected, directory: string, names: readonly string[]): void => {
  for (const entry of entriesOf(directory, names)) {
    collected.paths.add(entry);
    collected.forms.set(entry, path.basename(entry) === COMMONDIR_NAME ? COMMONDIR_FORM : EMPTY_FILE_FORM);
  }
};

const parentCanonicalForm = (entry: string, canonicalise: (absolute: string) => PathResolution): string => {
  const parent = canonicalise(path.dirname(entry));
  return parent.ok ? path.join(parent.path, path.basename(entry)) : entry;
};

const obstaclesOf = (target: string, ports: ProtectedSetPorts): string[] => {
  const links: string[] = [];
  const result: WalkResult<Unresolved> = walkPath(
    target,
    (absolute) => {
      const read = ports.readNoFollow(absolute);
      return 'unresolvable' in read ? { stepFailure: read } : read;
    },
    (name) => links.push(name),
  );
  if (result.ok) return links;
  if ('failure' in result) return result.failure.reason.code === 'ENOTDIR' ? [...links, result.failure.candidate] : links;
  const reason = result.stepFailure.unresolvable;
  return reason.kind === 'errno' && reason.code === 'EACCES' ? [...links, result.prefix] : links;
};

const pinObstacles = (roots: readonly string[], ports: ProtectedSetPorts, collected: Collected, target: string): void => {
  for (const obstacle of obstaclesOf(target, ports)) {
    if (!roots.some((root) => lexicallyWithin(obstacle, root))) continue;
    collected.literals.add(obstacle);
    collected.literals.add(parentCanonicalForm(obstacle, ports.canonicalise));
  }
};

const protectUnresolvable = (
  roots: readonly string[],
  ports: ProtectedSetPorts,
  collected: Collected,
  issue: { root: string; file: string },
  target: string,
  reason: UnresolvableReason,
): void => {
  collected.lexicalPaths.add(target);
  collected.issues.push({ ...issue, problem: 'unresolvable', reason });
  pinObstacles(roots, ports, collected, target);
};

const escapeGlob = (value: string): string => value.replace(GLOB_CHARACTERS, '\\$&');

const registerCommonDirectory = (
  roots: readonly string[],
  ports: ProtectedSetPorts,
  collected: Collected,
  issue: { root: string; file: string },
  commonDir: string,
): void => {
  for (const anchor of new Set(NESTED_GIT_DIRECTORY_PATTERNS.map((entry) => entry.anchor))) {
    const directory = path.join(commonDir, anchor);
    const resolution = ports.canonicalise(directory);
    if (!resolution.ok) {
      protectUnresolvable(roots, ports, collected, issue, directory, resolution.reason);
      continue;
    }
    (anchor === 'modules' ? collected.moduleAnchors : collected.worktreeAnchors).add(resolution.path);
    for (const { pattern } of NESTED_GIT_DIRECTORY_PATTERNS.filter((entry) => entry.anchor === anchor)) {
      collected.patternSpecifiers.add(`//${escapeGlob(patternPathOf(flavourOf(ports.platform), commonDir).slice(1))}/${pattern}`);
    }
  }
};

type PointerContext = {
  roots: readonly string[];
  ports: ProtectedSetPorts;
  collected: Collected;
  root: string;
};

const readCommonDirectory = (context: PointerContext, gitDir: string): string | undefined => {
  const { roots, ports, collected, root } = context;
  const commonFile = path.join(gitDir, COMMONDIR_NAME);
  const read = ports.readEntry(commonFile);
  if ('unresolvable' in read) {
    collected.issues.push({ root, file: commonFile, problem: 'unresolvable', reason: read.unresolvable });
    collected.paths.add(gitDir);
    return undefined;
  }
  switch (read.kind) {
    case 'absent':
      return gitDir;
    case 'oversize':
      collected.issues.push({ root, file: commonFile, problem: 'oversize' });
      collected.paths.add(gitDir);
      return undefined;
    case 'directory':
      collected.issues.push({ root, file: commonFile, problem: 'malformed' });
      collected.paths.add(gitDir);
      return undefined;
    case 'file': {
      const text = commondirTarget(read.text);
      if (text === undefined) {
        collected.issues.push({ root, file: commonFile, problem: 'malformed' });
        collected.paths.add(gitDir);
        return undefined;
      }
      const target = path.resolve(gitDir, text);
      const resolution = ports.canonicalise(target);
      if (!resolution.ok) {
        protectUnresolvable(roots, ports, collected, { root, file: commonFile }, target, resolution.reason);
        return undefined;
      }
      const commonRead = ports.readEntry(resolution.path);
      if ('unresolvable' in commonRead) {
        collected.issues.push({ root, file: commonFile, problem: 'unresolvable', reason: commonRead.unresolvable });
        collected.paths.add(resolution.path);
        return undefined;
      }
      if (commonRead.kind !== 'directory') {
        collected.issues.push({ root, file: commonFile, problem: 'missing-target' });
        collected.paths.add(resolution.path);
        return undefined;
      }
      return commonRead.canonical;
    }
  }
};

const followGitFile = (context: PointerContext, pointer: string, text: string): void => {
  const { roots, ports, collected, root } = context;
  const target = path.resolve(path.dirname(pointer), text);
  const resolution = ports.canonicalise(target);
  if (!resolution.ok) {
    protectUnresolvable(roots, ports, collected, { root, file: pointer }, target, resolution.reason);
    return;
  }
  const read = ports.readEntry(resolution.path);
  if ('unresolvable' in read) {
    collected.issues.push({ root, file: pointer, problem: 'unresolvable', reason: read.unresolvable });
    collected.paths.add(resolution.path);
    return;
  }
  if (read.kind !== 'directory') {
    collected.issues.push({ root, file: pointer, problem: 'missing-target' });
    collected.paths.add(resolution.path);
    return;
  }
  const gitDir = read.canonical;
  declareEntries(collected, gitDir, ['config.worktree', COMMONDIR_NAME, 'gitdir']);
  const commonDir = readCommonDirectory(context, gitDir);
  if (commonDir === undefined) return;
  declareEntries(collected, commonDir, ['hooks', 'config']);
  registerCommonDirectory(roots, ports, collected, { root, file: pointer }, commonDir);
};

const collectRoot = (roots: readonly string[], ports: ProtectedSetPorts, collected: Collected, root: string): void => {
  const pointer = path.join(root, GIT_NAME);
  declareEntries(collected, root, WORKSPACE_CONTROL_NAMES);
  const read = ports.readEntry(pointer);
  if ('unresolvable' in read) {
    protectUnresolvable(roots, ports, collected, { root, file: pointer }, pointer, read.unresolvable);
    collected.literals.add(pointer);
    collected.literals.add(parentCanonicalForm(pointer, ports.canonicalise));
    return;
  }
  switch (read.kind) {
    case 'absent':
    case 'directory': {
      const gitDir = read.kind === 'directory' ? read.canonical : pointer;
      if (read.kind === 'directory') pinObstacles(roots, ports, collected, pointer);
      declareEntries(collected, gitDir, GIT_DIRECTORY_ENTRIES);
      collected.forms.set(pointer, DIRECTORY_FORM);
      registerCommonDirectory(roots, ports, collected, { root, file: pointer }, gitDir);
      return;
    }
    case 'oversize':
      collected.paths.add(pointer);
      collected.issues.push({ root, file: pointer, problem: 'oversize' });
      return;
    case 'file': {
      collected.paths.add(pointer);
      const text = gitFileTarget(read.text);
      if (text === undefined) collected.issues.push({ root, file: pointer, problem: 'malformed' });
      else followGitFile({ roots, ports, collected, root }, pointer, text);
      return;
    }
  }
};

const patternSpecsOf = (specifiers: readonly string[], roots: readonly string[]): FileRuleSpec[] =>
  specifiers.map((specifier, ruleIndex) => ({
    ruleIndex,
    tool: 'Edit',
    access: 'write',
    effect: 'deny',
    specifier,
    exceptions: [],
    context: { roots, home: '/', settingsRoot: '/', effect: 'deny' },
    provenance: PATTERN_PROVENANCE,
  }));

export const protectedSetFor = (roots: readonly string[], ports: ProtectedSetPorts): ProtectedSet => {
  const collected: Collected = {
    forms: new Map(),
    paths: new Set(),
    lexicalPaths: new Set(),
    literals: new Set(),
    moduleAnchors: new Set(),
    worktreeAnchors: new Set(),
    patternSpecifiers: new Set(),
    issues: [],
  };
  for (const root of roots) collectRoot(roots, ports, collected, root);
  for (const root of roots) {
    const rootPattern = escapeGlob(patternPathOf(flavourOf(ports.platform), root).slice(1));
    for (const name of PROTECTED_NAMES) for (const entry of GIT_DIRECTORY_ENTRIES) collected.patternSpecifiers.add(`//${rootPattern}/**/${escapeGlob(name)}/${entry}`);
  }
  const patterns = compileFileRuleSet(patternSpecsOf([...collected.patternSpecifiers], roots), roots, null, ports.canonicalise, ports.volumeProbe, flavourOf(ports.platform), PATTERN_ENFORCEMENT);
  const forms: Record<string, PlaceholderForm> = Object.fromEntries([...[...collected.paths].map((entry): [string, PlaceholderForm] => [entry, EMPTY_FILE_FORM]), ...collected.forms]);
  return {
    forms,
    roots: [...roots],
    paths: [...collected.paths],
    lexicalPaths: [...collected.lexicalPaths],
    literals: [...collected.literals],
    names: [...PROTECTED_NAMES],
    moduleAnchors: [...collected.moduleAnchors],
    worktreeAnchors: [...collected.worktreeAnchors],
    patterns,
    issues: collected.issues,
  };
};

type Probes = { canonicalise: (absolute: string) => PathResolution; volumeProbe: (directory: string) => boolean };

const foldedEqual = (left: string, right: string, fold: boolean): boolean => (fold ? left.toLowerCase() === right.toLowerCase() : left === right);

export const isProtectedWrite = (set: ProtectedSet, canonicalTarget: string, probes: Probes): boolean => {
  const flavour = set.patterns.flavour;
  const fold = flavour === 'win32' || probes.volumeProbe(canonicalTarget);
  const coveredByPath = (entry: string): boolean => {
    const resolution = probes.canonicalise(entry);
    return lexicallyContains(resolution.ok ? resolution.path : entry, canonicalTarget, fold, flavour);
  };
  if (set.paths.some(coveredByPath)) return true;
  if (set.lexicalPaths.some((entry) => lexicallyContains(entry, canonicalTarget, fold, flavour))) return true;
  const literalMatches = (entry: string): boolean =>
    foldedEqual(entry, canonicalTarget, fold) || foldedEqual(parentCanonicalForm(entry, probes.canonicalise), canonicalTarget, fold);
  if (set.literals.some(literalMatches)) return true;
  const names = set.names.map((name) => (fold ? name.toLowerCase() : name));
  const underNamedComponent = set.roots.some((root) => {
    if (!lexicallyContains(root, canonicalTarget, fold, flavour)) return false;
    const inside = componentsOf(canonicalTarget, flavour).slice(componentsOf(root, flavour).length);
    return inside.some((component) => names.includes(fold ? component.toLowerCase() : component));
  });
  if (underNamedComponent) return true;
  return set.patterns.entries.some((entry) => fileRuleBlocks(set.patterns, entry, canonicalTarget, canonicalTarget));
};
