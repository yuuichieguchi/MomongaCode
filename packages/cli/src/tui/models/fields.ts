import path from 'node:path';
import { SETTINGS_SCHEMA, fieldLabel, fieldValueText } from '@momonga/config';
import type { ModelsOperation } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import { connectionsOf, displayIn, nameInputOf } from '../../commands/models.ts';
import type { ModelsEdit, ModelsProposal } from '../../commands/models.ts';
import { providerNameOf } from '@momonga/config';
import { accountsOf } from '../../plan/accounts.ts';
import { askKey, secretNameOf, storeKey } from './add.ts';
import { chosenOf, confirmAndWrite, openEdit } from './context.ts';
import type { ModelsFlowContext, Opened } from './context.ts';
import { CLEAR_ROW, NOT_A_FULL_PATH, TOGGLE_ROWS, windowPrompt } from './texts.ts';

type Schema = Readonly<Record<string, unknown>>;

export type FieldEditor = 'choice' | 'toggle' | 'number' | 'minutes' | 'text' | 'key' | 'choices' | 'variant' | 'group' | 'account' | 'program' | 'file';

export type FieldRow = { readonly field: string; readonly path: readonly string[]; readonly label: string; readonly editor: FieldEditor; readonly schema: Schema; readonly required: boolean };

const ENTRY_PREFIX = 'models[].';

const CONNECTION_ORDER = ['adapter', 'baseUrl', 'socketPath', 'apiKeyEnv', 'plan.account', 'server', 'binary', 'readyTimeoutMs', 'billing', 'apiVersion', 'answers', 'maxConcurrency', 'admissionTimeoutMs'] as const;

const ENTRY_ORDER = [
  'maxConcurrency',
  'admissionTimeoutMs',
  'toolCalling',
  'capabilities.contextWindow',
  'capabilities.maxOutputTokens',
  'capabilities.structuredOutput',
  'capabilities.jsonMode',
  'capabilities.tokenCounting',
  'capabilities.source',
  'capabilities.streaming',
  'capabilities.stopSequences',
  'capabilities.imageInput',
  'capabilities.parallelToolCalls',
  'capabilities.usageReported',
  'capabilities.imageTokens',
  'capabilities.allowedTools',
  'capabilities.schemaDialect',
  'capabilities.tokenErrorRatio',
  'capabilities.reasoning',
  'capabilities.promptCache',
  'capabilities.sampling',
  'capabilities.outputBoundField',
  'outputBoundField',
] as const;

const CONNECTION_EDITORS: Readonly<Record<string, FieldEditor>> = { apiKeyEnv: 'key', 'plan.account': 'account', server: 'program', binary: 'file', readyTimeoutMs: 'minutes' };

const recordAt = (schema: Schema, key: string): Schema | undefined => {
  const value = schema[key];
  return isRecord(value) ? value : undefined;
};

const branchesOf = (schema: Schema): Schema[] => (Array.isArray(schema['oneOf']) ? schema['oneOf'].filter(isRecord) : []);

const editorOf = (schema: Schema): FieldEditor => {
  const items = recordAt(schema, 'items');
  if (schema['type'] === 'boolean') return 'toggle';
  if (Array.isArray(schema['enum'])) return 'choice';
  if (schema['type'] === 'integer' || schema['type'] === 'number') return 'number';
  if (schema['type'] === 'string') return 'text';
  if (schema['type'] === 'array' && Array.isArray(items?.['enum'])) return 'choices';
  return branchesOf(schema).length > 0 ? 'variant' : 'group';
};

const CONNECTION_BRANCHES = branchesOf(SETTINGS_SCHEMA.properties.models.properties.connections.items);

export const connectionSchemaOf = (connection: Readonly<Record<string, unknown>>): Schema => {
  const planned = connection['plan'] !== undefined;
  const branch = CONNECTION_BRANCHES.find((candidate) => {
    const properties = recordAt(candidate, 'properties');
    const required = Array.isArray(candidate['required']) ? candidate['required'] : [];
    return recordAt(properties ?? {}, 'adapter')?.['const'] === connection['adapter'] && required.includes('plan') === planned;
  });
  if (branch === undefined) throw new TypeError(`the settings schema holds no connection of the kind ${String(connection['adapter'])}`);
  return branch;
};

const schemaAt = (schema: Schema, keys: readonly string[]): Schema | undefined => keys.reduce<Schema | undefined>((current, key) => (current === undefined ? undefined : recordAt(recordAt(current, 'properties') ?? {}, key)), schema);

