import path from 'node:path';
import { canonicalJson, sha256Hex } from './canonical-json.ts';
import type { PathResolver } from './path-compare.ts';
import { FileRuleError, fileMatcherOf, parseExceptionPattern, parseFilePattern, testExpression, testFileMatcher } from './file-pattern.ts';
import type { Expression, FileMatcher, FilePattern, FilePatternContext } from './file-pattern.ts';
import { HOST_FLAVOUR, candidatePathOf, isNativeAbsolute, nativePathOf, patternPathOf, specifierOf } from './path-flavour.ts';
import type { PathFlavour } from './path-flavour.ts';
import { unresolvableReasonOf } from './path-resolution.ts';
import type { PathProbes, PathResolution, UnresolvableReason } from './path-resolution.ts';

export { FileRuleError } from './file-pattern.ts';

export type FileRuleAccess = 'read' | 'write';
export type FileRuleEffect = 'deny' | 'ask' | 'allow';
export type FileRuleProvenance = { ruleText: string; layer: 'user' | 'project' | 'local' | 'cli' | 'protected'; source: string };

export type FileRuleSpec = {
  ruleIndex: number;
  tool: 'Read' | 'Edit' | 'Glob' | 'Grep';
  access: FileRuleAccess;
  effect: FileRuleEffect;
  specifier: string;
  exceptions: readonly string[];
  context: FilePatternContext;
  provenance: FileRuleProvenance;
};

export type FileRuleException = { exact: FileMatcher; subset: FileMatcher };

export type FileRuleEntry = {
  ruleIndex: number;
  tool: FileRuleSpec['tool'];
  access: FileRuleAccess;
  effect: FileRuleEffect;
  exact: FileMatcher;
  deny: FileMatcher;
  subset: FileMatcher;
  exactLexical: FileMatcher | null;
  denyLexical: FileMatcher | null;
  subsetLexical: FileMatcher | null;
  exceptions: readonly FileRuleException[];
  blockedAsWhole: boolean;
  anchorDirectory: string;
  lexicalDirectory: string;
  ignoreCase: boolean;
  widening: boolean;
  unresolved: UnresolvableReason | null;
  provenance: FileRuleProvenance;
};

export type FileRuleSet = { entries: readonly FileRuleEntry[]; exemptDirectory: string | null; fingerprint: string; flavour: PathFlavour };

export const fileRuleFingerprint = (specs: readonly FileRuleSpec[], roots: readonly string[], exemptDirectory: string | null): string =>
  sha256Hex(canonicalJson({ specs, roots, exemptDirectory }));

export const EMPTY_FILE_RULES: FileRuleSet = { entries: [], exemptDirectory: null, fingerprint: fileRuleFingerprint([], [], null), flavour: 'posix' };

const isWidening = (spec: FileRuleSpec, pattern: FilePattern): boolean => {
  if (spec.effect !== 'allow' || spec.access !== 'write') return false;
  if (spec.provenance.layer !== 'user' && spec.provenance.layer !== 'cli') return false;
  if (pattern.form === 'absolute' || pattern.form === 'home') return true;
  return pattern.form === 'settings' && spec.provenance.layer === 'user';
};

const describeReason = (reason: UnresolvableReason): string => (reason.kind === 'errno' ? reason.code : reason.kind);

const unresolvablePrefix = (spec: FileRuleSpec, directory: string, reason: UnresolvableReason): FileRuleError =>
  new FileRuleError(
    'unresolvable_prefix',
    describeReason(reason),
    `${spec.provenance.ruleText} (${spec.provenance.layer}: ${spec.provenance.source}): the directory ${directory} cannot be resolved (${describeReason(reason)})`,
    spec.provenance,
  );

const notExact = (spec: FileRuleSpec, what: string): FileRuleError =>
  new FileRuleError(
    'kernel_not_exact',
    'case_sensitive_volume',
    `${spec.provenance.ruleText} (${spec.provenance.layer}: ${spec.provenance.source}): ${what} cannot be enforced exactly by the sandbox on a case-sensitive volume`,
    spec.provenance,
  );

const lexicalDirectoryOf = (directory: string): string => path.posix.normalize(directory.normalize('NFC')).replace(/(.)\/$/, '$1');

const resolveBelowRegularFile = async (directory: string, canonicalise: PathProbes['canonicalise']): Promise<PathResolution> => {
  const first = await canonicalise(directory);
  if (first.ok || first.reason.kind !== 'errno' || first.reason.code !== 'ENOTDIR') return first;
  const parent = await resolveBelowRegularFile(path.posix.dirname(directory), canonicalise);
  return parent.ok ? { ok: true, path: path.posix.join(parent.path, path.posix.basename(directory)) } : parent;
};

