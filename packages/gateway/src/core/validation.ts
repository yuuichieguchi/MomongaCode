import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import { canonicalJson, isRecord } from '@momonga/foundation';
import { MIN_SUMMARY_TOKENS, OPEN_RESPONSES_OPENAPI } from '@momonga/protocol';
import type { CompactRequest, CountTokensRequest, CreateResponseBody } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';

const SPEC_ID = 'https://momonga.invalid/open-responses/2026-04-24/openapi.json';
const REF_PREFIX = '#/components/schemas/';
const STRUCTURAL_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf', 'if', 'then', 'else', 'not']);

type SchemaObject = Record<string, unknown>;

const requireRecord = (value: unknown, where: string): SchemaObject => {
  if (!isRecord(value)) throw new TypeError(`Open Responses spec: expected an object at ${where}`);
  return value;
};

const stringValues = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const enumValuesOf = (property: unknown): string[] => {
  if (!isRecord(property)) return [];
  const direct = stringValues(property['enum']);
  if (direct.length > 0) return direct;
  const branches = property['anyOf'];
  return Array.isArray(branches) ? branches.flatMap((branch) => enumValuesOf(branch)) : [];
};

type ItemBranch = { component: string; types: Set<string>; roles: Set<string> };

const itemBranchesOf = (schemas: SchemaObject): ItemBranch[] => {
  const union = requireRecord(schemas['ItemParam'], 'ItemParam');
  const refs = union['oneOf'];
  if (!Array.isArray(refs)) throw new TypeError('Open Responses spec: ItemParam has no oneOf');
  return refs.map((entry) => {
    const ref = requireRecord(entry, 'ItemParam.oneOf')['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) throw new TypeError(`Open Responses spec: unexpected ItemParam ref ${String(ref)}`);
    const component = ref.slice(REF_PREFIX.length);
    const properties = requireRecord(requireRecord(schemas[component], component)['properties'], `${component}.properties`);
    return {
      component,
      types: new Set(enumValuesOf(properties['type'])),
      roles: new Set(enumValuesOf(properties['role'])),
    };
  });
};

const jsonPointerSegments = (instancePath: string): string[] =>
  instancePath === '' ? [] : instancePath.slice(1).split('/').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

const joinParam = (segments: readonly string[]): string | null => {
  let param = '';
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) param += `[${segment}]`;
    else param += param === '' ? segment : `.${segment}`;
  }
  return param === '' ? null : param;
};

type Issue = { segments: string[]; message: string };

const issueOf = (errors: readonly ErrorObject[], prefix: readonly string[]): Issue => {
  const first = errors.find((error) => !STRUCTURAL_KEYWORDS.has(error.keyword)) ?? errors[0];
  if (first === undefined) throw new Error('validation failed without reporting an error');
  const segments = [...prefix, ...jsonPointerSegments(first.instancePath)];
  if (first.keyword === 'required') segments.push(String((first.params as { missingProperty: unknown }).missingProperty));
  return { segments, message: first.message ?? 'is invalid' };
};

const throwIssue = (issue: Issue): never => {
  const param = joinParam(issue.segments);
  throw invalidRequest('invalid_body', `${param ?? 'request body'} ${issue.message}`, param);
};

type SpecKit = {
  compile(component: string): ValidateFunction;
  branches: ItemBranch[];
  branchValidators: Map<string, ValidateFunction>;
  streamSchemas: Map<string, ValidateFunction>;
};