const requiredAt = (schema: Schema, keys: readonly string[]): boolean => {
  const holder = schemaAt(schema, keys.slice(0, -1));
  const required = holder !== undefined && Array.isArray(holder['required']) ? holder['required'] : [];
  return required.includes(keys.at(-1));
};

const ordered = (keys: readonly string[], order: readonly string[]): string[] => [...order.filter((key) => keys.includes(key)), ...keys.filter((key) => !order.includes(key))];

export const serverFieldRows = (connection: Readonly<Record<string, unknown>>): FieldRow[] => {
  const schema = connectionSchemaOf(connection);
  const properties = recordAt(schema, 'properties') ?? {};
  const addressed = properties['baseUrl'] !== undefined;
  const offered = Object.keys(properties).flatMap((key) => {
    if (key === 'models' || key === 'provider' || key === 'apiKeySecret') return [];
    if (key === 'adapter') return addressed && connection['plan'] === undefined ? [key] : [];
    if (key === 'plan') return ['plan.account'];
    if (key === 'baseUrl' || key === 'socketPath' || key === 'apiKeyEnv') return connection['plan'] === undefined ? [key] : [];
    return [key];
  });
  return ordered(offered, CONNECTION_ORDER).flatMap((field) => {
    const keys = field.split('.');
    const leaf = schemaAt(schema, keys);
    if (leaf === undefined) return [];
    const editor = field === 'adapter' ? 'choice' : (CONNECTION_EDITORS[field] ?? editorOf(leaf));
    return [{ field, path: keys, label: fieldLabel(field), editor, schema: leaf, required: field === 'adapter' || requiredAt(schema, keys) }];
  });
};

export const modelFieldRows = (connection: Readonly<Record<string, unknown>>): FieldRow[] => {
  const entry = recordAt(recordAt(recordAt(connectionSchemaOf(connection), 'properties') ?? {}, 'models') ?? {}, 'items');
  if (entry === undefined) throw new TypeError('the settings schema holds no model entry for this connection');
  const own = Object.keys(recordAt(entry, 'properties') ?? {}).filter((key) => key !== 'id' && key !== 'capabilities');
  const capabilities = Object.keys(recordAt(schemaAt(entry, ['capabilities']) ?? {}, 'properties') ?? {}).map((key) => `capabilities.${key}`);
  return ordered([...own, ...capabilities], ENTRY_ORDER).flatMap((key) => {
    const keys = key.split('.');
    const leaf = schemaAt(entry, keys);
    if (leaf === undefined) return [];
    const field = `${ENTRY_PREFIX}${key}`;
    return [{ field, path: keys, label: fieldLabel(field), editor: editorOf(leaf), schema: leaf, required: false }];
  });
};

const valueAt = (holder: unknown, keys: readonly string[]): unknown => keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), holder);

type Edited = { readonly value: unknown } | undefined;

const EMPTY_REMOVES = 'Leave it empty to remove the value.';

const rangeOf = (schema: Schema): { min: number | undefined; max: number | undefined; whole: boolean } => ({
  min: typeof schema['minimum'] === 'number' ? schema['minimum'] : undefined,
  max: typeof schema['maximum'] === 'number' ? schema['maximum'] : undefined,
  whole: schema['type'] === 'integer',
});

export const numberProblemText = (schema: Schema): string => {
  const { min, max, whole } = rangeOf(schema);
  const kind = whole ? 'a whole number' : 'a number';
  if (min !== undefined && max !== undefined) return `Enter ${kind} from ${min} to ${max}.`;
  if (min !== undefined) return `Enter ${kind} of at least ${min}.`;
  return max === undefined ? `Enter ${kind}.` : `Enter ${kind} of at most ${max}.`;
};

const numberOf = (text: string, schema: Schema): number | undefined => {
  const { min, max, whole } = rangeOf(schema);
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(value) || (whole && !Number.isInteger(value))) return undefined;
  if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) return undefined;
  return (min !== undefined && value < min) || (max !== undefined && value > max) ? undefined : value;
};

const askNumber = async (context: ModelsFlowContext, title: string, schema: Schema, clearable: boolean): Promise<Edited> => {
  const text = await context.overlays.promptText({
    title,
    lines: clearable ? [EMPTY_REMOVES] : [],
    validate: (entry) => ((clearable && entry.trim() === '') || numberOf(entry, schema) !== undefined ? undefined : numberProblemText(schema)),
  });
  if (text === undefined) return undefined;
  return { value: text.trim() === '' ? undefined : numberOf(text, schema) };
};