const compileException = async (
  text: string,
  pattern: FilePattern,
  spec: FileRuleSpec,
  canonicalise: PathProbes['canonicalise'],
): Promise<FileRuleException> => {
  const root = pattern.root ?? spec.context.roots[0];
  const parsed = parseExceptionPattern(text, root as string, spec.effect);
  const resolution = await resolveBelowRegularFile(parsed.directory, canonicalise);
  if (!resolution.ok) throw unresolvablePrefix(spec, parsed.directory, resolution.reason);
  const directory = resolution.path.normalize('NFC');
  return { exact: fileMatcherOf(parsed, directory, 'exact'), subset: fileMatcherOf(parsed, directory, 'subset') };
};

export type RuleEnforcement = 'seatbelt-profile' | 'exact-paths';

export const ruleEnforcementOf = (sandboxKind: 'seatbelt' | 'bubblewrap' | 'none'): RuleEnforcement => (sandboxKind === 'seatbelt' ? 'seatbelt-profile' : 'exact-paths');

const compileEntry = async (
  spec: FileRuleSpec,
  pattern: FilePattern,
  canonicalise: PathProbes['canonicalise'],
  volumeProbe: PathProbes['volumeProbe'],
  flavour: PathFlavour,
  enforcement: RuleEnforcement,
): Promise<FileRuleEntry> => {
  const lexicalDirectory = lexicalDirectoryOf(pattern.directory);
  const resolution = await resolveBelowRegularFile(pattern.directory, canonicalise);
  if (!resolution.ok && spec.effect !== 'allow') throw unresolvablePrefix(spec, pattern.directory, resolution.reason);
  const anchorDirectory = resolution.ok ? resolution.path.normalize('NFC') : lexicalDirectory;
  const matchersAt = (directory: string) => ({
    exact: fileMatcherOf(pattern, directory, 'exact'),
    deny: fileMatcherOf(pattern, directory, 'deny'),
    subset: fileMatcherOf(pattern, directory, 'subset'),
  });
  const canonical = matchersAt(anchorDirectory);
  const lexical = anchorDirectory === lexicalDirectory ? null : matchersAt(lexicalDirectory);
  const widening = isWidening(spec, pattern);
  const caseInsensitive = resolution.ok ? flavour === 'win32' || (await volumeProbe(anchorDirectory)) : false;
  if (resolution.ok && !caseInsensitive && enforcement === 'seatbelt-profile') {
    if (widening) throw notExact(spec, 'a write allow rule that widens the sandbox');
    if (spec.exceptions.length > 0) throw notExact(spec, 'a rule with ! exceptions');
  }
  const ignoreCase = spec.effect !== 'allow' && caseInsensitive;
  const exceptions: FileRuleException[] = [];
  if (resolution.ok) for (const text of spec.exceptions) exceptions.push(await compileException(text, pattern, spec, canonicalise));
  const blockedAsWhole =
    canonical.exact.own.kind === 'subpath' && exceptions.every((exception) => !testFileMatcher(exception.exact, anchorDirectory, ignoreCase).own);
  return {
    ruleIndex: spec.ruleIndex,
    tool: spec.tool,
    access: spec.access,
    effect: spec.effect,
    exact: canonical.exact,
    deny: canonical.deny,
    subset: canonical.subset,
    exactLexical: lexical?.exact ?? null,
    denyLexical: lexical?.deny ?? null,
    subsetLexical: lexical?.subset ?? null,
    exceptions,
    blockedAsWhole,
    anchorDirectory,
    lexicalDirectory,
    ignoreCase,
    widening: resolution.ok && widening,
    unresolved: resolution.ok ? null : resolution.reason,
    provenance: spec.provenance,
  };
};

const inPatternSpace = (spec: FileRuleSpec, flavour: PathFlavour): FileRuleSpec => ({
  ...spec,
  specifier: specifierOf(flavour, spec.specifier),
  context: {
    ...spec.context,
    roots: spec.context.roots.map((root) => patternPathOf(flavour, root)),
    home: patternPathOf(flavour, spec.context.home),
    settingsRoot: patternPathOf(flavour, spec.context.settingsRoot),
  },
});

