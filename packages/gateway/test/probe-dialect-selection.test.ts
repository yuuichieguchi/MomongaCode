import { afterEach, describe, expect, it } from 'vitest';
import { vocabularyOf, runProbe } from '@momonga/gateway';
import type { ProbeReport } from '@momonga/protocol';
import { collectAllowedNames, generateInstance, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsOptions, FakeChatCompletionsServer, FakeRoute, FakeScriptedReply } from '@momonga/testkit';
import { FM_SERVER } from '@momonga/protocol';
import { FM_PROBE_ROUTES } from './fm-record-support.ts';
import { probePortsAt } from './probe-ports-support.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const BUILTIN_ORDER = ['json-schema-2020-12', 'inlined-subset', 'strict-closed', 'explicit-keys'];

const fixedNow = () => new Date('2026-11-06T00:00:00.000Z');

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const probe = async (options: FakeChatCompletionsOptions, extra: Json = {}): Promise<{ report: ProbeReport; fake: FakeChatCompletionsServer }> => {
  const fake = await startFakeChatCompletions(options);
  servers.push(fake);
  const report = await runProbe({ socketPath: fake.socketPath, managed: FM_PROBE_ROUTES, ports: probePortsAt(fixedNow), samples: 2, ...extra });
  return { report, fake };
};

const triedOf = (report: ProbeReport) => report.schemaDialect.tried.map(({ id, result }) => ({ id, result }));

const responseFormatSchema = (body: unknown): unknown => {
  if (!isRecord(body) || !isRecord(body['response_format'])) return undefined;
  const format = body['response_format'];
  return isRecord(format['json_schema']) ? format['json_schema']['schema'] : undefined;
};

const toolParameters = (body: unknown): unknown[] => {
  if (!isRecord(body) || !Array.isArray(body['tools'])) return [];
  return body['tools'].map((tool) => (isRecord(tool) && isRecord(tool['function']) ? tool['function']['parameters'] : undefined));
};

const schemasOf = (body: unknown): unknown[] => {
  const format = responseFormatSchema(body);
  return [...(format === undefined ? [] : [format]), ...toolParameters(body)];
};

const lastUserText = (body: unknown): string => {
  const messages = isRecord(body) && Array.isArray(body['messages']) ? body['messages'] : [];
  const users = messages.filter((message) => isRecord(message) && message['role'] === 'user');
  const last = users.at(-1);
  return isRecord(last) && typeof last['content'] === 'string' ? last['content'] : '';
};

const schemaRefusal = (message: string): FakeScriptedReply => ({
  kind: 'error',
  status: 400,
  body: { error: { message, type: 'invalid_request_error', param: null, code: null } },
});

const contentReply = (content: string): FakeScriptedReply => ({
  kind: 'stream',
  chunks: [{ delta: { role: 'assistant', content } }, { delta: {}, finishReason: 'stop' }],
});

const everyNode = (schema: unknown, visit: (node: Json) => boolean): boolean => {
  if (Array.isArray(schema)) return schema.every((element) => everyNode(element, visit));
  if (!isRecord(schema)) return true;
  if (!visit(schema)) return false;
  return Object.values(schema).every((child) => everyNode(child, visit));
};

const isStrict = (schema: unknown): boolean =>
  everyNode(schema, (node) => {
    const isObject = node['type'] === 'object' || isRecord(node['properties']);
    if (!isObject) return true;
    if (node['additionalProperties'] !== false) return false;
    const names = isRecord(node['properties']) ? Object.keys(node['properties']) : [];
    const required = Array.isArray(node['required']) ? node['required'] : [];
    return names.every((name) => required.includes(name));
  });

const carriesRef = (schema: unknown): boolean => !everyNode(schema, (node) => !('$ref' in node));

const allowedOf = (node: Json): unknown[] => ('const' in node ? [node['const']] : Array.isArray(node['enum']) ? node['enum'] : []);

const branchFor = (branches: unknown[], wanted: string | undefined): unknown => {
  const keyed = branches.find((branch) => {
    if (!isRecord(branch) || !isRecord(branch['properties'])) return false;
    const properties = branch['properties'];
    if (wanted === undefined) return isRecord(properties['kind']) && allowedOf(properties['kind']).includes('final');
    if (isRecord(properties['kind'])) return allowedOf(properties['kind']).includes('tool_calls');
    return isRecord(properties['name']) && allowedOf(properties['name']).includes(wanted);
  });
  return keyed ?? branches[0];
};

