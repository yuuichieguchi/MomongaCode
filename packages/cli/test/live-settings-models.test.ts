import { describe, expect, it } from 'vitest';
import type { UserModels } from '@momonga/config';
import { liveSettingsFor } from '../src/eval/context-host.ts';
import { userModelsOf } from './user-models.ts';

const WORKER = 'p/worker-model';
const GUARD = 'p/guard-model';

const entry = (id: string) => ({ id, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } });

const userModels = (): UserModels =>
  userModelsOf({ connections: [{ adapter: 'chat-completions', provider: 'p', baseUrl: 'http://127.0.0.1:8080/v1', models: [entry('worker-model'), entry('guard-model'), entry('plain-model')] }] });

const idsOf = (settings: ReturnType<typeof liveSettingsFor>): (string | undefined)[][] => (settings.models.connections ?? []).map((connection) => (connection.models ?? []).map((model) => model.id));

describe('liveSettingsFor takes a list of models (N1)', () => {
  it('copies the one model of a list of one, and makes it the model new sessions start with', () => {
    const settings = liveSettingsFor(userModels(), [GUARD]);
    expect(idsOf(settings)).toEqual([['guard-model']]);
    expect(settings.models.start).toBe(GUARD);
    expect(settings.credentials).toEqual([]);
    expect(settings.managedTargets).toEqual([]);
  });

  it('unites the models of each listed model under their one server, the first listed starting new sessions', () => {
    const settings = liveSettingsFor(userModels(), [WORKER, GUARD]);
    expect(idsOf(settings)).toEqual([['worker-model', 'guard-model']]);
    expect(settings.models.start).toBe(WORKER);
  });

  it('copies a model once when the agent and the classifier are the same model', () => {
    const settings = liveSettingsFor(userModels(), [GUARD, GUARD]);
    expect(idsOf(settings)).toEqual([['guard-model']]);
  });
});