const askText = async (context: ModelsFlowContext, title: string, clearable: boolean, problem: (text: string) => string | undefined = () => undefined): Promise<Edited> => {
  const text = await context.overlays.promptText({ title, lines: clearable ? [EMPTY_REMOVES] : [], validate: (entry) => (entry.trim() === '' ? (clearable ? undefined : 'Write a value.') : problem(entry.trim())) });
  if (text === undefined) return undefined;
  return { value: text.trim() === '' ? undefined : text.trim() };
};

const askChoice = async (context: ModelsFlowContext, title: string, field: string, values: readonly unknown[], clearable: boolean): Promise<Edited> => {
  const rows = [...values.map((value) => ({ label: fieldValueText(field, value) })), ...(clearable ? [{ label: CLEAR_ROW }] : [])];
  const index = await chosenOf(context, { title, rows });
  if (index === undefined) return undefined;
  return { value: index < values.length ? values[index] : undefined };
};

const askToggle = async (context: ModelsFlowContext, title: string): Promise<Edited> => {
  const index = await chosenOf(context, { title, rows: TOGGLE_ROWS.map((label) => ({ label })) });
  if (index === undefined) return undefined;
  return { value: TOGGLE_ROWS[index] === 'not declared' ? undefined : TOGGLE_ROWS[index] === 'yes' };
};

const DONE_ROW = 'Done';

const askChoices = async (context: ModelsFlowContext, title: string, values: readonly unknown[], current: unknown): Promise<Edited> => {
  let chosen = Array.isArray(current) ? values.filter((value) => current.includes(value)) : [];
  let at = 0;
  for (;;) {
    const rows = [...values.map((value) => ({ label: `[${chosen.includes(value) ? 'x' : ' '}] ${String(value)}` })), { label: DONE_ROW }];
    const index = await chosenOf(context, { title, rows, initial: at });
    if (index === undefined) return undefined;
    if (index === values.length) return { value: chosen.length === 0 ? undefined : chosen };
    at = index;
    const picked = values[index];
    chosen = values.filter((value) => (value === picked ? !chosen.includes(value) : chosen.includes(value)));
  }
};

const constOf = (schema: Schema): unknown => schema['const'];

const variantLabel = (branch: Schema): string =>
  Object.values(recordAt(branch, 'properties') ?? {})
    .filter(isRecord)
    .flatMap((property) => (property['const'] === undefined ? [] : [String(property['const'])]))
    .join(' ');

const askValue = async (context: ModelsFlowContext, title: string, field: string, schema: Schema, current: unknown, clearable: boolean): Promise<Edited> => {
  if (constOf(schema) !== undefined) return { value: constOf(schema) };
  switch (editorOf(schema)) {
    case 'toggle':
      return askToggle(context, title);
    case 'choice':
      return askChoice(context, title, field, schema['enum'] as readonly unknown[], clearable);
    case 'number':
      return askNumber(context, `${title}:`, schema, clearable);
    case 'text':
      return askText(context, `${title}:`, clearable);
    case 'choices':
      return askChoices(context, title, (recordAt(schema, 'items') as Schema)['enum'] as readonly unknown[], current);
    case 'variant':
      return askVariant(context, title, field, schema, clearable);
    default:
      return askGroup(context, title, field, schema, current);
  }
};

const askGroup = async (context: ModelsFlowContext, title: string, field: string, schema: Schema, current: unknown): Promise<Edited> => {
  const properties = recordAt(schema, 'properties') ?? {};
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  const value: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) continue;
    const member = `${field}.${key}`;
    const label = fieldLabel(member);
    const edited = await askValue(context, label === member || label === fieldLabel(field) ? `${title}: ${key}` : label, member, property, valueAt(current, [key]), !required.includes(key));
    if (edited === undefined) return undefined;
    if (edited.value !== undefined) value[key] = edited.value;
  }
  return { value };
};

const askVariant = async (context: ModelsFlowContext, title: string, field: string, schema: Schema, clearable: boolean): Promise<Edited> => {
  const branches = branchesOf(schema).flatMap((branch) => {
    const [first] = Object.entries(recordAt(branch, 'properties') ?? {});
    const kinds = first !== undefined && isRecord(first[1]) && Array.isArray(first[1]['enum']) ? first[1]['enum'] : undefined;
    return kinds === undefined || first === undefined ? [{ branch, label: variantLabel(branch) }] : kinds.map((kind) => ({ branch: { ...branch, properties: { ...recordAt(branch, 'properties'), [first[0]]: { const: kind } } }, label: String(kind) }));
  });
  const index = await chosenOf(context, { title, rows: [...branches.map((entry) => ({ label: entry.label })), ...(clearable ? [{ label: CLEAR_ROW }] : [])] });
  if (index === undefined) return undefined;
  const chosen = branches[index];
  return chosen === undefined ? { value: undefined } : askGroup(context, title, field, chosen.branch, undefined);
};

