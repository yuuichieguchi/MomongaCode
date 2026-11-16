import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createChildRuns, fixedSandboxBindings } from '@momonga/runtime';
import { createUnsandboxed } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { DEADLINE_MS, createdRun, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { fakeViewsOf } from './fake-gateway.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const workerOf = (env: Env) =>
  env.worker('w1', {
    agents: createAgentsPort({
      home: env.home,
      fileSystem: createNodeSkillFileSystem(),
      settings: { trusted: async () => env.settings.trustedValue, approvedProjectAgents: async () => ({ has: () => true }) },
      runs: createChildRuns({ store: env.store, modelViews: async () => fakeViewsOf(['fm']) }),
    }),
    tools: { sandboxes: fixedSandboxBindings(createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 200 })) },
  });

const denyNpmTest = (env: Env): void => {
  env.settings.extraRules.push({ effect: 'deny', rule: 'Bash(npm test*)' });
};

describe('completion conditions are checked against the deny rules where they are pinned', () => {
  it('refuses the start of a run whose settings condition a deny rule denies, naming the rule and the settings source', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    denyNpmTest(env);
    env.settings.verificationValue = { ...env.settings.verificationValue, conditions: ['npm test'] } as never;
    const run = await env.enqueue('Fix it');
    env.gateway.script.push(textStep('done'));

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'completion_condition_denied' } });
    const message = env.run(run.id).error?.message ?? '';
    expect(message).toContain('Bash(npm test*)');
    expect(message).toContain('the verification commands or the accepted projectChecks of the settings');
    expect(env.ofType(run.id, 'run.started')).toEqual([]);
  });

  it('refuses the start of a sub-agent run whose front matter condition a deny rule denies, naming the rule and the agent source', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    denyNpmTest(env);
    const directory = path.join(env.project, '.momonga', 'agents');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'fixer.md'), '---\nname: fixer\ndescription: fixer agent\nconditions:\n  - npm test\n---\nYou fix things.\n');
    const parent = await env.enqueue('Delegate the fix');
    env.gateway.script.push(callsStep([{ callId: 'call-a', name: 'Agent', args: { description: 'fix', prompt: 'Fix it', subagent_type: 'fixer' } }]), textStep('child: fixed'), textStep('parent done'));

    const worker = workerOf(env);
    for (let index = 0; index < 3; index += 1) await env.runOnce(worker);

    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    expect(env.run(child.id)).toMatchObject({ status: 'FAILED', error: { code: 'completion_condition_denied' } });
    const message = env.run(child.id).error?.message ?? '';
    expect(message).toContain('Bash(npm test*)');
    expect(message).toContain('the front matter of the agent');
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([{ status: 'failed', output: expect.stringContaining('completion_condition_denied') }]);
  });

  it('refuses the start of a run whose request condition was stored without the service check', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    denyNpmTest(env);
    const run = createdRun(
      await env.store.createRunAndEnqueue(env.session.id, {
        input: 'Fix it',
        timeoutMs: DEADLINE_MS - env.clock.now(),
        limits: {},
        pins: {},
        mandate: { completion: { conditions: [{ command: 'npm test' }] } },
      } as never),
    );
    env.gateway.script.push(textStep('done'));

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'completion_condition_denied' } });
    expect(env.run(run.id).error?.message).toContain('the mandate of the request');
  });

  it('starts a run whose conditions no deny rule denies', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    denyNpmTest(env);
    env.settings.verificationValue = { ...env.settings.verificationValue, conditions: ['true'] } as never;
    const run = await env.enqueue('Fix it');
    env.gateway.script.push(textStep('done'));

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