export const compileFileRuleSet = async (
  specs: readonly FileRuleSpec[],
  roots: readonly string[],
  exemptDirectory: string | null,
  canonicalise: PathProbes['canonicalise'],
  volumeProbe: PathProbes['volumeProbe'],
  flavour: PathFlavour,
  enforcement: RuleEnforcement,
): Promise<FileRuleSet> => {
  const inPattern = (resolution: PathResolution): PathResolution => (resolution.ok ? { ok: true, path: patternPathOf(flavour, resolution.path) } : resolution);
  const canonicaliseNative = async (absolute: string): Promise<PathResolution> => inPattern(await canonicalise(nativePathOf(flavour, absolute)));
  const probeNative = (directory: string): ReturnType<PathProbes['volumeProbe']> => volumeProbe(nativePathOf(flavour, directory));
  const entries: FileRuleEntry[] = [];
  for (const spec of specs) {
    const absolute = spec.exceptions.find((text) => isNativeAbsolute(flavour, text));
    if (absolute !== undefined) {
      throw new FileRuleError(
        'unsupported_pattern',
        'absolute_exception',
        `${spec.provenance.ruleText} (${spec.provenance.layer}: ${spec.provenance.source}): the ! pattern ${absolute} is a Windows absolute path, but a ! pattern names a path below the rule's own directory`,
        spec.provenance,
      );
    }
    const translated = inPatternSpace(spec, flavour);
    for (const pattern of parseFilePattern(translated.specifier, translated.context)) {
      entries.push(await compileEntry(translated, pattern, canonicaliseNative, probeNative, flavour, enforcement));
    }
  }
  return {
    entries,
    exemptDirectory: exemptDirectory === null ? null : patternPathOf(flavour, exemptDirectory.normalize('NFC')),
    fingerprint: fileRuleFingerprint(specs, roots, exemptDirectory),
    flavour,
  };
};

const ancestorsOrSelf = (target: string): string[] => {
  const found: string[] = [];
  for (let current = target; ; current = path.posix.dirname(current)) {
    found.push(current);
    if (current === path.posix.dirname(current)) return found;
  }
};

const matcherBlocks = (entry: FileRuleEntry, matcher: FileMatcher, candidate: string): boolean => {
  if (entry.exceptions.length === 0) {
    const verdict = testFileMatcher(matcher, candidate, entry.ignoreCase);
    return verdict.own || verdict.below;
  }
  return ancestorsOrSelf(candidate).some(
    (ancestor) =>
      testFileMatcher(matcher, ancestor, entry.ignoreCase).own &&
      !entry.exceptions.some((exception) => testFileMatcher(exception.exact, ancestor, entry.ignoreCase).own),
  );
};

const underExemption = (set: FileRuleSet, entry: FileRuleEntry, resolved: string): boolean => {
  if (set.exemptDirectory === null) return false;
  const exempt = entry.ignoreCase ? set.exemptDirectory.toLowerCase() : set.exemptDirectory;
  const target = entry.ignoreCase ? resolved.toLowerCase() : resolved;
  return target === exempt || target.startsWith(`${exempt}/`);
};

export type FileRuleForm = 'requested' | 'resolved';

export const fileRuleBlockingForm = (set: FileRuleSet, entry: FileRuleEntry, requestedNative: string, resolvedNative: string): FileRuleForm | undefined => {
  const requested = candidatePathOf(set.flavour, requestedNative);
  const resolved = candidatePathOf(set.flavour, resolvedNative);
  if (entry.unresolved !== null || underExemption(set, entry, resolved)) return undefined;
  const requestedHit = matcherBlocks(entry, entry.exactLexical ?? entry.exact, requested);
  const resolvedHit = matcherBlocks(entry, entry.exact, resolved);
  if (entry.effect === 'allow') return requestedHit && resolvedHit ? 'requested' : undefined;
  if (requestedHit) return 'requested';
  return resolvedHit ? 'resolved' : undefined;
};

export const fileRuleBlocks = (set: FileRuleSet, entry: FileRuleEntry, requestedNative: string, resolvedNative: string): boolean =>
  fileRuleBlockingForm(set, entry, requestedNative, resolvedNative) !== undefined;

export type WritableArea = { roots: readonly string[]; widening: readonly Expression[] };

export const writableAreaOf = ({ writableRoots, entries }: { writableRoots: readonly string[]; entries: readonly FileRuleEntry[] }): WritableArea => ({
  roots: writableRoots.map((root) => root.normalize('NFC')),
  widening: entries.filter((entry) => entry.widening && entry.unresolved === null).map((entry) => entry.subset.closure),
});

export const lexicallyWithin = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export const inWritableArea = async (area: WritableArea, candidate: string, mode: 'canonical' | 'lexical', paths: Pick<PathResolver, 'comparableContains'>): Promise<boolean> => {
  const normalised = candidate.normalize('NFC');
  for (const root of area.roots) {
    if (mode === 'canonical' ? await paths.comparableContains(root, normalised) : lexicallyWithin(normalised, root)) return true;
  }
  return area.widening.some((expression) => testExpression(expression, normalised, false));
};

export const writableCheckOf =
  (area: WritableArea, paths: Pick<PathResolver, 'comparableContains'>) =>
  async (entry: string): Promise<boolean> => {
    try {
      return await inWritableArea(area, entry, 'canonical', paths);
    } catch (error) {
      if (unresolvableReasonOf(error) === undefined) throw error;
      return true;
    }
  };