const kindsIn = (schema: Schema): Schema => {
  const properties = recordAt(schema, 'properties') ?? {};
  const [first] = Object.entries(properties);
  if (branchesOf(schema).length > 0 || first === undefined || !isRecord(first[1]) || !Array.isArray(first[1]['enum']) || Object.keys(properties).length !== 1) return schema;
  return { oneOf: [schema] };
};

const MINUTE_MS = 60_000;

const askMinutes = async (context: ModelsFlowContext, row: FieldRow): Promise<Edited> => {
  const { max } = rangeOf(row.schema);
  const most = max === undefined ? undefined : Math.floor(max / MINUTE_MS);
  const minutes: Schema = { type: 'integer', minimum: 1, ...(most === undefined ? {} : { maximum: most }) };
  const edited = await askNumber(context, most === undefined ? `${row.label} in minutes:` : `${row.label} in minutes (at most ${most}):`, minutes, true);
  if (edited === undefined) return undefined;
  return { value: typeof edited.value === 'number' ? edited.value * MINUTE_MS : undefined };
};

type Subject = { readonly kind: 'model'; readonly canon: string } | { readonly kind: 'server'; readonly provider: string };

const nameOf = (edit: ModelsEdit, subject: Subject): string => (subject.kind === 'model' ? displayIn(edit, subject.canon) : subject.provider);

const operationOf = (subject: Subject, keys: readonly string[], value: unknown): ModelsOperation =>
  subject.kind === 'model' ? { kind: 'setModelField', model: subject.canon, path: keys, value } : { kind: 'setConnectionField', provider: subject.provider, path: keys, value };

export const fieldProposal = (edit: ModelsEdit, subject: Subject, row: Pick<FieldRow, 'field' | 'path' | 'label'>, value: unknown): ModelsProposal => ({
  operations: [operationOf(subject, row.path, value)],
  confirm: () => (value === undefined ? `Clear ${row.label} of ${nameOf(edit, subject)}?` : `Set ${row.label} of ${nameOf(edit, subject)} to ${fieldValueText(row.field, value)}?`),
});

const ANY_ACCOUNT = 'Any account';

type Asked = { readonly row: Pick<FieldRow, 'field' | 'path' | 'label'>; readonly value: unknown; readonly before?: () => Promise<void> } | undefined;

const askKeyField = async (context: ModelsFlowContext, edit: ModelsEdit, connection: Readonly<Record<string, unknown>>): Promise<Asked> => {
  const key = await askKey(context);
  if (key === undefined) return undefined;
  if (key.kind === 'env') return { row: { field: 'apiKeyEnv', path: ['apiKeyEnv'], label: fieldLabel('apiKeyEnv') }, value: key.name };
  const name = secretNameOf(providerNameOf(nameInputOf({ ...connection }), edit.ports.kinds));
  return { row: { field: 'apiKeySecret', path: ['apiKeySecret'], label: fieldLabel('apiKeySecret') }, value: name, before: () => storeKey(context, name, key.value) };
};

const askAccount = async (context: ModelsFlowContext, row: FieldRow, connection: Readonly<Record<string, unknown>>): Promise<Asked> => {
  const listed = await context.backend.plan.accounts();
  const profile = valueAt(connection, ['plan', 'profile']);
  const labels = accountsOf(String(profile), listed.accounts).map((account) => account.label);
  const index = await chosenOf(context, { title: row.label, rows: [...labels.map((label) => ({ label })), { label: ANY_ACCOUNT }] });
  return index === undefined ? undefined : { row, value: labels[index] };
};

