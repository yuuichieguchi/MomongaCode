import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as protocol from '../src/index.ts';
import { RUN_API_SCHEMAS, isToolCallingState } from '../src/index.ts';
import type {
  Capabilities,
  ChainCapabilities,
  ChainMemberEntry,
  ErrorBody,
  MomongaModelEntry,
  MomongaModelList,
  MomongaResponseExtension,
  PlanTargetResponse,
  ProbingCapabilities,
  SessionEventPayload,
  TargetBilling,
  UnavailableCapabilities,
} from '../src/index.ts';

const schemas = RUN_API_SCHEMAS as unknown as Record<string, Record<string, unknown>>;

const ajv = (() => {
  const built = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(built);
  for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string') built.addSchema(schema);
  return built;
})();

const accepts = (name: string, value: unknown): boolean => {
  const schema = schemas[name];
  if (schema === undefined) throw new Error(`RUN_API_SCHEMAS has no ${name}`);
  const validate = typeof schema['$id'] === 'string' ? ajv.getSchema(schema['$id']) : ajv.compile(schema);
  if (validate === undefined) throw new Error(`${name} did not compile`);
  return validate(value) === true;
};

const constant = (name: string): unknown => (protocol as Record<string, unknown>)[name];

const SESSION_EVENT = { id: 4, sessionId: 'sess-1', createdAt: 1_800_000_000_000 };
const UNAVAILABLE = { state: 'unavailable', status: 412, type: 'invalid_request', message: 'm', param: 'model' };

