import path from 'node:path';
import { testFileMatcher } from '@momonga/foundation';
import type { FileMatcher, FileRuleEntry, FileRuleSet, PathResolution, ProtectedSet } from '@momonga/foundation';
import type { Bool, Re, Seq } from 'z3-solver';
import { singleton, subtractSets } from './char-set.ts';
import { literalNode, parseRegexSource } from './regex-source.ts';
import type { RegexDialect } from './regex-source.ts';
import type { Smt } from './smt.ts';

const SLASH = 0x2f;

export type PathProbes = {
  canonicalise: (absolute: string) => PathResolution;
  volumeProbe: (directory: string) => boolean;
};

export type PathModelContext = {
  smt: Smt;
  fileRules: FileRuleSet;
  protectedSet: ProtectedSet;
  roots: readonly string[];
  probes: PathProbes;
};

export type PathVariables = { requested: Seq; resolved: Seq; domain: readonly Bool[] };

export type PathModel = {
  variables(name: string): PathVariables;
  ruleMatches(variables: PathVariables, ruleIndex: number): Bool;
  protectedWrite(resolved: Seq): Bool;
  inside(resolved: Seq): Bool;
  under(resolved: Seq, directory: string): Bool;
  canonicalDirectory(directory: string): PathResolution;
  aliases: ReadonlyArray<{ lexical: string; canonical: string }>;
};

const dialectOf = (smt: Smt, ignoreCase: boolean): RegexDialect => ({ alphabet: smt.alphabet, ignoreCase });

