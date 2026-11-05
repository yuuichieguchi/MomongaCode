import { canonicalJson, defineProductSchema, isRecord } from '@momonga/foundation';
import type { ProductValidator, UntrustedError } from '@momonga/foundation';
import { MIN_SUMMARY_TOKENS, OPEN_RESPONSES_COMPONENT_NAMES, OPEN_RESPONSES_OPENAPI, OPEN_RESPONSES_REMOTE_DOCUMENTS, openResponsesComponentSchema, tokensForText } from '@momonga/protocol';
import type { CompactRequest, CountTokensRequest, CreateResponseBody } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';

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

const issueOf = (errors: readonly UntrustedError[], prefix: readonly string[]): Issue => {
  const first = errors.find((error) => !STRUCTURAL_KEYWORDS.has(error.keyword)) ?? errors[0];
  if (first === undefined) throw new Error('validation failed without reporting an error');
  const segments = [...prefix, ...jsonPointerSegments(first.instancePath)];
  if (first.keyword === 'required') segments.push(String(first.params['missingProperty']));
  return { segments, message: first.message };
};

const throwIssue = (issue: Issue): never => {
  const param = joinParam(issue.segments);
  throw invalidRequest('invalid_body', `${param ?? 'request body'} ${issue.message}`, param);
};

type ComponentValidator = ProductValidator<unknown>;

type SpecKit = {
  compile(component: string): ComponentValidator;
  branches: ItemBranch[];
  branchValidators: Map<string, ComponentValidator>;
  itemField: ComponentValidator;
  streamSchemas: Map<string, ComponentValidator>;
};