const streamSchemaNames = (spec: SchemaObject, schemas: SchemaObject): Map<string, string> => {
  const paths = requireRecord(spec['paths'], 'paths');
  const post = requireRecord(requireRecord(paths['/responses'], 'paths./responses')['post'], 'post');
  const ok = requireRecord(requireRecord(post['responses'], 'responses')['200'], 'responses.200');
  const stream = requireRecord(requireRecord(ok['content'], 'content')['text/event-stream'], 'text/event-stream');
  const variants = requireRecord(stream['schema'], 'schema')['oneOf'];
  if (!Array.isArray(variants)) throw new TypeError('Open Responses spec: text/event-stream schema has no oneOf');
  const names = new Map<string, string>();
  for (const variant of variants) {
    const ref = requireRecord(variant, 'oneOf entry')['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) throw new TypeError(`Open Responses spec: unexpected stream event ref ${String(ref)}`);
    const component = ref.slice(REF_PREFIX.length);
    const properties = requireRecord(requireRecord(schemas[component], component)['properties'], `${component}.properties`);
    const [type] = enumValuesOf(properties['type']);
    if (type === undefined) throw new TypeError(`Open Responses spec: ${component}.type has no enum`);
    names.set(type, component);
  }
  return names;
};

let sharedKit: SpecKit | undefined;

const specKit = (): SpecKit => {
  if (sharedKit !== undefined) return sharedKit;
  const spec = requireRecord(OPEN_RESPONSES_OPENAPI, 'openapi');
  const schemas = requireRecord(requireRecord(spec['components'], 'components')['schemas'], 'components.schemas');
  const ajv = new Ajv2020.default({ strict: false, allErrors: true });
  ajv.addSchema({ $id: SPEC_ID, components: requireRecord(spec['components'], 'components') });
  const compile = (component: string): ValidateFunction => {
    const validate = ajv.getSchema(`${SPEC_ID}${REF_PREFIX}${component}`);
    if (validate === undefined) throw new Error(`Ajv could not compile component ${component}`);
    return validate;
  };
  const branches = itemBranchesOf(schemas);
  sharedKit = {
    compile,
    branches,
    branchValidators: new Map(branches.map((branch) => [branch.component, compile(branch.component)])),
    streamSchemas: new Map([...streamSchemaNames(spec, schemas)].map(([type, component]) => [type, compile(component)])),
  };
  return sharedKit;
};

type BranchSelection = { branch: ItemBranch } | { issue: Issue };

const selectBranch = (kit: SpecKit, item: unknown, index: number): BranchSelection => {
  const at = ['input', String(index)];
  if (!isRecord(item)) return { issue: { segments: at, message: 'must be an object' } };
  const type = item['type'];
  if (typeof type !== 'string') return { issue: { segments: [...at, 'type'], message: 'is required' } };
  if (type === 'item_reference') {
    return { issue: { segments: [...at, 'type'], message: 'item_reference input items are not supported' } };
  }
  const byType = kit.branches.filter((branch) => branch.types.has(type));
  const first = byType[0];
  if (first === undefined) return { issue: { segments: [...at, 'type'], message: `has unknown item type "${type}"` } };
  if (byType.length === 1 && first.roles.size === 0) return { branch: first };
  const role = item['role'];
  const byRole = byType.find((branch) => typeof role === 'string' && branch.roles.has(role));
  if (byRole === undefined) return { issue: { segments: [...at, 'role'], message: `has no valid role for item type "${type}"` } };
  return { branch: byRole };
};

const itemIssue = (kit: SpecKit, item: unknown, index: number): Issue | undefined => {
  const selection = selectBranch(kit, item, index);
  if ('issue' in selection) return selection.issue;
  const validate = kit.branchValidators.get(selection.branch.component) as ValidateFunction;
  return validate(item) ? undefined : issueOf(validate.errors ?? [], ['input', String(index)]);
};

export type StoredDataChecks = {
  inputItems(value: unknown): string | undefined;
  outputItems(value: unknown): string | undefined;
  streamEvents(value: unknown): string | undefined;
  compactResource(value: unknown): string | undefined;
};

const describeIssue = (issue: Issue): string => `${joinParam(issue.segments) ?? 'value'} ${issue.message}`;

export const createStoredDataChecks = (): StoredDataChecks => {
  const kit = specKit();
  const itemField = kit.compile('ItemField');
  const compactResource = kit.compile('CompactResource');
  const outputIssue = (item: unknown, index: number): Issue | undefined =>
    itemField(item) ? undefined : issueOf(itemField.errors ?? [], ['output', String(index)]);
  return {
    inputItems: (value) => {
      if (!Array.isArray(value)) return 'is not an array';
      for (const [index, item] of value.entries()) {
        const asParam = itemIssue(kit, item, index);
        if (asParam !== undefined && outputIssue(item, index) !== undefined) return describeIssue(asParam);
      }
      return undefined;
    },
    outputItems: (value) => {
      if (!Array.isArray(value)) return 'is not an array';
      for (const [index, item] of value.entries()) {
        const issue = outputIssue(item, index);
        if (issue !== undefined) return describeIssue(issue);
      }
      return undefined;
    },
    compactResource: (value) => (compactResource(value) ? undefined : describeIssue(issueOf(compactResource.errors ?? [], []))),
    streamEvents: (value) => {
      if (!Array.isArray(value) || value.length === 0) return 'is not a non-empty array';
      for (const [index, event] of value.entries()) {
        const type = isRecord(event) ? event['type'] : undefined;
        const validate = typeof type === 'string' ? kit.streamSchemas.get(type) : undefined;
        if (validate === undefined) return `frame ${index} has an unknown event type`;
        if (!validate(event)) return `frame ${index} ${describeIssue(issueOf(validate.errors ?? [], []))}`;
      }
      return undefined;
    },
  };
};

const MAX_TOOLS = 128;
const MAX_TOOL_PARAMETERS_BYTES = 65536;

const validateTools = (tools: unknown): void => {
  if (!Array.isArray(tools)) throwIssue({ segments: ['tools'], message: 'must be an array of function tools' });
  const list = tools as unknown[];
  if (list.length > MAX_TOOLS) throwIssue({ segments: ['tools'], message: `must contain at most ${MAX_TOOLS} tools` });
  const names = new Set<string>();
  list.forEach((tool, index) => {
    const at = (field: string): string[] => ['tools', String(index), field];
    if (!isRecord(tool)) throwIssue({ segments: ['tools', String(index)], message: 'must be an object' });
    const entry = tool as SchemaObject;
    if (entry['type'] !== 'function') throwIssue({ segments: at('type'), message: 'must be "function"' });
    const name = entry['name'];
    if (typeof name !== 'string' || name === '') {
      throwIssue({ segments: at('name'), message: 'is required and must be a non-empty string' });
    }
    if (names.has(name as string)) throwIssue({ segments: at('name'), message: 'must be unique' });
    names.add(name as string);
    const description = entry['description'];
    if (description !== undefined && description !== null && typeof description !== 'string') {
      throwIssue({ segments: at('description'), message: 'must be a string' });
    }
    const parameters = entry['parameters'];
    if (parameters !== undefined && parameters !== null && !isRecord(parameters)) {
      throwIssue({ segments: at('parameters'), message: 'must be an object' });
    }
    if (parameters !== undefined && parameters !== null && Buffer.byteLength(canonicalJson(parameters)) > MAX_TOOL_PARAMETERS_BYTES) {
      throwIssue({ segments: at('parameters'), message: `must not exceed ${MAX_TOOL_PARAMETERS_BYTES} bytes of canonical JSON` });
    }
    const strict = entry['strict'];
    if (strict !== undefined && typeof strict !== 'boolean') {
      throwIssue({ segments: at('strict'), message: 'must be a boolean' });
    }
  });
};

const KNOWN_TOOL_CHOICES: ReadonlySet<unknown> = new Set(['none', 'auto', 'required']);

const validateToolChoice = (choice: unknown): void => {
  if (KNOWN_TOOL_CHOICES.has(choice)) return;
  if (isRecord(choice) && choice['type'] === 'function' && typeof choice['name'] === 'string' && choice['name'] !== '') return;
  throwIssue({ segments: ['tool_choice'], message: 'must be "none", "auto", "required" or a function choice with a name' });
};

const requireKnownKeys = (record: SchemaObject, known: readonly string[], prefix: readonly string[]): void => {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throwIssue({ segments: [...prefix, key], message: 'is not a known key' });
  }
};

