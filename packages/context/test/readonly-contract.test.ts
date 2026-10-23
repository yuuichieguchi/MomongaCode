import { describe, expectTypeOf, it } from 'vitest';
import type { CompactionInputItem, InputItem, MessageInputItem } from '@momonga/protocol';
import type { ContextSources, DeepReadonly, HistoryItem } from '@momonga/context';

describe('deeply readonly source items', () => {
  it('types HistoryItem.item as DeepReadonly<InputItem>', () => {
    expectTypeOf<HistoryItem['item']>().toEqualTypeOf<DeepReadonly<InputItem>>();
    expectTypeOf<HistoryItem['item']>().not.toEqualTypeOf<InputItem>();
  });

  it('types ContextSources.task as DeepReadonly<MessageInputItem>', () => {
    expectTypeOf<ContextSources['task']>().toEqualTypeOf<DeepReadonly<MessageInputItem>>();
    expectTypeOf<ContextSources['task']>().not.toEqualTypeOf<MessageInputItem>();
  });

  it('types the summary item as DeepReadonly<CompactionInputItem>', () => {
    type SummaryItem = NonNullable<ContextSources['summary']>['item'];
    expectTypeOf<SummaryItem>().toEqualTypeOf<DeepReadonly<CompactionInputItem>>();
    expectTypeOf<SummaryItem>().not.toEqualTypeOf<CompactionInputItem>();
  });

  it('makes nested content arrays readonly', () => {
    type Message = Extract<HistoryItem['item'], { type: 'message' }>;
    expectTypeOf<Message['content']>().not.toEqualTypeOf<MessageInputItem['content']>();
    expectTypeOf<Message>().toHaveProperty('role').toEqualTypeOf<MessageInputItem['role']>();
  });
});