const componentValidators: ReadonlyMap<string, ComponentValidator> = new Map(
  OPEN_RESPONSES_COMPONENT_NAMES.map((name) => [name, defineProductSchema(`open-responses/${name}`, openResponsesComponentSchema(name), OPEN_RESPONSES_REMOTE_DOCUMENTS)]),
);

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
  const compile = (component: string): ComponentValidator => {
    const validate = componentValidators.get(component);
    if (validate === undefined) throw new Error(`Open Responses spec has no component schema named ${component}`);
    return validate;
  };
  const branches = itemBranchesOf(schemas);
  sharedKit = {
    compile,
    branches,
    branchValidators: new Map(branches.map((branch) => [branch.component, compile(branch.component)])),
    itemField: compile('ItemField'),
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
  const verdict = (kit.branchValidators.get(selection.branch.component) as ComponentValidator)(item);
  if (verdict.valid) return undefined;
  if (isRecord(item) && item['type'] === 'reasoning' && kit.itemField(item).valid) return undefined;
  return issueOf(verdict.errors, ['input', String(index)]);
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
  const outputIssue = (item: unknown, index: number): Issue | undefined => {
    const verdict = itemField(item);
    return verdict.valid ? undefined : issueOf(verdict.errors, ['output', String(index)]);
  };
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
    compactResource: (value) => {
      const verdict = compactResource(value);
      return verdict.valid ? undefined : describeIssue(issueOf(verdict.errors, []));
    },
    streamEvents: (value) => {
      if (!Array.isArray(value) || value.length === 0) return 'is not a non-empty array';
      for (const [index, event] of value.entries()) {
        const type = isRecord(event) ? event['type'] : undefined;
        const validate = typeof type === 'string' ? kit.streamSchemas.get(type) : undefined;
        if (validate === undefined) return `frame ${index} has an unknown event type`;
        const verdict = validate(event);
        if (!verdict.valid) return `frame ${index} ${describeIssue(issueOf(verdict.errors, []))}`;
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

const validateAllowedNames = (choice: SchemaObject, tools: unknown): void => {
  const declared = new Set(
    (Array.isArray(tools) ? tools : []).flatMap((tool) => (isRecord(tool) && typeof tool['name'] === 'string' ? [tool['name']] : [])),
  );
  (choice['tools'] as SchemaObject[]).forEach((entry, index) => {
    const name = entry['name'] as string;
    if (!declared.has(name)) {
      throw invalidRequest('invalid_request', `tool_choice.tools[${index}] names "${name}", which is not among the request tools`, 'tool_choice');
    }
  });
};

const validateToolChoiceSatisfiable = (choice: unknown, tools: unknown): void => {
  const declared = (Array.isArray(tools) ? tools : []).flatMap((tool) => (isRecord(tool) && typeof tool['name'] === 'string' ? [tool['name']] : []));
  if (choice === 'required' && declared.length === 0) {
    throw invalidRequest('invalid_request', 'tool_choice is required, but the request declares no tools', 'tool_choice');
  }
  if (isRecord(choice) && choice['type'] === 'function' && typeof choice['name'] === 'string' && !declared.includes(choice['name'])) {
    throw invalidRequest('invalid_request', `tool_choice.name "${choice['name']}" is not among the request tools`, 'tool_choice.name');
  }
  if (isRecord(choice) && choice['type'] === 'allowed_tools') validateAllowedNames(choice as SchemaObject, tools);
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
  requireKnownKeys(momonga, ['max_summary_tokens', 'retains_user_request', 'guideline'], ['momonga']);
  const cap = momonga['max_summary_tokens'];
  if (cap !== undefined && (!Number.isInteger(cap) || (cap as number) < MIN_SUMMARY_TOKENS)) {
    throwIssue({ segments: ['momonga', 'max_summary_tokens'], message: `must be an integer of at least ${MIN_SUMMARY_TOKENS}` });
  }
  const retains = momonga['retains_user_request'];
  if (retains !== undefined && typeof retains !== 'boolean') {
    throwIssue({ segments: ['momonga', 'retains_user_request'], message: 'must be a boolean' });
  }
  const guideline = momonga['guideline'];
  if (guideline !== undefined && (typeof guideline !== 'string' || tokensForText(guideline) > MIN_SUMMARY_TOKENS)) {
    throwIssue({ segments: ['momonga', 'guideline'], message: `must be a string of at most ${MIN_SUMMARY_TOKENS} estimated tokens` });
  }
};

const validateCountMomonga = (value: unknown): void => {
  const momonga = momongaRecord(value);
  if (momonga === undefined) return;
  requireKnownKeys(momonga, ['lenient_items', 'target'], ['momonga']);
  const target = momonga['target'];
  if (target !== undefined && (typeof target !== 'string' || target === '')) {
    throwIssue({ segments: ['momonga', 'target'], message: 'must be a non-empty string naming a target of the alias' });
  }
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

const CACHE_MARK_NAMES = ['stable', 'fixed', 'previousHistory', 'history'] as const;

const validateCreateMomonga = (value: unknown, inputLength: number): void => {
  const momonga = momongaRecord(value);
  if (momonga === undefined) return;
  requireKnownKeys(momonga, ['cache'], ['momonga']);
  const cache = momonga['cache'];
  if (cache === undefined) return;
  const at = ['momonga', 'cache'];
  if (!isRecord(cache)) throwIssue({ segments: at, message: 'must be an object' });
  const marks = cache as SchemaObject;
  requireKnownKeys(marks, CACHE_MARK_NAMES, at);
  for (const name of CACHE_MARK_NAMES) {
    const mark = marks[name];
    if (mark === undefined && name !== 'previousHistory') throwIssue({ segments: [...at, name], message: 'is required' });
    if (mark !== undefined && (!Number.isInteger(mark) || (mark as number) < 0)) {
      throwIssue({ segments: [...at, name], message: 'must be a non-negative integer' });
    }
  }
  const ordered = ['stable', 'fixed', 'previousHistory', 'history'].filter((name) => marks[name] !== undefined);
  ordered.forEach((name, index) => {
    const previous = ordered[index - 1];
    if (previous !== undefined && (marks[name] as number) < (marks[previous] as number)) {
      throwIssue({ segments: [...at, name], message: `must not be below ${previous}` });
    }
  });
  if ((marks['history'] as number) > inputLength) {
    throwIssue({ segments: [...at, 'history'], message: `must not exceed the ${inputLength} input items` });
  }
};

const inputLengthOf = (input: unknown): number => (Array.isArray(input) ? input.length : typeof input === 'string' ? 1 : 0);

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
  const toolChoiceSchema = kit.compile('ToolChoiceParam');

  const validateItems = (items: readonly unknown[]): void => {
    items.forEach((item, index) => {
      const issue = itemIssue(kit, item, index);
      if (issue !== undefined) throwIssue(issue);
    });
  };

  const validateWithItems = (schema: ComponentValidator, body: unknown): void => {
    const stubbed = isRecord(body) && Array.isArray(body['input']) ? { ...body, input: [] } : body;
    const verdict = schema(stubbed);
    if (!verdict.valid) throwIssue(issueOf(verdict.errors, []));
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
      validateCreateMomonga(record['momonga'], inputLengthOf(record['input']));
      validateToolChoiceSatisfiable(record['tool_choice'], record['tools']);
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
      if (toolChoice !== undefined) {
        const verdict = toolChoiceSchema(toolChoice);
        if (!verdict.valid) throwIssue(issueOf(verdict.errors, ['tool_choice']));
        validateToolChoiceSatisfiable(toolChoice, tools);
      }
      validateCountMomonga(record['momonga']);
      return assertValidated<CountTokensRequest>(body);
    },
  };
};
