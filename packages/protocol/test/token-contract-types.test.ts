import { describe, expectTypeOf, it } from 'vitest';
import type { AdapterRequest, Capabilities, CreateResponseBody, PrefixEvent, RunEventPayload, RunState } from '@momonga/protocol';

type CacheCounts = { stable: number; fixed: number; previousHistory?: number; history: number };

type PromptCache = { kind: 'breakpoints'; maxBreakpoints: number } | { kind: 'key' } | { kind: 'automatic' } | { kind: 'none' };

describe('the promptCache capability', () => {
  it('is optional, so an absent value means unknown', () => {
    expectTypeOf<Capabilities['promptCache']>().toEqualTypeOf<PromptCache | undefined>();
  });
});

describe('the request body and the adapter request', () => {
  it('carries the cache counts of leading input items under momonga.cache', () => {
    expectTypeOf<NonNullable<CreateResponseBody['momonga']>['cache']>().toEqualTypeOf<CacheCounts | undefined>();
  });

  it('gives the adapter a prompt cache key and the cache marks', () => {
    expectTypeOf<AdapterRequest['promptCacheKey']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AdapterRequest['cacheMarks']>().toEqualTypeOf<CacheCounts | undefined>();
  });
});

describe('the token events', () => {
  it('defines tool.loaded and loop.warned', () => {
    expectTypeOf<Extract<RunEventPayload, { type: 'tool.loaded' }>>().toEqualTypeOf<{ type: 'tool.loaded'; names: string[] }>();
    expectTypeOf<Extract<RunEventPayload, { type: 'loop.warned' }>>().toEqualTypeOf<{ type: 'loop.warned'; signature: string }>();
  });

  it('records the preserved prefix on model.requested', () => {
    expectTypeOf<Extract<RunEventPayload, { type: 'model.requested' }>['prefix']>().toEqualTypeOf<
      { preservedItems: number; toolsChanged: boolean; causes: PrefixEvent[] } | undefined
    >();
  });

  it('records the formatter of a completed tool output', () => {
    expectTypeOf<Extract<RunEventPayload, { type: 'tool.completed' }>['formatted']>().toEqualTypeOf<{ formatter: string; version: number } | undefined>();
  });

  it('lets context.truncated name a reference', () => {
    expectTypeOf<Extract<RunEventPayload, { type: 'context.truncated' }>['kind']>().toEqualTypeOf<'omitted' | 'truncated' | 'reference'>();
  });
});

describe('the run state of the token contract', () => {
  it('holds the loaded tools, the last loop warning and the seq of each arrival', () => {
    expectTypeOf<RunState['loadedTools']>().toEqualTypeOf<string[]>();
    expectTypeOf<RunState['loopWarned']>().toEqualTypeOf<{ signature: string } | undefined>();
    expectTypeOf<RunState['loadedInstructions'][number]['seq']>().toEqualTypeOf<number>();
    expectTypeOf<RunState['activatedSkills'][number]['seq']>().toEqualTypeOf<number>();
  });
});
