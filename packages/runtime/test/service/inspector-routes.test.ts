import { describe, expect, it } from 'vitest';
import type { InspectorSnapshot } from '@momonga/protocol';
import { expectError, startService, toolCallPayload } from './helpers.ts';

describe('Agent Inspector & Memory PATCH HTTP routes', () => {
  it('returns 404 for unknown session and clean empty snapshot before any run starts', async () => {
    const env = await startService();
    expectError(await env.http('GET', '/v1/sessions/unknown-session/inspector'), 404, 'not_found');

    const session = await env.createSession();
    const res = await env.http('GET', `/v1/sessions/${session.id}/inspector`);
    expect(res.status).toBe(200);
    const snapshot = res.json as InspectorSnapshot;
    expect(snapshot.session.id).toBe(session.id);
    expect(snapshot.agent.status).toBe('IDLE');
    expect(snapshot.context.currentTokens).toBeNull();
    expect(snapshot.context.contextWindow).toBeGreaterThan(0);
    expect(snapshot.usage.cost.totalUsd).toBeNull();
    expect(snapshot.usage.cache.hitRatio).toBeNull();
  });

  it('captures live run state, redacts session env secrets, and supports context exclusion', async () => {
    const env = await startService();
    const secretVal = 'SESSION_ENV_CREDENTIAL_12345';
    const bearerVal = 'Bearer bearer_secret_value_abcdef1234';
    const session = await env.createSession({ env: { PATH: '/usr/bin:/bin', LANG: 'C', APP_RUNTIME_VALUE: secretVal } });
    const run = await env.createRun(session.id, { input: `inspect sk-abcdefghijklmno ${bearerVal} ${secretVal}` });
    const claim = env.claimRun(run.id);

    env.append(claim, [
      { type: 'run.started', attempt: 1, now: env.clock.now(), pins: { completion: { requirements: ['All tests pass'] } } },
      { type: 'user.message', text: `inspect sk-abcdefghijklmno ${bearerVal} ${secretVal}` },
      { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: {} },
      toolCallPayload('call-1', 'out.txt'),
      { type: 'tool.started', callId: 'call-1', idemKey: 'idem-1' },
      { type: 'tool.completed', callId: 'call-1', status: 'completed', output: `token=${secretVal} ${bearerVal} sk-1234567890abcdef` },
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: {
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 1200,
            output_tokens: 150,
            total_tokens: 1350,
            input_tokens_details: { cached_tokens: 600 },
          },
        },
      },
      { type: 'verification.started', round: 1, conditionId: 'cond-1', attempt: 1, command: 'npm test', mutationSeq: 0 },
      { type: 'verification.completed', round: 1, conditionId: 'cond-1', command: 'npm test', outcome: 'passed', durationMs: 320, exitCode: 0, output: 'ok', mutationSeq: 0 },
    ]);

    const res = await env.http('GET', `/v1/sessions/${session.id}/inspector`);
    expect(res.status).toBe(200);
    const snap = res.json as InspectorSnapshot;
    const rawJson = JSON.stringify(snap);
    expect(rawJson).not.toContain(secretVal);
    expect(rawJson).not.toContain('bearer_secret_value_abcdef1234');
    expect(rawJson).not.toContain('sk-1234567890abcdef');
    expect(rawJson).not.toContain('sk-abcdefghijklmno');

    expect(snap.execution.toolCalls).toHaveLength(1);
    expect(snap.execution.toolCalls[0]!.status).toBe('completed');
    expect(snap.execution.completionConditions[0]!.state).toBe('passed');
    expect(snap.execution.requirements).toContain('All tests pass');
    expect(snap.usage.totals.inputTokens).toBe(1200);
    expect(snap.usage.totals.cachedInputTokens).toBe(600);

    // Exclude and then restore a tool output callId in session context.
    const ex = await env.http('POST', `/v1/sessions/${session.id}/inspector/context/exclude`, {
      body: { callId: 'call-1', excluded: true },
    });
    expect(ex.status).toBe(200);
    expect((ex.json as InspectorSnapshot).context.evictedCallIds).toContain('call-1');

    const restored = await env.http('POST', `/v1/sessions/${session.id}/inspector/context/exclude`, {
      body: { callId: 'call-1', excluded: false },
    });
    expect(restored.status).toBe(200);
    expect((restored.json as InspectorSnapshot).context.evictedCallIds).not.toContain('call-1');
  });

  it('supports memory controls, live retrieval search trace, and safe PATCH memory editing', async () => {
    const env = await startService();
    const session = await env.createSession();

    const m1 = await env.http('POST', '/v1/memories', {
      body: { scope: 'user', kind: 'fact', text: 'Authentication uses JWT middleware in src/auth.ts' },
    });
    expect(m1.status).toBe(201);
    const memId = m1.json.memory.id as string;

    const m2 = await env.http('POST', '/v1/memories', {
      body: { scope: 'user', kind: 'fact', text: 'Unrelated styling convention uses prettier' },
    });
    expect(m2.status).toBe(201);

    // Session pin & exclude controls.
    const pinned = await env.http('POST', `/v1/sessions/${session.id}/inspector/memory/control`, {
      body: { memoryId: memId, action: 'pin' },
    });
    expect(pinned.status).toBe(200);
    const pinnedSnap = pinned.json as InspectorSnapshot;
    expect(pinnedSnap.memory.sessionControls.pinnedIds).toContain(memId);
    expect(pinnedSnap.memory.lifecycle.some((ev) => ev.kind === 'session_pinned' && ev.memoryId === memId)).toBe(true);

    // Live memory retrieval trace search.
    const search = await env.http('POST', `/v1/sessions/${session.id}/inspector/memory/search`, {
      body: { query: 'Authentication' },
    });
    expect(search.status).toBe(200);
    const trace = search.json.trace;
    expect(trace.query).toBe('Authentication');
    expect(trace.candidateCount).toBe(2);
    expect(trace.selectedCount).toBe(1);
    const hit = trace.candidates.find((c: { id: string }) => c.id === memId);
    expect(hit.matched).toBe(true);
    expect(hit.decision).toBe('included');
    expect(hit.pinned).toBe(true);

    // Invalid PATCH leaves old memory untouched.
    const badPatch = await env.http('PATCH', `/v1/memories/${memId}`, { body: { text: '' } });
    expect(badPatch.status).toBe(400);
    const stillThere = await env.http('GET', `/v1/memories/${memId}`);
    expect(stillThere.status).toBe(200);

    // Valid PATCH creates updated memory and retires previous.
    const okPatch = await env.http('PATCH', `/v1/memories/${memId}`, {
      body: { text: 'Authentication uses JWT middleware in src/auth-v2.ts' },
    });
    expect(okPatch.status).toBe(200);
    expect(okPatch.json.memory.text).toContain('src/auth-v2.ts');
    const prevAfter = await env.http('GET', `/v1/memories/${memId}`);
    expect(prevAfter.json.memory.retiredAt).not.toBeNull();
  });
});
