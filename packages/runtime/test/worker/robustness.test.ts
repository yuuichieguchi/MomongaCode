import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/runtime';
import type { RuntimeStore } from '@momonga/store';
import type { ExecutionBatchInput } from '@momonga/tools';
import { waitUntil, within } from './deferred.ts';
import { EXTRA_ROOT, START_MS, makeEnv, toolKey } from './harness.ts';
import { pinnedStart } from './cancel-fixture.ts';
import { callsStep, functionCallItem, requestedOffering, textStep } from './scripts.ts';

describe('worker tool-set notices', () => {
  it('appends tool-set notices after run.started and skips messages already in the folded notes', async () => {
    const env = await makeEnv();
    const known = 'Tool source "mcp-a" failed to list tools: connection refused';
    const fresh = 'Tool source "mcp-b": awaiting approval';
    const run = await env.enqueue('Work');
    await env.seed(run.id, [{ type: 'notice', level: 'warning', message: known }], 'release');
    env.gateway.script.push(textStep('Hello.'));
    const worker = env.worker('worker-1', {
      tools: {
        toolSet: async () => {
          const snapshot = await env.snapshotTools(env.toolbox.tools());
          return { ...snapshot, notices: [known, fresh] };
        },
      },
    });

    expect(await env.runOnce(worker)).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    const notices = env.ofType(run.id, 'notice');
    expect(notices.map((event) => event.message)).toEqual([known, fresh]);
    const [started] = env.ofType(run.id, 'run.started');
    expect(notices[1]?.seq).toBeGreaterThan(started?.seq ?? Infinity);
  });
});

describe('worker config errors', () => {
  it.each([
    ['rules', 'the settings file is malformed'],
    ['toolSet', 'the MCP configuration is malformed'],
  ] as const)('fails the run closed with config_error when %s throws a ConfigError', async (port, message) => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('never sent'));
    if (port === 'rules') {
      env.settings.rulesHook = async () => {
        throw new ConfigError(message);
      };
    }
    const worker = env.worker(
      'worker-1',
      port === 'toolSet'
        ? {
            tools: {
              toolSet: async () => {
                throw new ConfigError(message);
              },
            },
          }
        : {},
    );
    const run = await env.enqueue('Work');

    expect(await env.runOnce(worker)).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'config_error', message } });
    expect(env.gateway.streams).toEqual([]);
  });

  it('fails the run with config_error when policyFor throws a ConfigError', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), textStep('never sent'));
    const worker = env.worker('worker-1', {
      tools: {
        policyFor: async () => {
          throw new ConfigError('the sandbox settings are malformed');
        },
      },
    });
    const run = await env.enqueue('Work');

    expect(await env.runOnce(worker)).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'config_error', message: 'the sandbox settings are malformed' } });
    expect(env.toolbox.executions).toEqual([]);
  });
});

describe('worker onError and notices', () => {
  it('keeps the run notice when onError is set', async () => {
    const env = await makeEnv();
    const failing = await env.enqueue('Fails to load');
    env.gateway.script.push(textStep('Hello.'));
    const failure = new Error('load exploded');
    let thrown = false;
    const store: RuntimeStore = {
      ...env.store,
      load: (runId) => {
        if (runId === failing.id && !thrown) {
          thrown = true;
          throw failure;
        }
        return env.store.load(runId);
      },
    };
    const reported: unknown[] = [];
    const worker = env.worker('worker-1', { store, idlePollMs: 10, onError: (error) => reported.push(error) });
    worker.start();
    await waitUntil(() => reported.length === 1, 3_000, 'the error to be reported');
    await within(worker.stop(), 3_000, 'the worker to stop');

    expect(reported).toEqual([failure]);
    expect(env.ofType(failing.id, 'notice').map((event) => event.message)).toEqual(['The worker failed on this run: load exploded']);
  });
});

describe('worker policyFor', () => {
  it('passes the policyFor roots and sandbox policy to the tool batch', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
    const run = await env.enqueue('Echo');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.batches).toHaveLength(1);
    expect(env.batches[0]?.roots).toEqual([env.project, EXTRA_ROOT]);
    expect(env.sessionTmpDir).toMatch(/session-tmp$/);
    expect(env.batches[0]?.tmpDir).toBe(env.sessionTmpDir);
    expect((env.batches[0] as ExecutionBatchInput | undefined)?.sandboxPolicy.writableRoots).toEqual([env.project]);
  });

  it('passes the policyFor roots to cancel recovery', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Mark it');
    const key = toolKey(run.id, 1, 'call_m_1');
    await env.seed(
      run.id,
      [
        pinnedStart(),
        requestedOffering(1, ['Mark']),
        {
          type: 'model.responded',
          step: 1,
          attempt: 1,
          response: { status: 'completed', output: [functionCallItem({ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } })], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
        },
        { type: 'tool.call', callId: 'call_m_1', providerCallId: 'call_m_1', name: 'Mark', kind: 'edit', title: 'Mark one', rawInput: { value: 'one' } },
        { type: 'tool.started', callId: 'call_m_1', idemKey: key },
      ],
      'crash',
    );
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Mark' } });
    await env.cancel(run.id);

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.batches).toHaveLength(1);
    expect(env.batches[0]?.recoverOnly).toBe(true);
    expect(env.batches[0]?.roots).toEqual([env.project, EXTRA_ROOT]);
    expect(env.sessionTmpDir).toMatch(/session-tmp$/);
    expect(env.batches[0]?.tmpDir).toBe(env.sessionTmpDir);
    expect(env.toolbox.reconciles).toEqual([key]);
  });
});

describe('worker model request metadata', () => {
  it('records metadata with the run id and step as strings in the sent and recorded body', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const expected = { run_id: run.id, step: '1' };
    expect(env.gateway.streams[0]?.body.metadata).toEqual(expected);
    expect((env.ofType(run.id, 'model.requested')[0]?.body as { metadata?: unknown }).metadata).toEqual(expected);
  });
});