const momongaRecord = (value: unknown): SchemaObject | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throwIssue({ segments: ['momonga'], message: 'must be an object' });
  return value as SchemaObject;
};

const validateCompactMomonga = (value: unknown): void => {
  const momonga = momongaRecord(value);
  if (momonga === undefined) return;
  requireKnownKeys(momonga, ['max_summary_tokens', 'retains_user_request'], ['momonga']);
  const cap = momonga['max_summary_tokens'];
  if (cap !== undefined && (!Number.isInteger(cap) || (cap as number) < MIN_SUMMARY_TOKENS)) {
    throwIssue({ segments: ['momonga', 'max_summary_tokens'], message: `must be an integer of at least ${MIN_SUMMARY_TOKENS}` });
  }
  const retains = momonga['retains_user_request'];
  if (retains !== undefined && typeof retains !== 'boolean') {
    throwIssue({ segments: ['momonga', 'retains_user_request'], message: 'must be a boolean' });
  }
};

const validateCountMomonga = (value: unknown): void => {
  const momonga = momongaRecord(value);
  if (momonga === undefined) return;
  requireKnownKeys(momonga, ['lenient_items'], ['momonga']);
  const lenient = momonga['lenient_items'];
  if (lenient === undefined) return;
  const at = ['momonga', 'lenient_items'];
  if (!isRecord(lenient)) throwIssue({ segments: at, message: 'must be an object' });
  const record = lenient as SchemaObject;
  requireKnownKeys(record, ['call_names', 'with_tools'], at);
  const callNames = record['call_names'];
  if (!isRecord(callNames) || Object.values(callNames).some((name) => typeof name !== 'string')) {
    throwIssue({ segments: [...at, 'call_names'], message: 'is required and must map call ids to tool names' });
  }
  if (typeof record['with_tools'] !== 'boolean') {
    throwIssue({ segments: [...at, 'with_tools'], message: 'is required and must be a boolean' });
  }
};