const nullPreferring = (schema: unknown, wanted: string | undefined): unknown => {
  if (!isRecord(schema)) return null;
  const branches = schema['anyOf'];
  if (Array.isArray(branches)) {
    if (branches.some((branch) => isRecord(branch) && branch['type'] === 'null')) return null;
    return nullPreferring(branchFor(branches, wanted), wanted);
  }
  if (isRecord(schema['properties'])) {
    return Object.fromEntries(Object.entries(schema['properties']).map(([name, child]) => [name, nullPreferring(child, wanted)]));
  }
  if (schema['type'] === 'array') {
    const count = typeof schema['minItems'] === 'number' && schema['minItems'] > 1 ? schema['minItems'] : 1;
    return Array.from({ length: count }, () => nullPreferring(schema['items'], wanted));
  }
  return generateInstance(schema, wanted === undefined ? {} : { requiredToolName: wanted });
};

const wantedToolOf = (schema: unknown, body: unknown): string | undefined => {
  const text = lastUserText(body);
  const names = collectAllowedNames(schema).filter((name) => name !== 'final' && name !== 'tool_calls' && text.includes(name));
  return names.sort((left, right) => right.length - left.length)[0];
};

const strictClosedChecker: FakeRoute[] = [
  {
    match: (body) => schemasOf(body).some((schema) => !isStrict(schema) || carriesRef(schema)),
    reply: schemaRefusal('Invalid schema: strict mode needs every object closed and every property required'),
  },
  {
    match: (body) => responseFormatSchema(body) !== undefined,
    reply: (body) => {
      const schema = responseFormatSchema(body);
      return contentReply(JSON.stringify(nullPreferring(schema, wantedToolOf(schema, body))));
    },
  },
];

describe('selection by measurement (rule 4)', () => {
  it('selects json-schema-2020-12 first on a server that enforces any schema, and records the shape', async () => {
    const { report } = await probe({ scenario: 'tools-ok' });
    expect(report.schemaDialect.selected).toBe('json-schema-2020-12');
    expect(report.schemaDialect.shape).toBe('union');
    expect(triedOf(report)).toEqual([{ id: 'json-schema-2020-12', result: 'accepted' }]);
    expect(report.keywordSupport).toBeDefined();
    expect(report.constructSupport).toEqual({ ref: 'accepted', typeArray: 'accepted', mixedEnum: 'accepted' });
  });

  it('tries the built-ins in their fixed order and selects explicit-keys on the fm decoder', async () => {
    const { report } = await probe({ scenario: 'tools-ok', wire: 'fm', contextWindow: 4096, contextSizeExposure: 'none' }, { vocabulary: vocabularyOf(FM_SERVER) });
    expect(report.schemaDialect.selected).toBe('explicit-keys');
    expect(report.schemaDialect.shape).toBe('union');
    expect(triedOf(report)).toEqual([
      { id: 'json-schema-2020-12', result: 'refused' },
      { id: 'inlined-subset', result: 'refused' },
      { id: 'strict-closed', result: 'refused' },
      { id: 'explicit-keys', result: 'accepted' },
    ]);
    expect(report.keywordSupport?.enum).toBe(true);
    expect(report.keywordSupport?.anyOf).toBe(true);
  });

  it('selects strict-closed on a strict checker that answers null for an optional property, reading the reply through invertReply', async () => {
    const { report, fake } = await probe({ scenario: 'tools-ok', routes: strictClosedChecker });
    expect(triedOf(report)).toEqual([
      { id: 'json-schema-2020-12', result: 'refused' },
      { id: 'inlined-subset', result: 'refused' },
      { id: 'strict-closed', result: 'accepted' },
    ]);
    expect(report.schemaDialect.selected).toBe('strict-closed');
    expect(report.constructSupport?.ref).toBe('unrenderable');
    const sent = fake.requests.filter((request) => request.path === '/v1/chat/completions').flatMap((request) => schemasOf(request.body));
    expect(sent.some(carriesRef)).toBe(false);
  });

  it('records not-enforced for a server that returns a fixed final reply whatever the schema, and measures no tables', async () => {
    const routes: FakeRoute[] = [{ match: (body) => responseFormatSchema(body) !== undefined, reply: () => contentReply('{"kind":"final","text":"hi"}') }];
    const { report } = await probe({ scenario: 'tools-ok', routes });
    expect(report.schemaDialect.selected).toBeNull();
    expect(report.schemaDialect.shape).toBeNull();
    expect([...new Set(report.schemaDialect.tried.map(({ id }) => id))]).toEqual(BUILTIN_ORDER);
    expect(report.schemaDialect.tried.every(({ result }) => result === 'not-enforced')).toBe(true);
    expect(report.keywordSupport).toBeUndefined();
    expect(report.constructSupport).toBeUndefined();
    expect(report.nativeTools.accepted).toBe(true);
  });

  it('records not-enforced for a flat-shape server that ignores kind', async () => {
    const routes: FakeRoute[] = [
      { match: (body) => isRecord(responseFormatSchema(body)) && 'anyOf' in (responseFormatSchema(body) as Json), reply: schemaRefusal('anyOf is not supported') },
      { match: (body) => responseFormatSchema(body) !== undefined, reply: () => contentReply('{"kind":"final","text":"hi"}') },
    ];
    const { report } = await probe({ scenario: 'tools-ok', routes });
    expect(report.schemaDialect.selected).toBeNull();
    expect(report.schemaDialect.tried.some(({ result }) => result === 'not-enforced')).toBe(true);
    expect(report.schemaDialect.tried.some(({ result }) => result === 'accepted')).toBe(false);
  });

  it('selects a user dialect after every built-in when only its rules satisfy the server', async () => {
    const marked = (schema: unknown) => isRecord(schema) && schema['x-mark'] === true;
    const routes: FakeRoute[] = [
      { match: (body) => schemasOf(body).some((schema) => !marked(schema)), reply: schemaRefusal('Invalid schema: x-mark is required') },
    ];
    const userDialects = { marked: { rules: [{ select: [{ kinds: ['root'] }, { kinds: ['tool-parameters'] }], op: 'ensure-key', key: 'x-mark', value: true }] } };
    const { report } = await probe({ scenario: 'tools-ok', routes }, { userDialects });
    expect(report.schemaDialect.selected).toBe('marked');
    expect(triedOf(report)).toEqual([...BUILTIN_ORDER.map((id) => ({ id, result: 'refused' })), { id: 'marked', result: 'accepted' }]);
  });
});

