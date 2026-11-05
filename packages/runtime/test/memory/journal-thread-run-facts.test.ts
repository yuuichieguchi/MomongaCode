import path from 'node:path';
import v8 from 'node:v8';
import { describe, expect, it, vi } from 'vitest';
import { repositoryFactsOf } from '@momonga/memory';
import type { RunEventPayload } from '@momonga/protocol';
import { JournalThreadError } from '@momonga/store';
import { reflectionInputFor } from '../../src/memory/reflection-input.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { bash, fileTool } from './reflection-fixture.ts';
import { SHA, factsStore, seqOf } from './run-facts-fixture.ts';

vi.setConfig({ testTimeout: 120_000 });

const COMMANDS = ['npm test'];
const MANIFESTS = ['package.json'];

const verifiedJournal = (project: string): RunEventPayload[] => [
  ...fileTool('r1', 'Read', { path: path.join(project, 'package.json'), sha256: SHA, access: 'read' }),
  ...bash('t0', 'npm test', 1, 'one failure'),
  ...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SHA, access: 'write' }),
  ...bash('t1', 'npm test', 0, 'ok'),
];

const OUTPUT = 'x'.repeat(2_000);

const stepsJournal = (project: string, steps: number): RunEventPayload[] => [
  ...fileTool('w1', 'Write', { path: path.join(project, 'src/a.ts'), sha256: SHA, access: 'write' }),
  ...Array.from({ length: steps }, (_unused, index) => bash(`t${String(index).padStart(4, '0')}`, 'npm test', 0, OUTPUT)).flat(),
];

const serializedSize = (value: unknown): number => v8.serialize(value).length;

describe('the verdict request kind of the journal thread (inventory row 6)', () => {
  it('answers a verified run with the verdict and the repository facts written out by hand, and the lastSeq it read', async () => {
    const env = factsStore();
    const run = await env.finished(verifiedJournal(env.project));
    const events = env.allEvents(run.id);
    const client = await env.client();

    const reply = await client.verdict({ runId: run.id, commands: COMMANDS, manifests: MANIFESTS });

    expect(reply).toEqual({
      lastSeq: env.store.getRun(run.id)?.lastSeq,
      verified: true,
      facts: [
        {
          command: 'npm test',
          text: 'Run `npm test` to verify a change in this repository.',
          kind: 'procedure',
          check: { callId: 't1', seq: seqOf(events, 'tool.completed', 't1') },
          manifestPaths: [path.join(env.project, 'package.json')],
        },
      ],
    });
  });

  it('answers a run whose last check failed as not verified, with no facts', async () => {
    const env = factsStore();
    const run = await env.finished([...fileTool('w1', 'Write', { path: path.join(env.project, 'src/a.ts'), sha256: SHA, access: 'write' }), ...bash('t1', 'npm test', 1, 'failed')]);
    const client = await env.client();

    const reply = await client.verdict({ runId: run.id, commands: COMMANDS, manifests: MANIFESTS });

    expect(reply).toMatchObject({ verified: false, facts: [] });
  });

  it('answers a failed run as not verified even when its last check passed, because the verdict reads the status from the same snapshot', async () => {
    const env = factsStore();
    const run = await env.finished(verifiedJournal(env.project), 'FAILED');
    const client = await env.client();

    expect(await client.verdict({ runId: run.id, commands: COMMANDS, manifests: MANIFESTS })).toMatchObject({ verified: false, facts: [] });
  });

  it('gives the same facts as the main-thread path of today on a run with a manifest write between checks', async () => {
    const env = factsStore();
    const run = await env.finished([
      ...bash('t1', 'npm test', 0, 'ok'),
      ...fileTool('w1', 'Write', { path: path.join(env.project, 'package.json'), sha256: SHA, access: 'write' }),
      ...bash('t2', 'npm test', 0, 'ok'),
    ]);
    const today = { status: 'COMPLETED', events: env.allEvents(run.id), commands: COMMANDS, manifests: MANIFESTS };
    const client = await env.client();

    const reply = await client.verdict({ runId: run.id, commands: COMMANDS, manifests: MANIFESTS });

    expect(reply).toMatchObject({ verified: false, facts: repositoryFactsOf(today) });
  });
});

