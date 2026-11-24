import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ADAPTERS, measuringProbeIn, probeRecordKeyIn, takesKeyIn } from '../src/adapters.ts';
import type { AdapterKind, AdapterTraits } from '../src/adapters.ts';
import type { ModelTarget } from '../src/settings.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

const capabilities = { contextWindow: 8192, maxOutputTokens: 1024, source: 'config', maxConcurrency: 1 } as const;

describe('the facts of every adapter are declared once', () => {
  it('declares traits for every adapter the settings can name, and for no other', () => {
    expectTypeOf<keyof typeof ADAPTERS>().toEqualTypeOf<AdapterKind>();
    expectTypeOf<AdapterKind>().toEqualTypeOf<ModelTarget['adapter']>();
    expect(Object.keys(ADAPTERS).sort()).toEqual(['anthropic', 'chat-completions', 'managed', 'ollama', 'open-responses', 'system-one']);
  });

  it('declares the wire facts of the Anthropic API in the table', () => {
    expect(ADAPTERS.anthropic.wire).toMatchObject({ tokenCounting: 'exact', parallelToolCalls: true, promptCache: { kind: 'breakpoints', maxBreakpoints: 4 } });
  });

  it('handles a fixture adapter added only to the table: its credential, its probe record and its probe', () => {
    const fixture: AdapterTraits = { ...ADAPTERS.ollama, credentials: 'key', probe: 'chat-completions-wire' };
    const traits = { ...ADAPTERS, fixture };
    const target = { adapter: 'fixture', model: 'm', baseUrl: 'http://127.0.0.1:9/v1/', billing: 'local', capabilities, maxConcurrency: 1, admissionTimeoutMs: 1 } as const;
    expect(takesKeyIn(traits)('fixture')).toBe(true);
    expect(probeRecordKeyIn(traits)('x', target)).toEqual({ kind: 'endpoint', key: { endpoint: 'http://127.0.0.1:9/v1', model: 'm' } });
    expect(measuringProbeIn(traits)(target)).toBe('chat-completions-wire');
  });

  it('measures a chat-completions model only when its tool calling is not declared', () => {
    const remote = { model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', billing: 'metered', capabilities, maxConcurrency: 1, admissionTimeoutMs: 1 } as const;
    expect(measuringProbeIn(ADAPTERS)({ ...remote, adapter: 'chat-completions', toolCalling: 'auto' })).toBe('chat-completions-wire');
    expect(measuringProbeIn(ADAPTERS)({ ...remote, adapter: 'chat-completions', toolCalling: 'native' })).toBeUndefined();
    expect(measuringProbeIn(ADAPTERS)({ ...remote, adapter: 'open-responses', toolCalling: 'native' })).toBeUndefined();
  });

  it('leaves no adapter name compared in the readers of the facts', () => {
    const readers = ['packages/config/src/probe-record-key.ts', 'packages/cli/src/commands/gateway.ts', 'packages/cli/src/eval/context-host.ts'];
    const compared = readers.flatMap((file) => [...fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/adapter [!=]== '[a-z-]+'/g)].map((match) => `${file}: ${match[0]}`));
    expect(compared).toEqual([]);
  });
});
