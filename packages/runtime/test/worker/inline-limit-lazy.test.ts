import { describe, expect, it } from 'vitest';
import { MINIMUM_INLINE_OUTPUT_CHARS } from '@momonga/tools';
import { inlineOutputLimitFor } from '../../src/worker/inline-limit.ts';
import { inputTokensOf } from './fake-gateway.ts';
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

describe('inline output limit from the pinned floor', () => {
  it('gives executed tools three characters per pinned-floor item-cap token, root AGENTS.md included', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.instructions.files.set(`${env.project}/AGENTS.md`, 'r'.repeat(5600));
    env.gateway.script.push(callsStep([{ callId: 'e1', name: 'Echo', args: { value: 'x' } }]), textStep('done'));
    const run = env.enqueue('Echo once');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const pinnedTokens = inputTokensOf(env.gateway.streams[0]?.body ?? { model: 'fm' });
    const itemCap = Math.max(64, Math.min(730, Math.floor((2920 - pinnedTokens) / 2)));
    const expected = Math.max(MINIMUM_INLINE_OUTPUT_CHARS, Math.min(30_000, 3 * itemCap));
    expect(expected).toBeLessThan(inlineOutputLimitFor(W4000));
    expect(env.toolbox.executions.map((execution) => execution.outputBudgetChars)).toEqual([expected]);
    const [batch] = env.batches;
    expect(batch?.inlineLimitForReconcile).toBe(inlineOutputLimitFor(W4000));
    expect(typeof batch?.inlineLimitForExecution).toBe('function');
    expect(await batch?.inlineLimitForExecution?.()).toBe(expected);
  });

  it('reconciles a started call of a recovered claim with the capability-only limit and no count_tokens call', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    const run = env.enqueue('Mark it');
    const key = toolKey(run.id, 1, 'call_m_1');
    env.seed(
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
    expect(env.batches[0]?.inlineLimitForReconcile).toBe(inlineOutputLimitFor(W4000));
  });

  it('fails pinned_overflow from the lazy measurement before executing a pending call', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    const run = env.enqueue('Echo it');
    env.seed(run.id, [requestedOffering(1, ['Echo']), responded(1, [functionCallItem({ callId: 'call_e_1', name: 'Echo', args: { value: 'x' } })])], 'crash');
    env.instructions.files.set(`${env.project}/AGENTS.md`, 'r'.repeat(16_000));

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'pinned_overflow' } });
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
  });
});