describe('the models listing of the gateway names every model by its canonical reference', () => {
  it('an entry holds id, provider, ownName, an optional defaultTag, billing, capabilities and its chain', () => {
    expectTypeOf<keyof MomongaModelEntry>().toEqualTypeOf<'id' | 'object' | 'provider' | 'ownName' | 'defaultTag' | 'billing' | 'capabilities' | 'state' | 'chain'>();
    expectTypeOf<MomongaModelEntry['provider']>().toEqualTypeOf<string>();
    expectTypeOf<MomongaModelEntry['ownName']>().toEqualTypeOf<string>();
    expectTypeOf<MomongaModelEntry['defaultTag']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<MomongaModelEntry['billing']>().toEqualTypeOf<TargetBilling>();
    expectTypeOf<MomongaModelEntry['capabilities']>().toEqualTypeOf<ChainCapabilities | ProbingCapabilities | UnavailableCapabilities>();
    expectTypeOf<MomongaModelEntry['chain']>().toEqualTypeOf<ChainMemberEntry[]>();
    expectTypeOf<keyof ChainMemberEntry>().toEqualTypeOf<'model' | 'counter' | 'billing' | 'provider' | 'adapter' | 'answers' | 'upstream' | 'plan' | 'key' | 'capabilities'>();
    expectTypeOf<ChainMemberEntry['answers']>().toEqualTypeOf<'model' | 'script'>();
    expectTypeOf<ChainMemberEntry['capabilities']>().toEqualTypeOf<Capabilities | ProbingCapabilities | UnavailableCapabilities>();
    const entry: MomongaModelEntry = {
      id: 'ollama/gemma-3-4b:latest',
      object: 'model',
      provider: 'ollama',
      ownName: 'gemma-3-4b:latest',
      defaultTag: 'latest',
      billing: 'local',
      capabilities: { toolCalling: { state: 'probing', message: 'm', retryAfterSeconds: 1 }, source: 'unprobed' } as unknown as ProbingCapabilities,
      state: 'available',
      chain: [],
    };
    expect(Object.keys(entry)).toEqual(['id', 'object', 'provider', 'ownName', 'defaultTag', 'billing', 'capabilities', 'state', 'chain']);
    expect(constant('MODEL_NOT_LISTED_CODE')).toBe('model_not_listed');
  });

  it('the list holds the start model, or null, and the roles', () => {
    expectTypeOf<keyof MomongaModelList>().toEqualTypeOf<'object' | 'data' | 'start' | 'roles'>();
    expectTypeOf<MomongaModelList['start']>().toEqualTypeOf<string | null>();
    expectTypeOf<MomongaModelList['roles']>().toEqualTypeOf<{ compaction?: string; reflection?: string; analysis?: string }>();
    const none: MomongaModelList = { object: 'list', data: [], start: null, roles: {} };
    expect(none.start).toBeNull();
    expect(accepts('SessionView', { id: 's', cwd: '/w', permissionMode: 'manual', model: 'ollama/gemma-3-4b:latest', bypassAllowed: false, createdAt: 1, envKeys: [], activeRunId: null, activeRunAt: null, latestRunId: null, latestRunAt: null, additionalDirectories: [], lastEventId: 0 })).toBe(true);
  });

  it('an entry has no alias, modelAlias, targets or per-target map', () => {
    expectTypeOf<MomongaModelEntry>().not.toHaveProperty('alias');
    expectTypeOf<MomongaModelEntry>().not.toHaveProperty('modelAlias');
    expectTypeOf<MomongaModelEntry>().not.toHaveProperty('targets');
    expectTypeOf<MomongaModelEntry>().not.toHaveProperty('targetCounters');
    expectTypeOf<MomongaModelEntry>().not.toHaveProperty('targetCapabilities');
    expectTypeOf<MomongaModelEntry>().not.toHaveProperty('targetBilling');
    expectTypeOf<MomongaModelEntry>().not.toHaveProperty('targetPlan');
    expectTypeOf<MomongaModelEntry>().not.toHaveProperty('targetKey');
    expect(accepts('SessionView', { id: 's', cwd: '/w', permissionMode: 'manual', modelAlias: 'fm', bypassAllowed: false, createdAt: 1, envKeys: [], activeRunId: null, activeRunAt: null, latestRunId: null, latestRunAt: null, additionalDirectories: [], lastEventId: 0 })).toBe(false);
  });

  it('model.changed carries model and previousModel', () => {
    expectTypeOf<Extract<SessionEventPayload, { type: 'model.changed' }>>().toEqualTypeOf<{ type: 'model.changed'; model: string; previousModel: string }>();
    expect(accepts('PublicRunEvent', { ...SESSION_EVENT, type: 'model.changed', model: 'ollama/gemma-3-4b:latest', previousModel: 'lmstudio/gemma-3-4b' })).toBe(true);
    expect(accepts('PublicRunEvent', { ...SESSION_EVENT, type: 'model.changed', modelAlias: 'fast', previousModelAlias: 'default' })).toBe(false);
  });

  it('the plan route answers with the model it added', () => {
    expectTypeOf<PlanTargetResponse>().toEqualTypeOf<{ model: string }>();
    const response: PlanTargetResponse = { model: 'chatgpt/gpt-5.5' };
    expect(Object.keys(response)).toEqual(['model']);
    expect(accepts('PatchSessionRequest', { model: 'chatgpt/gpt-5.5' })).toBe(true);
  });

  it('a request names its model in the field model, and no body or error body holds an alias', () => {
    expectTypeOf<ErrorBody>().not.toHaveProperty('alias');
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, model: 'devstral-small-2' })).toBe(true);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, modelAlias: 'fm' })).toBe(false);
    expect(accepts('PatchSessionRequest', { modelAlias: 'fm' })).toBe(false);
  });

  it('the response extension names the model the request resolved to, the member that answered and the members that failed', () => {
    expectTypeOf<MomongaResponseExtension['model']>().toEqualTypeOf<string>();
    expectTypeOf<MomongaResponseExtension['target']>().toEqualTypeOf<string>();
    expectTypeOf<MomongaResponseExtension['counter']>().toEqualTypeOf<string>();
    expectTypeOf<MomongaResponseExtension['fallbackFrom']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<MomongaResponseExtension>().not.toHaveProperty('alias');
    expect((constant('MOMONGA_REQUEST_FIELDS') as Record<string, unknown>)['exactModel']).toBe('momonga.exact_model');
  });

  it('the codes of the unavailable states are defined once and accepted as a tool calling state', () => {
    expect([constant('CHAIN_ROOM_REFUSED_CODE'), constant('MODEL_ID_CHANGED_CODE'), constant('MODEL_NOT_LISTED_CODE')]).toEqual(['chain_room_refused', 'model_id_changed', 'model_not_listed']);
    for (const code of ['chain_room_refused', 'model_id_changed', 'model_not_listed']) expect(isToolCallingState({ ...UNAVAILABLE, code }), code).toBe(true);
  });
});
