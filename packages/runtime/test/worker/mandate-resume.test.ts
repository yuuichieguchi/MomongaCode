import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { delegationOf } from '../../src/worker/held-calls.ts';
import { readPins } from '../../src/worker/pins.ts';
import type { RunPins } from '../../src/worker/pins.ts';
import { operationCatalogueFacts } from '@momonga/tools';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

vi.setConfig({ testTimeout: SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, hookTimeout: SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS });

const PLACE = { home: '/home/someone', cwd: '/work/a' };

const WRITTEN: RunPins = {
  model: 'fm',
  systemPromptDigest: 'd'.repeat(64),
  toolSetDigest: 't'.repeat(64),
  capabilities: capabilitiesFor(100_000),
  roles: {},
  mandate: { completion: { conditions: [], requirements: [] }, scope: { allow: ['GitCommit'], deny: ['Bash(rm:*)'] }, hold: { onQuiescent: 'wait' } },
  verificationRequired: true,
};

const stored = (pins: RunPins): Record<string, unknown> => JSON.parse(JSON.stringify(pins)) as Record<string, unknown>;

const lost = (): ScriptStep => ({ events: [], error: new GatewayRequestError({ status: 502, type: 'server_error', code: 'provider_unavailable', message: 'the chat-completions upstream is unreachable' }) });

describe('the pins of a run read back', () => {
  it('give exactly the pins that were written, mandate scope and hold included', () => {
    expect(readPins(stored(WRITTEN))).toEqual(WRITTEN);
  });

  it('give the second attempt the same delegation the first attempt had', () => {
    const first = delegationOf(stored(WRITTEN), PLACE, operationCatalogueFacts());
    const second = delegationOf(stored(readPins(stored(WRITTEN))), PLACE, operationCatalogueFacts());
    expect(first.delegation).toBeDefined();
    expect(second).toEqual(first);
  });
});

describe('a resumed attempt of a run under a mandate', () => {
  it('runs a tool its mandate allows without asking a person', async () => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: 20 });
    const target = path.join(env.project, 'out.txt');
    env.gateway.script.push(lost(), callsStep([{ callId: 'call_w', name: 'Write', args: { file_path: target, content: 'resumed' } }]), textStep('Written.'));
    const run = await env.enqueue('Write', { mandate: { scope: { allow: [`Write(/${target})`] } } });

    await env.runOnce(env.worker('worker-1'));
    expect(env.run(run.id).status).toBe('QUEUED');
    env.clock.set(env.run(run.id).availableAt);
    await env.runOnce(env.worker('worker-2'));

    expect(env.ofType(run.id, 'run.started').map((event) => event.attempt)).toEqual([1, 2]);
    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(env.ofType(run.id, 'tool.held')).toEqual([]);
    expect(env.ofType(run.id, 'tool.completed')).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(fs.readFileSync(target, 'utf8')).toBe('resumed');
    expect(env.ofType(run.id, 'run.started')[1]?.pins).toEqual(env.ofType(run.id, 'run.started')[0]?.pins);
  });
});
