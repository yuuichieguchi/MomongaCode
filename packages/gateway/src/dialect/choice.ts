import type { ConstructSupport, DialectDefinition, DialectId } from '@momonga/protocol';
import type { KeywordSupport } from './keyword-support.ts';
import { keywordRules } from './keyword-support.ts';
import type { ResolvedDialect } from './render.ts';
import { definitionOf } from './resolve.ts';

export type UserDialects = Readonly<Record<DialectId, DialectDefinition>>;

export type DialectChoice = DialectId | ResolvedDialect;

export const NO_USER_DIALECTS: UserDialects = {};

export const resolveDialect = (id: DialectId, userDialects: UserDialects, constructSupport?: ConstructSupport): ResolvedDialect => ({
  id,
  definition: definitionOf(id, userDialects),
  ...(constructSupport === undefined ? {} : { constructSupport }),
});

export const resolvedOf = (choice: DialectChoice): ResolvedDialect => (typeof choice === 'string' ? resolveDialect(choice, NO_USER_DIALECTS) : choice);

export const withKeywordSupport = (choice: DialectChoice, support: KeywordSupport): ResolvedDialect => {
  const resolved = resolvedOf(choice);
  return { ...resolved, definition: { ...resolved.definition, rules: [...keywordRules(support), ...resolved.definition.rules] } };
};