export type RequestValidator = {
  parseCreate(body: unknown): CreateResponseBody;
  parseCompact(body: unknown): CompactRequest;
  parseCountTokens(body: unknown): CountTokensRequest;
};

const assertValidated = <T>(value: unknown): T => value as T;

export const createRequestValidator = (): RequestValidator => {
  const kit = specKit();
  const createSchema = kit.compile('CreateResponseBody');
  const compactSchema = kit.compile('CompactResponseMethodPublicBody');

  const validateItems = (items: readonly unknown[]): void => {
    items.forEach((item, index) => {
      const issue = itemIssue(kit, item, index);
      if (issue !== undefined) throwIssue(issue);
    });
  };

  const validateWithItems = (schema: ValidateFunction, body: unknown): void => {
    const stubbed = isRecord(body) && Array.isArray(body['input']) ? { ...body, input: [] } : body;
    if (!schema(stubbed)) throwIssue(issueOf(schema.errors ?? [], []));
    if (isRecord(body) && Array.isArray(body['input'])) validateItems(body['input']);
  };

  return {
    parseCreate: (body) => {
      validateWithItems(createSchema, body);
      const record = requireRecord(body, 'body');
      if (typeof record['model'] !== 'string' || record['model'] === '') {
        throwIssue({ segments: ['model'], message: 'is required and must be a non-empty string' });
      }
      if (record['background'] === true) {
        throw invalidRequest('capability_unsupported', 'background responses are not supported', 'background');
      }
      return assertValidated<CreateResponseBody>(body);
    },
    parseCompact: (body) => {
      validateWithItems(compactSchema, body);
      validateCompactMomonga(requireRecord(body, 'body')['momonga']);
      return assertValidated<CompactRequest>(body);
    },
    parseCountTokens: (body) => {
      const record = isRecord(body) ? body : throwIssue({ segments: [], message: 'must be an object' });
      if (typeof record['model'] !== 'string' || record['model'] === '') {
        throwIssue({ segments: ['model'], message: 'is required and must be a non-empty string' });
      }
      const input = record['input'];
      if (typeof input !== 'string' && !Array.isArray(input)) {
        throwIssue({ segments: ['input'], message: 'is required and must be a string or an array of input items' });
      }
      if (Array.isArray(input)) validateItems(input);
      const instructions = record['instructions'];
      if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') {
        throwIssue({ segments: ['instructions'], message: 'must be a string' });
      }
      const tools = record['tools'];
      if (tools !== undefined) validateTools(tools);
      const toolChoice = record['tool_choice'];
      if (toolChoice !== undefined) validateToolChoice(toolChoice);
      validateCountMomonga(record['momonga']);
      return assertValidated<CountTokensRequest>(body);
    },
  };
};
