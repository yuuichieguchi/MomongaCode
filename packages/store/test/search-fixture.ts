import fs from 'node:fs';
import path from 'node:path';
import { createRedactor } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import type { Run, RuntimeStore } from '@momonga/store';
import { enqueue, mustRun, newSession } from './helpers.ts';

export const FAKE_KEY = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789';

export const redactor = createRedactor({ credentials: [] });

export const projectDir = (root: string, name: string): string => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  return fs.realpathSync.native(directory);
};

export type ToolStep = { name: string; path: string; output: string; handle?: string };

export type StepSpec = { text?: string; tool?: ToolStep };

export type Outcome = 'COMPLETED' | 'FAILED' | 'CANCELLED';

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const assistantItem = (id: string, text: string) => ({ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] });

export const stepEvents = (step: number, spec: StepSpec): RunEventPayload[] => {
  const callId = `call-${step}`;
  const output = spec.text === undefined ? [] : [assistantItem(`m${step}`, spec.text)];
  const events = [
    { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: {} },
    { type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage } },
  ] as unknown as RunEventPayload[];
  if (spec.tool === undefined) return events;
  const { name, path: file, output: toolOutput, handle } = spec.tool;
  return [
    ...events,
    { type: 'tool.call', callId, providerCallId: callId, name, kind: 'read', title: `${name} ${file}`, rawInput: { file_path: file }, locations: [{ path: file }] },
    { type: 'tool.completed', callId, status: 'completed', output: toolOutput, ...(handle === undefined ? {} : { handle, truncated: true }) },
  ];
};

export const openRun = (store: RuntimeStore, cwd: string, task: string, steps: readonly StepSpec[] = []) => {
  const session = newSession(store, cwd);
  const run = enqueue(store, session.id, task);
  const claim = store.claim(`worker-${run.id}`);
  if (claim?.runId !== run.id) throw new Error(`expected to claim ${run.id}`);
  const appended = store.append(claim, steps.flatMap((spec, index) => stepEvents(index + 1, spec)));
  if (appended.kind !== 'ok') throw new Error(`append failed: ${appended.kind}`);
  const finish = async (outcome: Outcome = 'COMPLETED'): Promise<Run> => {
    if (outcome === 'CANCELLED') {
      const cancelling = await store.transition(claim, ['RUNNING'], 'CANCELLING');
      if (cancelling.kind !== 'ok') throw new Error(`cancelling failed: ${cancelling.kind}`);
      const cancelled = await store.transition({ ...claim, status: 'CANCELLING' }, ['CANCELLING'], 'CANCELLED');
      if (cancelled.kind !== 'ok') throw new Error(`cancel failed: ${cancelled.kind}`);
      return mustRun(store, run.id);
    }
    const patch = outcome === 'FAILED' ? { error: { code: 'fixture', message: 'fixture failure' } } : {};
    const finished = await store.transition(claim, ['RUNNING'], outcome, patch);
    if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.kind}`);
    return mustRun(store, run.id);
  };
  return { session, run, claim, finish };
};

export const finishedRun = async (store: RuntimeStore, cwd: string, task: string, steps: readonly StepSpec[] = [], outcome: Outcome = 'COMPLETED'): Promise<Run> => openRun(store, cwd, task, steps).finish(outcome);

export const indexAll = async (store: RuntimeStore): Promise<void> => {
  await store.search.indexBatch({ limit: 1000, redactor });
};
