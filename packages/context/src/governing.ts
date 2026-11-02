import { sha256Hex } from '@momonga/foundation';
import type { MessageInputItem } from '@momonga/protocol';
import type { ContextGoverning, ContextNotice, LoadedGoverning } from './types.ts';

const FRAMING = [
  'Governing facts. A person confirmed each text below exactly as written; follow all of them in every step of this run.',
  'A fact of a narrower scope does not override one of a wider scope.',
];

const conflictLine = (target: string, ids: readonly string[]): string =>
  `Conflict about "${target}": the facts ${ids.join(', ')} disagree. Tell the user about the conflict and do not choose between them on your own.`;

export const renderGoverning = (governing: ContextGoverning): string =>
  [
    ...FRAMING,
    '',
    ...governing.active.map((fact) => `[${fact.id}] ${fact.kind} about ${fact.target}: ${fact.text}`),
    ...(governing.conflicts.length === 0 ? [] : ['', ...governing.conflicts.map((conflict) => conflictLine(conflict.target, conflict.ids))]),
  ].join('\n');

export const governingMessageOf = (governing: ContextGoverning | undefined): MessageInputItem[] =>
  governing === undefined || governing.active.length === 0 ? [] : [{ type: 'message', role: 'developer', content: renderGoverning(governing) }];

export const loadedGoverningOf = (governing: ContextGoverning | undefined): LoadedGoverning => ({
  active: (governing?.active ?? []).map((fact) => ({ id: fact.id, textSha256: sha256Hex(fact.text) })),
  conflicts: (governing?.conflicts ?? []).map((conflict) => ({ target: conflict.target, ids: [...conflict.ids] })),
});

export const governingNoticesOf = (governing: ContextGoverning | undefined): ContextNotice[] =>
  (governing?.conflicts ?? []).map((conflict) => ({
    code: 'governing_conflict',
    message: `Governing facts about "${conflict.target}" conflict (${conflict.ids.join(', ')}); all of them are shown to the model`,
  }));