export const createPathModel = (context: PathModelContext): PathModel => {
  const { smt, fileRules, protectedSet, roots, probes } = context;
  const rest = smt.concat(smt.chars(singleton(SLASH)), smt.anyString);
  const slash = smt.chars(singleton(SLASH));
  const segmentChars = smt.chars(subtractSets(smt.alphabet, singleton(SLASH)));
  const segment = smt.difference(smt.plus(segmentChars), smt.union(smt.text('.'), smt.text('..')));
  const pathLanguage = smt.union(slash, smt.plus(smt.concat(slash, segment)));

  const textIn = (value: string, ignoreCase: boolean): Re => smt.regex(literalNode(value, dialectOf(smt, ignoreCase)));
  const subtree = (directory: string, ignoreCase: boolean): Re =>
    directory === '/' ? smt.concat(slash, smt.anyString) : smt.concat(textIn(directory, ignoreCase), smt.optional(rest));

  const expressionLanguage = (expression: FileMatcher['own'], ignoreCase: boolean): Re => {
    switch (expression.kind) {
      case 'none':
        return smt.noString;
      case 'subpath':
        return subtree(expression.path, ignoreCase);
      case 'regex':
        return smt.regex(parseRegexSource(expression.source, dialectOf(smt, ignoreCase)));
    }
  };

  const matcherLanguage = (entry: FileRuleEntry, matcher: FileMatcher): Re => {
    const own = expressionLanguage(matcher.own, entry.ignoreCase);
    if (entry.exceptions.length === 0) return smt.union(own, expressionLanguage(matcher.below, entry.ignoreCase));
    const exceptionOwn = smt.union(...entry.exceptions.map((exception) => expressionLanguage(exception.exact.own, entry.ignoreCase)));
    const ancestor = smt.concat(smt.difference(own, exceptionOwn), smt.optional(rest));
    const rootQualifies =
      testFileMatcher(matcher, '/', entry.ignoreCase).own && !entry.exceptions.some((exception) => testFileMatcher(exception.exact, '/', entry.ignoreCase).own);
    return rootQualifies ? smt.union(ancestor, smt.concat(slash, smt.anyString)) : ancestor;
  };

  const entryBlocks = (set: FileRuleSet, entry: FileRuleEntry, requested: Seq, resolved: Seq): Bool => {
    const ctx = smt.ctx;
    if (entry.unresolved !== null) return ctx.Bool.val(false);
    const exempt = set.exemptDirectory === null ? undefined : subtree(set.exemptDirectory, entry.ignoreCase);
    const requestedHit = smt.member(requested, matcherLanguage(entry, entry.exactLexical ?? entry.exact));
    const resolvedHit = smt.member(resolved, matcherLanguage(entry, entry.exact));
    const hit = entry.effect === 'allow' ? ctx.And(requestedHit, resolvedHit) : ctx.Or(requestedHit, resolvedHit);
    return exempt === undefined ? hit : ctx.And(ctx.Not(smt.member(resolved, exempt)), hit);
  };

  const aliasTable = new Map<string, string>();
  for (const entry of fileRules.entries) {
    if (entry.unresolved === null && entry.lexicalDirectory !== entry.anchorDirectory) aliasTable.set(entry.lexicalDirectory, entry.anchorDirectory);
  }
  const aliases = [...aliasTable].map(([lexical, canonical]) => ({ lexical, canonical }));

  const variables = (name: string): PathVariables => {
    const ctx = smt.ctx;
    const base = smt.stringVariable(`${name}_path`);
    const domain: Bool[] = [smt.member(base, pathLanguage)];
    let requested: Seq = base;
    let resolved: Seq = base;
    aliases.forEach((alias, index) => {
      const via = ctx.Bool.const(`${name}_via_${index}`);
      const tail = smt.stringVariable(`${name}_tail_${index}`);
      domain.push(ctx.Implies(via, smt.member(tail, smt.optional(rest))));
      requested = ctx.If(via, smt.stringValue(alias.lexical).concat(tail), requested);
      resolved = ctx.If(via, smt.stringValue(alias.canonical).concat(tail), resolved);
    });
    domain.push(smt.member(resolved, pathLanguage), smt.member(requested, pathLanguage));
    return { requested, resolved, domain };
  };

  const ruleMatches = (vars: PathVariables, ruleIndex: number): Bool => {
    const ctx = smt.ctx;
    const blocks = fileRules.entries.filter((entry) => entry.ruleIndex === ruleIndex).map((entry) => entryBlocks(fileRules, entry, vars.requested, vars.resolved));
    return blocks.length === 0 ? ctx.Bool.val(false) : ctx.Or(...blocks);
  };

  const foldOf = (probePath: string): boolean => probes.volumeProbe(probePath);

  const under = (resolved: Seq, directory: string): Bool => smt.member(resolved, subtree(directory, foldOf(directory)));

  const canonicalRoots = roots.flatMap((root) => {
    const resolution = probes.canonicalise(root);
    return resolution.ok ? [resolution.path] : [];
  });

  const inside = (resolved: Seq): Bool => {
    const ctx = smt.ctx;
    return canonicalRoots.length === 0 ? ctx.Bool.val(false) : ctx.Or(...canonicalRoots.map((root) => under(resolved, root)));
  };

  const isEmptyProtected =
    protectedSet.paths.length === 0 &&
    protectedSet.lexicalPaths.length === 0 &&
    protectedSet.literals.length === 0 &&
    protectedSet.names.length === 0 &&
    protectedSet.patterns.entries.length === 0;

  const parentCanonicalForm = (entry: string): string => {
    const parent = probes.canonicalise(path.dirname(entry));
    return parent.ok ? path.join(parent.path, path.basename(entry)) : entry;
  };

  const protectedWrite = (resolved: Seq): Bool => {
    const ctx = smt.ctx;
    if (isEmptyProtected) return ctx.Bool.val(false);
    const clauses: Bool[] = [];
    for (const entry of protectedSet.paths) {
      const resolution = probes.canonicalise(entry);
      clauses.push(under(resolved, resolution.ok ? resolution.path : entry));
    }
    for (const entry of protectedSet.lexicalPaths) clauses.push(under(resolved, entry));
    for (const entry of protectedSet.literals) {
      const fold = foldOf(entry);
      clauses.push(smt.member(resolved, smt.union(textIn(entry, fold), textIn(parentCanonicalForm(entry), fold))));
    }
    for (const root of protectedSet.roots) {
      const fold = foldOf(root);
      const prefix = root === '/' ? smt.emptyString : textIn(root, fold);
      const names = smt.union(...protectedSet.names.map((name) => textIn(name, fold)));
      const nested = smt.concat(prefix, smt.star(smt.concat(slash, segment)), slash, names, smt.optional(rest));
      clauses.push(smt.member(resolved, nested));
    }
    for (const entry of protectedSet.patterns.entries) clauses.push(entryBlocks(protectedSet.patterns, entry, resolved, resolved));
    return clauses.length === 0 ? ctx.Bool.val(false) : ctx.Or(...clauses);
  };

  return { variables, ruleMatches, protectedWrite, inside, under, canonicalDirectory: probes.canonicalise, aliases };
};
