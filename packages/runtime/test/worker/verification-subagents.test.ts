import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { analyseVerifiedSuccess } from '@momonga/memory';
import { defineTool } from '@momonga/tools';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createChildRuns } from '@momonga/runtime';
import type { AgentsPort } from '@momonga/runtime';
import { createUnsandboxed } from '@momonga/sandbox';
import { fixedSandboxBindings } from '@momonga/runtime';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { fakeViewsOf } from './fake-gateway.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type VerificationCompleted = { round: number; outcome: string; exitCode?: number; mutationSeq: number };

const agentsPortOf = (env: Env): AgentsPort =>
  createAgentsPort({
    home: env.home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: async () => env.settings.trustedValue },
    runs: createChildRuns({ store: env.store, modelViews: async () => fakeViewsOf(['fm']) }),
  });

const writeAgent = (env: Env, name: string, frontmatter: string): void => {
  const directory = path.join(env.project, '.momonga', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\n${frontmatter}---\nYou fix things.\n`);
};

const reportingWrite = defineTool<Record<string, unknown>>({
  name: 'Write',
  description: 'Write a file and report it',
  kind: 'edit',
  sideEffect: 'write',
  subjectKind: 'path',
  inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'], additionalProperties: false },
  timeoutMs: 60_000,
  title: (input) => `Write ${String(input['file_path'])}`,
  subject: (input) => ({ kind: 'path', tool: 'Write', paths: [String(input['file_path'])], access: 'write' }),
  execute: async (input) => {
    const file = String(input['file_path']);
    const content = String(input['content']);
    fs.writeFileSync(file, content);
    return { status: 'completed', output: 'written', files: [{ path: file, sha256: sha256Hex(content), access: 'write' }], mutated: true };
  },
});

const delegate = (callId: string, agent: string) => callsStep([{ callId, name: 'Agent', args: { description: 'fix', prompt: 'Fix it', subagent_type: agent } }]);

const workerOf = (env: Env) => env.worker('w1', { agents: agentsPortOf(env), tools: { sandboxes: fixedSandboxBindings(createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 200 })) } });

const completions = (env: Env, runId: string): VerificationCompleted[] => env.ofType(runId, 'verification.completed' as never) as unknown as VerificationCompleted[];

const runToRest = async (env: Env, rounds: number): Promise<void> => {
  const worker = workerOf(env);
  for (let index = 0; index < rounds; index += 1) await env.runOnce(worker);
};

describe('verifiable completion of sub-agent runs', () => {
  it('ends a child with an unmet front matter condition STOPPED(conditions_unmet) and tells the parent which condition failed', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    writeAgent(env, 'fixer', 'conditions:\n  - echo still-broken; exit 3\n');
    const parent = await env.enqueue('Delegate the fix');
    env.gateway.script.push(delegate('call-a', 'fixer'), textStep('child: fixed'), textStep('child: really fixed'), textStep('parent done'));

    await runToRest(env, 3);

    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    expect(env.run(child.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
    expect(completions(env, child.id)).toMatchObject([{ outcome: 'failed', exitCode: 3 }]);
    const [result] = env.ofType(parent.id, 'tool.completed');
    expect(result?.status).toBe('failed');
    expect(result?.output).toContain('conditions_unmet');
    expect(result?.output).toContain('echo still-broken; exit 3');
  });

  it('pins the front matter declaration of a child in its run.started.pins.mandate.completion', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    writeAgent(env, 'fixer', 'conditions:\n  - true\n');
    const parent = await env.enqueue('Delegate the fix');
    env.gateway.script.push(delegate('call-a', 'fixer'), textStep('child: fixed'), textStep('parent done'));

    await runToRest(env, 3);

    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    const pins = env.ofType(child.id, 'run.started')[0]?.pins;
    expect((pins?.['mandate'] as { completion?: unknown } | undefined)?.completion).toMatchObject({ conditions: [{ command: 'true', when: 'always', source: 'profile' }] });
    expect(env.run(child.id).status).toBe('COMPLETED');
    expect(completions(env, child.id)).toMatchObject([{ outcome: 'passed' }]);
  });

  it('counts the mutations of a finished child for the parent, so an after_mutation condition of the parent is owed', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    writeAgent(env, 'writer', '');
    env.settings.verificationValue = { ...env.settings.verificationValue, conditions: ['echo parent-check; exit 1'], required: false } as never;
    const parent = await env.enqueue('Delegate a write');
    env.gateway.script.push(
      delegate('call-a', 'writer'),
      callsStep([{ callId: 'call-w', name: 'Write', args: { file_path: path.join(env.project, 'child.txt'), content: 'x' } }]),
      textStep('child: wrote it'),
      textStep('child: wrote it'),
      textStep('parent done'),
      textStep('parent done'),
    );

    await runToRest(env, 4);

    const parentChecks = completions(env, parent.id);
    expect(parentChecks.length).toBeGreaterThanOrEqual(1);
    expect(parentChecks[0]?.mutationSeq).toBeGreaterThan(0);
    expect(env.run(parent.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
  });

  it('gives the parent the paths a child wrote, so a child that writes a manifest leaves the parent unverified', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    writeAgent(env, 'writer', '');
    env.settings.verificationValue = { ...env.settings.verificationValue, conditions: ['true'], required: false } as never;
    const parent = await env.enqueue('Delegate a manifest write');
    const manifest = path.join(env.project, 'package.json');
    env.gateway.script.push(
      delegate('call-a', 'writer'),
      callsStep([{ callId: 'call-w', name: 'Write', args: { file_path: manifest, content: '{}' } }]),
      textStep('child: wrote it'),
      textStep('child: wrote it'),
      textStep('parent done'),
      textStep('parent done'),
    );

    const worker = env.worker('w1', {
      agents: agentsPortOf(env),
      toolList: () => [...env.toolbox.tools().filter((tool) => tool.name !== 'Write'), reportingWrite],
      tools: { sandboxes: fixedSandboxBindings(createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 200 })) },
    });
    for (let round = 0; round < 4; round += 1) await env.runOnce(worker);

    const delegated = env.ofType(parent.id, 'tool.completed').find((event) => event.callId !== undefined && env.ofType(parent.id, 'tool.call').some((call) => call.callId === event.callId && call.name === 'Agent'));
    expect(delegated?.files).toEqual([expect.objectContaining({ path: manifest, access: 'write' })]);
    expect(env.run(parent.id).status).toBe('COMPLETED');
    const analysis = analyseVerifiedSuccess({ status: 'COMPLETED', events: env.events(parent.id), commands: ['true'], manifests: ['package.json'] });
    expect(analysis.verified).toBe(false);
  });
});
