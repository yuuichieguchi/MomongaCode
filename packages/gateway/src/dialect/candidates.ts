import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { BUILTIN_DIALECTS, BUILTIN_DIALECT_IDS, DEFAULT_DIALECT_ID } from '@momonga/protocol';
import type { DialectDefinition, DialectId, ProbeReportDialect } from '@momonga/protocol';
import type { UserDialects } from './choice.ts';
import { definitionOf } from './resolve.ts';

export type DialectCurrency = { userDialects: UserDialects; probeMethod: number; declaredDialect?: DialectId };

const isNarrowing = (rule: DialectDefinition['rules'][number]): boolean => {
  switch (rule.op) {
    case 'fill-type':
    case 'require-all':
    case 'empty-parameters':
    case 'drop':
    case 'nullable-optional':
      return true;
    case 'ensure-key':
      return rule.key === 'additionalProperties' && rule.value === false;
    default:
      return false;
  }
};

const narrowingCount = (id: (typeof BUILTIN_DIALECT_IDS)[number]): number => BUILTIN_DIALECTS[id].rules.filter(isNarrowing).length;

const builtinOrder = (): DialectId[] => {
  const others = BUILTIN_DIALECT_IDS.filter((id) => id !== DEFAULT_DIALECT_ID).sort((left, right) => narrowingCount(left) - narrowingCount(right) || (left < right ? -1 : 1));
  return [DEFAULT_DIALECT_ID, ...others];
};

export const candidateIds = (userDialects: UserDialects, declaredDialect?: DialectId): DialectId[] =>
  declaredDialect === undefined ? [...builtinOrder(), ...Object.keys(userDialects)] : [declaredDialect];

export const dialectsDigest = (report: Pick<ProbeReportDialect, 'selected'>, currency: DialectCurrency): string | undefined => {
  const ids = candidateIds(currency.userDialects, currency.declaredDialect);
  const { selected } = report;
  const through = selected === null ? ids : ids.slice(0, ids.indexOf(selected) + 1);
  if (selected !== null && through.length === 0) return undefined;
  return sha256Hex(canonicalJson(through.map((id) => definitionOf(id, currency.userDialects))));
};
