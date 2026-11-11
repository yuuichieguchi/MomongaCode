import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import type { CallOutputFit } from '@momonga/tools';
import { itemCapFor } from '@momonga/context';
import { canonicalJson } from '@momonga/foundation';
import { envelopeOf, tokensForText } from '@momonga/protocol';
import { inputTokensOf, tokensOfText } from './fake-gateway.ts';
import { START_MS, capabilitiesFor, makeEnv, toolKey } from './harness.ts';
import { callsStep, functionCallItem, requestedOffering, textStep } from './scripts.ts';
import { gatewayError } from './within-turn-support.ts';

const W4000 = capabilitiesFor(4000);

const responded = (step: number, output: unknown[]) => ({
  type: 'model.responded' as const,
  step,
  attempt: 1,
  response: { status: 'completed' as const, output, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
});

const seenFits: CallOutputFit[] = [];

const dumpTool = defineTool<Record<string, unknown>>({
  name: 'Dump',
  description: 'Print a long listing',
  kind: 'read',
  sideEffect: 'read_only',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  timeoutMs: 60_000,
  title: () => 'Dump',
  subject: () => ({ kind: 'none', tool: 'Dump' }),
  execute: async (_input, ctx) => {
    seenFits.push(ctx.outputFit);
    return { status: 'completed', output: Array.from({ length: 800 }, (_unused, index) => `row ${index} of a wide listing`).join('\n') };
  },
});

const journaledTokens = (output: string, callId: string): number =>
  tokensOfText(canonicalJson({ type: 'function_call_output', call_id: callId, output: envelopeOf({ content: output, callId, tool: 'Dump' }) }));

const longestFitting = async (fits: (text: string) => Promise<boolean>, tokensOf: (text: string) => number, cap: number): Promise<string> => {
  let low = 1;
  let high = 8 * cap;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tokensOf('a'.repeat(middle)) <= cap) low = middle;
    else high = middle - 1;
  }
  const text = 'a'.repeat(low);
  expect(tokensOf(text)).toBeLessThanOrEqual(cap);
  expect(await fits(text)).toBe(true);
  expect(await fits(`${text}aaaa`)).toBe(false);
  return text;
};

describe('output fit from the pinned floor', () => {
  it('journals an output of at most the pinned-floor item cap in meter tokens, root AGENTS.md included', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.instructions.files.set(`${env.project}/AGENTS.md`, 'r'.repeat(4800));
    env.gateway.script.push(callsStep([{ callId: 'e1', name: 'Dump', args: { value: 'x' } }]), textStep('done'));
    const run = await env.enqueue('Dump once');

    await env.runOnce(env.worker('worker-1', { toolList: () => [...env.toolbox.tools(), dumpTool] }));

    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED' });
    const pinnedTokens = inputTokensOf(env.gateway.streams[0]?.body ?? { model: 'fm' });
    const itemCap = Math.max(64, Math.min(730, Math.floor((2920 - pinnedTokens) / 2)));
    expect(itemCap).toBeLessThan(itemCapFor(W4000));
    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed?.truncated).toBe(true);
    const callId = completed?.callId ?? '';
    expect(journaledTokens(completed?.output ?? '', callId)).toBeLessThanOrEqual(itemCap);
    expect(journaledTokens(completed?.output ?? '', callId)).toBeGreaterThan(itemCap / 2);
    expect(completed?.output).toContain(completed?.handle);
    const [batch] = env.batches;
    expect(typeof batch?.outputFit.ready).toBe('function');
    expect(seenFits).toHaveLength(1);
    await longestFitting((text) => (seenFits[0] as CallOutputFit).fits(text), (text) => journaledTokens(text, callId), itemCap);
  });

  it('keeps an output that fits the item cap as it is, with no handle', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(callsStep([{ callId: 'e1', name: 'Echo', args: { value: 'small' } }]), textStep('done'));
    const run = await env.enqueue('Echo once');

    await env.runOnce(env.worker());

    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed?.output).toBe('echo:small');
    expect(completed?.truncated).toBeUndefined();
  });

  it('reconciles a started call of a recovered claim with the capability-only item cap and no count_tokens call', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    const run = await env.enqueue('Mark it');
    const key = toolKey(run.id, 1, 'call_m_1');
    await env.seed(
      run.id,
      [
        requestedOffering(1, ['Mark']),
        responded(1, [functionCallItem({ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } })]),
        { type: 'tool.call', callId: 'call_m_1', providerCallId: 'call_m_1', name: 'Mark', kind: 'edit', title: 'Mark one', rawInput: { value: 'one' } },
        { type: 'tool.started', callId: 'call_m_1', idemKey: key },
      ],
      'crash',
    );
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Mark' } });
    const countsBeforeReconcile: number[] = [];
    env.gateway.countHook = async () => {
      if (env.ofType(run.id, 'tool.reconciled').length === 0) {
        countsBeforeReconcile.push(1);
        throw gatewayError(503, 'server_error', 'gateway_closed');
      }
    };
    env.gateway.script.push(textStep('Marked.'));

    await env.runOnce(env.worker());

    expect(countsBeforeReconcile).toEqual([]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: 'call_m_1', outcome: 'already_applied' })]);
    expect(env.run(run.id).status).toBe('COMPLETED');
    const reconcileFit = env.batches[0]?.reconcileFit;
    if (reconcileFit === undefined) throw new Error('expected a reconcile fit');
    await longestFitting((text) => reconcileFit.fits(text, { callId: 'call_m_1', tool: 'Mark' }), tokensForText, itemCapFor(W4000));
  });

  it('fails pinned_overflow from the lazy measurement before executing a pending call', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    const run = await env.enqueue('Echo it');
    await env.seed(run.id, [requestedOffering(1, ['Echo']), responded(1, [functionCallItem({ callId: 'call_e_1', name: 'Echo', args: { value: 'x' } })])], 'crash');
    env.instructions.files.set(`${env.project}/AGENTS.md`, 'r'.repeat(16_000));

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'pinned_overflow' } });
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
  });
});