describe('a declared dialect is not searched', () => {
  it('tries only the declared dialect and records it accepted', async () => {
    const { report } = await probe({ scenario: 'tools-ok' }, { declaredDialect: 'strict-closed' });
    expect(triedOf(report)).toEqual([{ id: 'strict-closed', result: 'accepted' }]);
    expect(report.schemaDialect.selected).toBe('strict-closed');
  });

  it('records the declared dialect refused with the server reason and selects none', async () => {
    const { report } = await probe({ scenario: 'tools-ok', routes: strictClosedChecker }, { declaredDialect: 'explicit-keys' });
    expect(triedOf(report)).toEqual([{ id: 'explicit-keys', result: 'refused' }]);
    expect(report.schemaDialect.tried[0]?.detail).toContain('strict mode');
    expect(report.schemaDialect.selected).toBeNull();
    expect(report.keywordSupport).toBeUndefined();
  });
});

describe('the construct table, measured after selection (decision e (iii))', () => {
  it('records ref refused on a server that refuses $ref and accepts the rest', async () => {
    const routes: FakeRoute[] = [{ match: (body) => schemasOf(body).some(carriesRef), reply: schemaRefusal('undefinedReferences') }];
    const { report } = await probe({ scenario: 'tools-ok', routes });
    expect(report.schemaDialect.selected).toBe('json-schema-2020-12');
    expect(report.constructSupport).toEqual({ ref: 'refused', typeArray: 'accepted', mixedEnum: 'accepted' });
  });

  it('records each construct refused when the server refuses type arrays and mixed enums', async () => {
    const typeArray = (schema: unknown) => !everyNode(schema, (node) => !Array.isArray(node['type']));
    const mixedEnum = (schema: unknown) =>
      !everyNode(schema, (node) => !Array.isArray(node['enum']) || new Set((node['enum'] as unknown[]).map((value) => (value === null ? 'null' : typeof value))).size < 2);
    const routes: FakeRoute[] = [{ match: (body) => schemasOf(body).some((schema) => typeArray(schema) || mixedEnum(schema)), reply: schemaRefusal('typeMismatch') }];
    const { report } = await probe({ scenario: 'tools-ok', routes });
    expect(report.schemaDialect.selected).toBe('json-schema-2020-12');
    expect(report.constructSupport).toEqual({ ref: 'accepted', typeArray: 'refused', mixedEnum: 'refused' });
  });
});