describe('the evidence request kind of the journal thread (inventory row 6)', () => {
  it('answers the latest recorded hash of each asked path, null for a path the run never touched, and the latest check after the last write to a bound path', async () => {
    const env = factsStore();
    const run = await env.finished(verifiedJournal(env.project));
    const events = env.allEvents(run.id);
    const client = await env.client();

    const reply = await client.evidence({
      runId: run.id,
      paths: [path.join(env.project, 'src/a.ts'), path.join(env.project, 'src/never.ts')],
      verificationCommands: COMMANDS,
    });

    expect(reply).toEqual({
      lastSeq: env.store.getRun(run.id)?.lastSeq,
      recorded: [{ sha256: SHA, seq: seqOf(events, 'tool.completed', 'w1') }, null],
      check: { callId: 't1', seq: seqOf(events, 'tool.completed', 't1'), command: 'npm test', exitCode: 0 },
    });
  });

  it('answers no check when a bound path was written after the last check', async () => {
    const env = factsStore();
    const run = await env.finished([...bash('t1', 'npm test', 0, 'ok'), ...fileTool('w1', 'Write', { path: path.join(env.project, 'src/a.ts'), sha256: SHA, access: 'write' })]);
    const client = await env.client();

    const reply = await client.evidence({ runId: run.id, paths: [path.join(env.project, 'src/a.ts')], verificationCommands: COMMANDS });

    expect(reply).toMatchObject({ check: null });
  });

  it('keeps only the check of the one command asked for', async () => {
    const env = factsStore();
    const run = await env.finished([...bash('t1', 'npm test', 0, 'ok'), ...bash('t2', 'npm run lint', 0, 'ok')]);
    const events = env.allEvents(run.id);
    const client = await env.client();

    const reply = await client.evidence({ runId: run.id, paths: [], verificationCommands: ['npm test', 'npm run lint'], onlyCommand: 'npm test' });

    expect(reply).toMatchObject({ recorded: [], check: { callId: 't1', seq: seqOf(events, 'tool.completed', 't1'), command: 'npm test', exitCode: 0 } });
  });
});

describe('the reflection_input request kind of the journal thread (inventory row 6)', () => {
  it('answers exactly the reflection input the main-thread path of today builds from the same journal', async () => {
    const env = factsStore();
    const run = await env.finished(stepsJournal(env.project, 12));
    const capabilities = capabilitiesFor(100_000);
    const today = reflectionInputFor(env.allEvents(run.id), env.project, capabilities);
    const client = await env.client();

    const reply = await client.reflectionInput({ runId: run.id, project: env.project, capabilities });

    expect(reply).toEqual({ lastSeq: env.store.getRun(run.id)?.lastSeq, input: today });
  });
});

describe('nothing proportional to journal bytes crosses the thread boundary (P10)', () => {
  const replies = async (steps: number) => {
    const env = factsStore();
    const run = await env.finished(stepsJournal(env.project, steps));
    const journalBytes = env.allEvents(run.id).reduce((bytes, event) => bytes + JSON.stringify(event).length, 0);
    const client = await env.client();
    const verdict = await client.verdict({ runId: run.id, commands: COMMANDS, manifests: MANIFESTS });
    const evidence = await client.evidence({ runId: run.id, paths: [path.join(env.project, 'src/a.ts')], verificationCommands: COMMANDS });
    const reflection = await client.reflectionInput({ runId: run.id, project: env.project, capabilities: capabilitiesFor(8_000) });
    return { journalBytes, verdict: serializedSize(verdict), evidence: serializedSize(evidence), reflection: serializedSize(reflection) };
  };

  it('keeps the verdict, evidence and reflection_input replies the same size at 15 and 1000 steps while the journal grows more than 50-fold', async () => {
    const small = await replies(15);
    const large = await replies(1000);

    expect(large.journalBytes).toBeGreaterThan(50 * small.journalBytes);
    expect(large.verdict).toBeLessThanOrEqual(small.verdict + 16);
    expect(large.evidence).toBeLessThanOrEqual(small.evidence + 16);
    expect(large.reflection).toBeLessThanOrEqual(small.reflection + 16);
  });
});

describe('request errors of the new kinds (O2, I1a reply rules)', () => {
  it.each(['verdict', 'evidence', 'reflectionInput'] as const)('rejects %s for an unknown run with a JournalThreadError and keeps serving', async (method) => {
    const env = factsStore();
    const client = await env.client();
    const requests = {
      verdict: () => client.verdict({ runId: 'run-unknown', commands: COMMANDS, manifests: MANIFESTS }),
      evidence: () => client.evidence({ runId: 'run-unknown', paths: [], verificationCommands: COMMANDS }),
      reflectionInput: () => client.reflectionInput({ runId: 'run-unknown', project: env.project, capabilities: capabilitiesFor(100_000) }),
    };

    await expect(requests[method]()).rejects.toBeInstanceOf(JournalThreadError);
    expect(await client.ping()).toMatchObject({ threadId: expect.any(Number) });
  });

  it.each(['verdict', 'evidence', 'reflection_input'])('treats a %s request without a run id as a request error, not a thread death', async (kind) => {
    const env = factsStore();
    const client = await env.client();
    const before = await client.ping();

    const failure = await client.request({ kind, project: env.project, commands: [], manifests: [], paths: [], verificationCommands: [] }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(JournalThreadError);
    expect((failure as Error).message).not.toContain('unknown journal thread request kind');
    expect((await client.ping()).threadId).toBe(before.threadId);
  });
});
