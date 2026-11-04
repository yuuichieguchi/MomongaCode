import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { RunEventPayload, ToolKind } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { killGroupsForCleanup } from '@momonga/testkit';
import { START_MS, toolKey } from './harness.ts';
import type { Env } from './harness.ts';
import { functionCallItem, requestedOffering } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

export const RECONCILE_FAILURE_PREFIX = 'Started tool calls could not be reconciled before the run was cancelled: ';
export const ABANDONED_OUTPUT =
  'The call was interrupted and could not be reconciled before the run was cancelled. Its effect is unknown; inspect the current state before retrying it.';

const groups: number[] = [];

afterEach(async () => {
  await killGroupsForCleanup(groups.splice(0));
});

export const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export type StartedCall = { callId: string; name: string; kind?: ToolKind; args?: Record<string, unknown> };

export const seedStartedCalls = (env: Env, calls: readonly StartedCall[], options: { cancel?: boolean } = {}) => {
  const run = env.enqueue('Work');
  const keys = Object.fromEntries(calls.map((call) => [call.callId, toolKey(run.id, 1, call.callId)]));
  const payloads: RunEventPayload[] = [
    requestedOffering(1, [...new Set(calls.map((call) => call.name))]),
    {
      type: 'model.responded',
      step: 1,
      attempt: 1,
      response: { status: 'completed', output: calls.map((call) => functionCallItem({ callId: call.callId, name: call.name, args: call.args ?? { value: 'x' } })), usage: USAGE },
    },
    ...calls.flatMap((call): RunEventPayload[] => [
      { type: 'tool.call', callId: call.callId, providerCallId: call.callId, name: call.name, kind: call.kind ?? 'edit', title: call.name, rawInput: call.args ?? { value: 'x' } },
      { type: 'tool.started', callId: call.callId, idemKey: keys[call.callId] as string },
    ]),
  ];
  env.seed(run.id, payloads, 'crash');
  for (const call of calls) env.store.idempotency.begin(keys[call.callId] as string, { expiresAt: START_MS + 86_400_000, meta: { tool: call.name } });
  if (options.cancel !== false && env.cancel(run.id).status !== 'CANCELLING') throw new Error('expected the run to be CANCELLING');
  return { run, keys };
};

export const spawnMarkerHolder = (env: Env, key: string, script = 'exec sleep 30'): number => {
  const marker = path.join(env.markers, key);
  const fd = fs.openSync(marker, 'w', 0o600);
  let pid: number | undefined;
  try {
    pid = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] }).pid;
  } finally {
    fs.closeSync(fd);
  }
  if (pid === undefined) throw new Error('the marker holder did not spawn');
  groups.push(pid);
  env.store.idempotency.attachProcess(key, { pgid: pid, startedAt: START_MS });
  return pid;
};

export type RecordingStore = RuntimeStore & {
  appends: Array<{ runId: string; types: string[]; payloads: readonly RunEventPayload[] }>;
  onCancelled: Array<() => void>;
};

export const recordingStore = (env: Env): RecordingStore => {
  const appends: RecordingStore['appends'] = [];
  const onCancelled: Array<() => void> = [];
  return {
    ...env.store,
    appends,
    onCancelled,
    append: (claim, payloads) => {
      if (payloads.length > 0) appends.push({ runId: claim.runId, types: payloads.map((payload) => payload.type), payloads });
      return env.store.append(claim, payloads);
    },
    transition: (claim, from, to, patch) => {
      if (to === 'CANCELLED') for (const hook of onCancelled) hook();
      return env.store.transition(claim, from, to, patch);
    },
  };
};

export const fatalStoreError = (message = 'database disk image is malformed'): Error =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode: 11, errstr: 'database disk image is malformed' });

