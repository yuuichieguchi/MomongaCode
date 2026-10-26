import type { InputItem, RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { GatewayRequestError } from '@momonga/runtime';
import type { Env, WorkerOverrides } from './harness.ts';
import { callsStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

export const WITHIN_TURN_PROMPT = 'You are the within-turn test agent.';

export const bigTool = (description = 'Return a block of text'): AnyTool =>
  defineTool<Record<string, unknown>>({
    name: 'Big',
    description,
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: {
      type: 'object',
      properties: { letter: { type: 'string' }, size: { type: 'integer' }, pad: { type: 'string' } },
      required: ['letter', 'size', 'pad'],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    title: () => 'Big',
    subject: () => ({ kind: 'none', tool: 'Big' }),
    execute: async (input) => ({ status: 'completed', output: String(input['letter']).repeat(Number(input['size'])) }),
  });

export const withinTurnWorker = (description?: string): WorkerOverrides => ({
  toolList: () => [bigTool(description)],
  systemPrompt: () => WITHIN_TURN_PROMPT,
});

export const bigStep = (scriptId: string, args: { letter: string; size: number; pad: string }): ScriptStep =>
  callsStep([{ callId: scriptId, name: 'Big', args }]);

export const padOf = (index: number, length: number): string => String(index).padEnd(length, 'p');

export const gatewayError = (status: number, type: ConstructorParameters<typeof GatewayRequestError>[0]['type'], code: string): GatewayRequestError =>
  new GatewayRequestError({ status, type, code, message: `the gateway answered ${code}` });

export const inputOf = (body: { input?: unknown }): InputItem[] => {
  if (!Array.isArray(body.input)) throw new Error('expected an input array');
  return body.input as InputItem[];
};

export const outputTextFor = (items: readonly InputItem[], callId: string): string | undefined => {
  const found = items.find((item) => item.type === 'function_call_output' && item.call_id === callId);
  return found?.type === 'function_call_output' && typeof found.output === 'string' ? found.output : undefined;
};

export const OMITTED = /^\[tool output omitted: \d+ tokens; stored as [0-9a-f]{64}; read it with ReadOutput\]$/;

export type AppendRecorder = { store: RuntimeStore; appends: RunEventPayload[][] };

export const recordingStore = (env: Env, intercept?: (payloads: readonly RunEventPayload[]) => void): AppendRecorder => {
  const appends: RunEventPayload[][] = [];
  const store: RuntimeStore = {
    ...env.store,
    append: (claim, payloads) => {
      appends.push([...payloads]);
      intercept?.(payloads);
      return env.store.append(claim, payloads);
    },
  };
  return { store, appends };
};

export const stealLease = (env: Env): void => {
  env.clock.advance(60_000);
  const thief = env.store.claim('worker-thief');
  if (thief === null) throw new Error('the thief could not claim the run');
  const released = env.store.release(thief, 'QUEUED');
  if (released.kind !== 'ok') throw new Error('the thief could not release the run');
};
