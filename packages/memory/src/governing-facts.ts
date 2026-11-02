import path from 'node:path';
import type { GoverningFactView } from '@momonga/protocol';
import { scopeKeyOf } from './resolve-governing.ts';

export type GoverningFactRefusalCode =
  | 'empty_target'
  | 'allow_enforcement'
  | 'invalid_rule'
  | 'supersedes_outside_group'
  | 'duplicate_live_fact'
  | 'absolute_path_glob';

export type GoverningFactCheck = { ok: true } | { ok: false; code: GoverningFactRefusalCode; message: string };

export type RuleSizeTarget = { target: string; contextWindow: number };

export type RuleSizeEntry = RuleSizeTarget & { tokens: number; percent: number };

export const normalizeTarget = (raw: string): string => raw.trim().toLowerCase().split(/\s+/).join('-');

const refuse = (code: GoverningFactRefusalCode, message: string): GoverningFactCheck => ({ ok: false, code, message });

export const checkGoverningFact = (
  fact: GoverningFactView,
  context: { existing: readonly GoverningFactView[]; parses: (rule: string) => boolean },
): GoverningFactCheck => {
  if (fact.target === '') return refuse('empty_target', 'a governing fact needs a target');
  const { enforcement } = fact;
  if (enforcement !== null) {
    const behavior: string = enforcement.behavior;
    if (behavior === 'allow') return refuse('allow_enforcement', 'a rule can only restrict: enforcement must be deny or ask, never allow');
    if (!context.parses(enforcement.rule)) return refuse('invalid_rule', `the enforcement rule ${JSON.stringify(enforcement.rule)} is not a valid permission rule`);
  }
  if (fact.scope.level === 'project') {
    const absolute = fact.scope.paths.find((glob) => path.isAbsolute(glob));
    if (absolute !== undefined) return refuse('absolute_path_glob', `the path glob ${JSON.stringify(absolute)} is absolute, but a glob is matched against paths relative to the project, so it could never match`);
  }
  const group = scopeKeyOf(fact.scope);
  for (const id of fact.supersedes) {
    const replaced = context.existing.find((candidate) => candidate.id === id);
    if (replaced === undefined || replaced.target !== fact.target || scopeKeyOf(replaced.scope) !== group) {
      return refuse('supersedes_outside_group', `${id} is not a governing fact with the target ${fact.target} and the same scope`);
    }
  }
  const hidden = new Set([...context.existing.flatMap((candidate) => candidate.supersedes), ...fact.supersedes]);
  const repeated = context.existing.find(
    (candidate) => candidate.retiredAt === null && !hidden.has(candidate.id) && candidate.target === fact.target && scopeKeyOf(candidate.scope) === group && candidate.text === fact.text,
  );
  if (repeated !== undefined) return refuse('duplicate_live_fact', `${repeated.id} already states this for the same target and scope`);
  return { ok: true };
};

export const overlappingEnforced = (fact: GoverningFactView, facts: readonly GoverningFactView[]): GoverningFactView[] => {
  if (fact.enforcement !== null) return [];
  const replaced = new Set(facts.flatMap((candidate) => candidate.supersedes));
  return facts.filter((candidate) => candidate.enforcement !== null && candidate.retiredAt === null && candidate.target === fact.target && !replaced.has(candidate.id));
};

export const ruleSizeReport = (tokens: number, targets: readonly RuleSizeTarget[]): RuleSizeEntry[] =>
  targets.map(({ target, contextWindow }) => ({ target, contextWindow, tokens, percent: (tokens * 100) / contextWindow }));
