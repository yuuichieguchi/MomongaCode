import path from 'node:path';
import type { UnresolvableReason } from '@momonga/foundation';
import type { ParsedOption } from './argv.ts';

export type Target =
  | { literal: string; removes?: true; needsApproval?: true }
  | { worktree: true; removes: true; below?: string }
  | { candidate: string; removes?: true }
  | { unresolvable: UnresolvableReason };

export type CwdEffect = 'none' | 'changed' | 'root-changed';

const EFFECT_STRENGTH: Readonly<Record<CwdEffect, number>> = { none: 0, changed: 1, 'root-changed': 2 };

export const strongerEffect = (left: CwdEffect, right: CwdEffect): CwdEffect => (EFFECT_STRENGTH[left] >= EFFECT_STRENGTH[right] ? left : right);

const isHomeRelative = (text: string): boolean => text === '~' || text.startsWith('~/');

const isCwdRelative = (text: string): boolean => !path.isAbsolute(text) && !text.startsWith('~');

export const DYNAMIC: Target = { unresolvable: { kind: 'dynamic' } };

export const targetOfText = (text: string | null): Target => {
  if (text === null) return DYNAMIC;
  if (text.startsWith('~') && !isHomeRelative(text)) return { unresolvable: { kind: 'other-user-home' } };
  return { literal: text };
};

export const markRelativeUnresolvable = (targets: readonly Target[], effect: CwdEffect): Target[] => {
  if (effect === 'none') return [...targets];
  return targets.map((target): Target => {
    if ('unresolvable' in target) return target;
    if (effect === 'root-changed') return { unresolvable: { kind: 'root-changed' } };
    if ('worktree' in target) return { unresolvable: { kind: 'cwd-changed' } };
    const text = 'literal' in target ? target.literal : target.candidate;
    return isCwdRelative(text) ? { unresolvable: { kind: 'cwd-changed' } } : target;
  });
};

const CONFIG_OVERRIDE_UNRESOLVABLE: Target = { unresolvable: { kind: 'config-override' } };

export const markConfigOverride = (targets: readonly Target[]): Target[] =>
  targets.flatMap((target): Target[] => {
    if ('unresolvable' in target) return [target];
    if (!('worktree' in target)) {
      const text = 'literal' in target ? target.literal : target.candidate;
      if (!isCwdRelative(text)) return [target];
    }
    return target.removes === true ? [target, CONFIG_OVERRIDE_UNRESOLVABLE] : [CONFIG_OVERRIDE_UNRESOLVABLE];
  });

export const describeReason = (reason: UnresolvableReason): string => (reason.kind === 'errno' ? reason.code : reason.kind);

export const targetOfOption = (option: ParsedOption): Target => (option.dynamic === true || option.value === undefined ? DYNAMIC : targetOfText(option.value));