const askField = async (context: ModelsFlowContext, opened: Opened, subject: Subject, row: FieldRow, connection: Readonly<Record<string, unknown>>, current: unknown): Promise<Asked> => {
  const { edit } = opened;
  const clearable = !row.required;
  const plain = (edited: Edited): Asked => (edited === undefined ? undefined : { row, value: edited.value });
  switch (row.editor) {
    case 'key':
      return askKeyField(context, edit, connection);
    case 'account':
      return askAccount(context, row, connection);
    case 'program':
      return plain(await askChoice(context, row.label, row.field, Object.keys(edit.resolved.servers).sort(), false));
    case 'file': {
      const absolute = opened.host.platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
      return plain(await askText(context, `${row.label}:`, clearable, (text) => (absolute(text) ? undefined : NOT_A_FULL_PATH)));
    }
    case 'minutes':
      return plain(await askMinutes(context, row));
    case 'number':
      return plain(await askNumber(context, row.field === `${ENTRY_PREFIX}capabilities.contextWindow` ? windowPrompt(nameOf(edit, subject), undefined) : `${row.label}:`, row.schema, clearable));
    case 'choice':
      if (row.field === 'adapter') return plain(await askChoice(context, row.label, row.field, ADAPTERS, false));
      return plain(await askChoice(context, row.label, row.field, inTableOrder(row.field, row.schema['enum'] as readonly unknown[]), clearable));
    default:
      if (row.field === `${ENTRY_PREFIX}capabilities.schemaDialect`) return plain(await askChoice(context, row.label, row.field, Object.keys(edit.resolved.dialects).sort(), clearable));
      return plain(await askValue(context, row.label, row.field, kindsIn(row.schema), current, clearable));
  }
};

const CHOICE_ORDER: Readonly<Record<string, readonly unknown[]>> = { billing: ['local', 'metered', 'plan'] };

const inTableOrder = (field: string, values: readonly unknown[]): readonly unknown[] => {
  const order = CHOICE_ORDER[field];
  return order === undefined ? values : [...order.filter((value) => values.includes(value)), ...values.filter((value) => !order.includes(value))];
};

const ADAPTERS = ['ollama', 'chat-completions', 'anthropic', 'open-responses'] as const;

const shownOf = (row: FieldRow, connection: Readonly<Record<string, unknown>>, holder: unknown): string => {
  if (row.editor === 'key') {
    const env = connection['apiKeyEnv'];
    const secret = connection['apiKeySecret'];
    return env !== undefined ? `environment variable ${String(env)}` : secret !== undefined ? `secret ${String(secret)}` : fieldValueText(row.field, undefined);
  }
  return fieldValueText(row.field, valueAt(holder, row.path));
};

export const fieldRowText = (row: FieldRow, connection: Readonly<Record<string, unknown>>, holder: unknown): string => `${row.label}  ${shownOf(row, connection, holder)}`;

type Place = { connection: Readonly<Record<string, unknown>>; holder: unknown; rows: FieldRow[] };

const connectionOf = (edit: ModelsEdit, provider: string): Readonly<Record<string, unknown>> => {
  const index = edit.resolved.connections.findIndex((candidate) => candidate.provider === provider);
  const connection = connectionsOf(edit.document)[index];
  if (connection === undefined) throw new TypeError(`the server ${provider} is listed and is not in the settings`);
  return connection;
};

const placeOf = (edit: ModelsEdit, subject: Subject): Place => {
  if (subject.kind === 'server') {
    const connection = connectionOf(edit, subject.provider);
    return { connection, holder: connection, rows: serverFieldRows(connection) };
  }
  const view = edit.resolved.views.find((candidate) => candidate.canon === subject.canon);
  if (view === undefined) throw new TypeError(`the model ${subject.canon} is listed and is not in the settings`);
  const connection = connectionOf(edit, view.provider);
  const position = edit.resolved.views.filter((candidate) => candidate.provider === view.provider).findIndex((candidate) => candidate.canon === subject.canon);
  const entries = Array.isArray(connection['models']) ? connection['models'] : [];
  return { connection, holder: entries[position], rows: modelFieldRows(connection) };
};

const runFields = async (context: ModelsFlowContext, subject: Subject): Promise<void> => {
  let at = 0;
  for (;;) {
    const opened = await openEdit(context);
    const { edit } = opened;
    const known = subject.kind === 'model' ? edit.resolved.views.some((view) => view.canon === subject.canon) : edit.resolved.connections.some((connection) => connection.provider === subject.provider);
    if (!known) return;
    const { connection, holder, rows } = placeOf(edit, subject);
    const index = await chosenOf(context, { title: nameOf(edit, subject), rows: rows.map((row) => ({ label: fieldRowText(row, connection, holder) })), initial: at });
    const row = index === undefined ? undefined : rows[index];
    if (index === undefined || row === undefined) return;
    at = index;
    const asked = await askField(context, opened, subject, row, connection, valueAt(holder, row.path));
    if (asked === undefined) continue;
    await confirmAndWrite(opened, context, fieldProposal(edit, subject, asked.row, asked.value), asked.before);
  }
};

export const runModelFields = (context: ModelsFlowContext, canon: string): Promise<void> => runFields(context, { kind: 'model', canon });

export const runServerFields = (context: ModelsFlowContext, provider: string): Promise<void> => runFields(context, { kind: 'server', provider });
