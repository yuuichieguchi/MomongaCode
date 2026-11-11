import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryRecord, RunEventPayload } from '@momonga/protocol';
import { createFakeTimers, NEVER_CANCELLED } from '@momonga/testkit';
import type { RuntimeStore } from '@momonga/store';
import { defaultMemorySettings } from '@momonga/config';
import { enqueue, harness, makeStoreDir, newSession } from '../../../store/test/helpers.ts';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { withInProcessFacts } from './in-process-facts.ts';
import { textStep } from '../worker/scripts.ts';
import { bash, exported, fileTool, finishClaimed, checked } from './reflection-fixture.ts';

type Api = {
  memories: RuntimeStore['memories'] & { candidates(): MemoryRecord[] };
};

type Reflector = { runOne(signal: AbortSignal): Promise<'idle' | 'busy' | 'ran'> };

const SIGNAL = new AbortController().signal;
const MAX_ATTEMPTS = 3;
const HEAD = 'b'.repeat(40);
const MANIFEST_SHA = 'c'.repeat(64);
const SOURCE_SHA = 'a'.repeat(64);
const COMMANDS = ['npm test', 'npm run lint'];
const MANIFESTS = ['package.json'];

const NPM_TEST_FACT = 'Run `npm test` to verify a change in this repository.';
const LINT_FACT = 'Run `npm run lint` to verify a change in this repository.';

const setup = async () => {
  const opened = harness();
  const { clock } = opened;
  const store = withInProcessFacts(opened.store, opened.dbPath);
  const project = makeStoreDir();
  await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
  const session = newSession(store, project);
  const gateway = createFakeGateway(capabilitiesFor(100_000, { structuredOutput: 'json_schema' }));
  const settings = {
    trusted: async (target: { cwd: string }) => (await store.trust.decisionAsked(target.cwd, NEVER_CANCELLED)).decision === 'trusted',
    verification: async () => ({ commands: [...COMMANDS], manifests: [...MANIFESTS] }),
    memory: async () => defaultMemorySettings(),
  };
  const reflector = (): Reflector =>
    exported<(options: unknown) => Reflector>('createReflector')({
      store,
      gateway,
      settings,
      clock,
      isIdle: () => true,
      evidenceRun: () => async () => ({ exitCode: 0, stdout: `${HEAD}\n` }),
      maxAttempts: MAX_ATTEMPTS,
      attemptTimeoutMs: 600_000,
      timers: createFakeTimers(clock),
      random: () => 0.5,
    });
  const finishedRun = async (events: readonly RunEventPayload[]) => {
    const run = await enqueue(store, session.id, 'fix the bug');
    await finishClaimed(store, events);
    return run;
  };
  return { store, api: store as unknown as Api, clock, project, session, gateway, reflector, finishedRun };
};

const VERIFIED_TWICE = (project: string): RunEventPayload[] => [
  ...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SOURCE_SHA, access: 'write' }),
  ...fileTool('r1', 'Read', { path: path.join(project, 'package.json'), sha256: MANIFEST_SHA, access: 'read' }),
  ...checked('npm test', 0, 'ok'),
  ...checked('npm run lint', 0, 'ok'),
];


describe('memory.repositoryFacts under the shipped defaults (design core-on 3.5 item 4)', () => {
  it('writes one procedure candidate per passing verification command of a verified run in a trusted folder', async () => {
    const env = await setup();
    env.gateway.script.push(textStep(JSON.stringify({ candidates: [] })));
    const run = await env.finishedRun(VERIFIED_TWICE(env.project));
    expect(await env.reflector().runOne(SIGNAL)).toBe('ran');
    const texts = env.api.memories
      .candidates()
      .filter((record) => record.source.kind === 'reflection' && record.source.runId === run.id)
      .map((record) => [record.text, record.kind]);
    expect(texts).toEqual([
      [NPM_TEST_FACT, 'procedure'],
      [LINT_FACT, 'procedure'],
    ]);
  });
});
