import type { GoverningFactView, PolicyGovernanceResponse, RuleAddResponse } from '@momonga/protocol';

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

const iso = (ms: number): string => new Date(ms).toISOString();

const placeOf = (fact: GoverningFactView): string =>
  fact.scope.level === 'user' ? 'user' : `project ${fact.scope.project}${fact.scope.paths.length === 0 ? '' : ` ${fact.scope.paths.join(',')}`}`;

const enforcementOf = (fact: GoverningFactView): string =>
  fact.enforcement === null ? 'text-only' : `enforced: ${fact.enforcement.behavior} ${fact.enforcement.rule}`;

const validityOf = (fact: GoverningFactView): string =>
  [
    `from ${iso(fact.validFrom)}`,
    ...(fact.validUntil === null ? [] : [`until ${iso(fact.validUntil)}`]),
    ...(fact.retiredAt === null ? [] : [`retired ${iso(fact.retiredAt)}`]),
    ...(fact.supersedes.length === 0 ? [] : [`supersedes ${fact.supersedes.join(' ')}`]),
  ].join(', ');

export const formatRuleList = (facts: readonly GoverningFactView[]): string =>
  facts.length === 0
    ? 'no rules'
    : facts
        .map((fact) => `${fact.id}  [${placeOf(fact)}]  ${fact.kind} ${fact.target}: ${firstLine(fact.text)}  (${enforcementOf(fact)}${fact.retiredAt === null ? '' : `, retired ${iso(fact.retiredAt)}`})`)
        .join('\n');

const percentOf = (percent: number): number => Number(percent.toFixed(2));

export const formatRuleAdded = ({ fact, size, warnings }: RuleAddResponse): string =>
  [
    `added rule ${fact.id} (${enforcementOf(fact)})`,
    ...size.map((entry) => `${entry.tokens} tokens, ${percentOf(entry.percent)}% of the ${entry.contextWindow}-token window of ${entry.target}`),
    ...warnings.map((warning) => `warning: ${warning}`),
  ].join('\n');

export const formatRuleHistory = (facts: readonly GoverningFactView[]): string =>
  facts.length === 0 ? 'no rules' : facts.map((fact) => `${fact.id}  ${validityOf(fact)}  ${fact.kind} ${fact.target}: ${fact.text}`).join('\n');

export const formatGovernanceVerification = ({ rules, textOnly }: PolicyGovernanceResponse, proved: boolean): string =>
  [
    ...rules.map((rule) =>
      proved ? `${rule.id}: verified as ${rule.behavior} ${rule.rule}` : `${rule.id}: included in the verification as ${rule.behavior} ${rule.rule}, which did not prove`,
    ),
    ...textOnly.map((fact) => `${fact.id}: text-only, no guarantee (${fact.target})`),
  ].join('\n');
