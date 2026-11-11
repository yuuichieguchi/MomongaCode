import { ConfigError, ModelsEditRefused, SETTINGS_SCHEMA, editModelsSettings } from '@momonga/config';
import type { SettingsLayer, SettingsOperation, SettingsSnapshot } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import type { PickRow } from './picker.tsx';
import { switchWordOf } from './screen/a11y.ts';
import { settingsFileLine } from './models/texts.ts';
import type { SlashContext } from './slash.ts';

export const SETTINGS_TITLE = 'Settings';
export const OPEN_SETTINGS_FILE_ROW = 'Open the settings file';
export const SAVE_TO_TITLE = 'Save to:';
export const SAVING_SETTING = 'saving the setting';
export const APPLIES_NOW = 'applies now';
export const APPLIES_NEXT_SESSION = 'applies from the next session';
export const NOT_SET = 'not set';
export const NONE = 'none';
export const ADD_ROW = 'Add';
export const DELETE_LABEL = 'delete';
export const REMOVE_ACTIONS = ['Remove'] as const;
export const LIST_ACTIONS = ['Move up', 'Move down', 'Remove'] as const;
export const ENTRY_ACTIONS = ['Edit', 'Remove'] as const;
export const CONFIRM_ROWS = ['No', 'Yes'] as const;
export const STRUCTURED_LINES = ['The value as JSON. Nothing is written until the settings loader accepts it.'] as const;

export const SETTING_SECTIONS = ['Display', 'Permissions', 'Context', 'Tools', 'Memory', 'Verification', 'MCP', 'Hooks', 'Models', 'Environment variables', 'Credentials', 'Network', 'Sandbox', 'Telemetry', 'Pricing', 'Budget and delegation', 'Git and pull requests', 'Updates', 'Shutdown'] as const;

export type SettingSection = (typeof SETTING_SECTIONS)[number];

export type SettingPresentation = {
  readonly label: string;
  readonly section: SettingSection;
  readonly appliesNow: boolean;
  readonly confirm?: { readonly value: unknown; readonly question: string };
  readonly form?: readonly FormField[];
  readonly constants?: Readonly<Record<string, unknown>>;
  readonly line?: (entry: Readonly<Record<string, unknown>>) => string;
};

export type FormField = { readonly name: string; readonly label: string; readonly kind: 'text' | 'number'; readonly required: boolean };

const PRICE_FORM: readonly FormField[] = [
  { name: 'provider', label: 'Provider', kind: 'text', required: true },
  { name: 'model', label: 'Model', kind: 'text', required: true },
  { name: 'effectiveFrom', label: 'In force from (YYYY-MM-DD)', kind: 'text', required: true },
  { name: 'inputPerMTok', label: 'Input, USD per million tokens', kind: 'number', required: true },
  { name: 'outputPerMTok', label: 'Output, USD per million tokens', kind: 'number', required: true },
  { name: 'cachedInputPerMTok', label: 'Cached input, USD per million tokens (empty: none)', kind: 'number', required: false },
  { name: 'cacheWritePerMTok', label: 'Cache write, USD per million tokens (empty: none)', kind: 'number', required: false },
];

const FORGE_FORM: readonly FormField[] = [
  { name: 'id', label: 'Name', kind: 'text', required: true },
  { name: 'descriptor', label: 'Forge kind (a shipped descriptor, such as github)', kind: 'text', required: true },
  { name: 'host', label: 'Host of the git remote', kind: 'text', required: true },
  { name: 'apiBaseUrl', label: 'API base URL', kind: 'text', required: true },
  { name: 'credentialEnv', label: 'Token: environment variable name (or the next field)', kind: 'text', required: false },
  { name: 'credentialSecret', label: 'Token: name in the secret store', kind: 'text', required: false },
];

const PRICE_CONSTANTS = { currency: 'USD' } as const;

const priceLine = (entry: Readonly<Record<string, unknown>>): string =>
  `${String(entry['provider'])}/${String(entry['model'])}  from ${String(entry['effectiveFrom'])}  input ${String(entry['inputPerMTok'])}  output ${String(entry['outputPerMTok'])}`;

const forgeLine = (entry: Readonly<Record<string, unknown>>): string => `${String(entry['id'])}  ${String(entry['descriptor'])}  ${String(entry['host'])}  ${String(entry['apiBaseUrl'])}`;

export const SETTING_ROWS: Readonly<Record<string, SettingPresentation>> = {
  'tui.screen': { label: 'Screen mode at start', section: 'Display', appliesNow: false },
  'tui.mouse': { label: 'Mouse', section: 'Display', appliesNow: false },
  'tui.copyOnSelect': { label: 'Copy on select', section: 'Display', appliesNow: false },
  'tui.theme': { label: 'Theme', section: 'Display', appliesNow: true },
  'tui.screenReader': { label: 'Screen-reader display', section: 'Display', appliesNow: true },
  'tui.reducedMotion': { label: 'Reduced motion', section: 'Display', appliesNow: true },
  'tui.notify': { label: 'Ring the terminal bell when a run ends or needs you', section: 'Display', appliesNow: true },
  'tui.attachFileMentions': { label: 'Attach @files when sending', section: 'Display', appliesNow: false },
  'context.adaptiveBudget': { label: 'Adaptive budget', section: 'Context', appliesNow: true },
  'context.autoCompact': { label: 'Automatic compaction', section: 'Context', appliesNow: true },
  'context.cachePrefix': { label: 'Cache prefix', section: 'Context', appliesNow: true },
  'context.outputFormatters': { label: 'Output formatters', section: 'Context', appliesNow: true },
  'context.loopGuidance': { label: 'Loop guidance', section: 'Context', appliesNow: true },
  'context.observedCapacity': { label: 'Observed capacity', section: 'Context', appliesNow: true },
  'context.unboundedOutputReserve': { label: 'Unbounded output reserve', section: 'Context', appliesNow: true },
  'tools.deferral': { label: 'Tool deferral', section: 'Tools', appliesNow: true },
  'tools.conciseDescriptions': { label: 'Concise tool descriptions', section: 'Tools', appliesNow: true },
  'tools.ripgrep': { label: 'ripgrep program', section: 'Tools', appliesNow: false },
  'memory.reflection.enabled': { label: 'Reflection', section: 'Memory', appliesNow: false },
  'memory.reflection.maxTokens': { label: 'Reflection token limit', section: 'Memory', appliesNow: false },
  'memory.forgetAfterDays': { label: 'Forget after (days)', section: 'Memory', appliesNow: false },
  'memory.repositoryFacts': { label: 'Repository facts', section: 'Memory', appliesNow: false },
  'verification.commands': { label: 'Verification commands', section: 'Verification', appliesNow: false },
  'verification.manifests': { label: 'Verification manifests', section: 'Verification', appliesNow: false },
  'verification.required': { label: 'Require a completion condition', section: 'Verification', appliesNow: false },
  enableAllProjectMcpServers: { label: 'Enable every server of .mcp.json', section: 'MCP', appliesNow: false },
  'mcp.toolIdleTimeoutMs': { label: 'Tool idle timeout (ms)', section: 'MCP', appliesNow: false },
  'mcp.toolTotalTimeoutMs': { label: 'Tool total timeout (ms)', section: 'MCP', appliesNow: false },
  'mcp.connectTimeoutMs': { label: 'Connect timeout (ms)', section: 'MCP', appliesNow: false },
  'models.dialects': { label: 'Schema dialects', section: 'Models', appliesNow: false },
  env: { label: 'Environment variables', section: 'Environment variables', appliesNow: false },
  'credentials.env': { label: 'Variables treated as credentials', section: 'Credentials', appliesNow: false },
  'credentials.keep': { label: 'Variables kept for commands', section: 'Credentials', appliesNow: false },
  'credentials.valuePatterns': { label: 'Value patterns of credentials', section: 'Credentials', appliesNow: false },
  'credentials.plaintextTokenFiles': { label: 'Plain-text token files', section: 'Credentials', appliesNow: false },
  'network.httpProxy': { label: 'HTTP proxy', section: 'Network', appliesNow: false },
  'network.httpsProxy': { label: 'HTTPS proxy', section: 'Network', appliesNow: false },
  'network.noProxy': { label: 'No proxy for', section: 'Network', appliesNow: false },
  'network.extraCaFiles': { label: 'Extra CA files', section: 'Network', appliesNow: false },
  'network.environment': { label: 'Proxy from the environment', section: 'Network', appliesNow: false },
  sandbox: { label: 'Sandbox', section: 'Sandbox', appliesNow: false, confirm: { value: 'none', question: 'Run commands without a sandbox?' } },
  sandboxNetwork: { label: 'Network of a sandboxed command', section: 'Sandbox', appliesNow: false, confirm: { value: 'allow', question: 'Let every command that requests the network use it without asking you?' } },
  'sandboxUnixSockets.allow': { label: 'Unix sockets a command may connect to', section: 'Sandbox', appliesNow: false },
  'telemetry.otlp.endpoint': { label: 'OTLP endpoint', section: 'Telemetry', appliesNow: false },
  'telemetry.otlp.headers': { label: 'OTLP headers', section: 'Telemetry', appliesNow: false },
  'telemetry.captureMessageContent': { label: 'Capture message content', section: 'Telemetry', appliesNow: false, confirm: { value: true, question: 'Capture message content in telemetry?' } },
  'telemetry.contentRetentionDays': { label: 'Content retention (days)', section: 'Telemetry', appliesNow: false },
  pricing: { label: 'Prices', section: 'Pricing', appliesNow: false, form: PRICE_FORM, constants: PRICE_CONSTANTS, line: priceLine },
  'limits.maxCostUsd': { label: 'Money limit of a run (USD)', section: 'Budget and delegation', appliesNow: false },
  'ceilings.costUsd': { label: 'Ceiling on the money a mandate may declare (USD)', section: 'Budget and delegation', appliesNow: false },
  'ceilings.tokens': { label: 'Ceiling on the tokens a mandate may declare', section: 'Budget and delegation', appliesNow: false },
  'ceilings.timeMs': { label: 'Ceiling on the time a mandate may declare (ms)', section: 'Budget and delegation', appliesNow: false },
  mandates: { label: 'Mandates by name', section: 'Budget and delegation', appliesNow: false },
  forges: { label: 'Forges for pull request operations', section: 'Git and pull requests', appliesNow: false, form: FORGE_FORM, line: forgeLine },
  'operations.protectedRefs': { label: 'Protected branches (a push always asks you)', section: 'Git and pull requests', appliesNow: false },
  'operations.approval': { label: 'Approval class by operation (rule or always)', section: 'Git and pull requests', appliesNow: false },
  autoUpdates: { label: 'Automatic updates', section: 'Updates', appliesNow: false },
  'gateway.closeGraceMs': { label: 'Close grace (ms)', section: 'Shutdown', appliesNow: false },
  'gateway.managedServerStopGraceMs': { label: 'Managed server stop grace (ms)', section: 'Shutdown', appliesNow: false },
  'runtime.drainTimeoutMs': { label: 'Run drain timeout (ms)', section: 'Shutdown', appliesNow: false },
  'mcp.closeGraceMs': { label: 'MCP server close grace (ms)', section: 'Shutdown', appliesNow: false },
};

export const SETTINGS_REACHED_BY_COMMAND: Readonly<Record<string, string>> = {
  'permissions.defaultMode': 'permissions',
  'permissions.allow': 'permissions',
  'permissions.ask': 'permissions',
  'permissions.deny': 'permissions',
  'permissions.additionalDirectories': 'permissions',
  hooks: 'hooks',
  mcpServers: 'mcp',
  enabledMcpjsonServers: 'mcp',
  disabledMcpjsonServers: 'mcp',
  'autoMode.classifier': 'models',
  'models.connections': 'models',
  'models.start': 'models',
  'models.fallback': 'models',
  'models.servers': 'models',
  'models.billingChanges': 'models',
  'models.roles.compaction': 'models',
  'models.roles.reflection': 'models',
  'models.roles.analysis': 'models',
  'models.headersTimeoutMs': 'models',
  'models.idleTimeoutMs': 'models',
};

export const COMMAND_LINKS: Readonly<Record<string, { readonly section: SettingSection; readonly label: string }>> = {
  permissions: { section: 'Permissions', label: 'Start mode, rules and directories' },
  hooks: { section: 'Hooks', label: 'Hooks' },
  mcp: { section: 'MCP', label: 'MCP servers' },
  models: { section: 'Models', label: 'Models, connections, roles and timeouts' },
};

export type EditorKind = 'toggle' | 'choice' | 'number' | 'text' | 'list' | 'choices' | 'map' | 'structured';

export type SettingLeaf = { readonly key: string; readonly path: readonly string[]; readonly schema: Readonly<Record<string, unknown>>; readonly kind: EditorKind };

const kindOf = (schema: Readonly<Record<string, unknown>>): EditorKind => {
  const items = isRecord(schema['items']) ? schema['items'] : undefined;
  const members = isRecord(schema['additionalProperties']) ? schema['additionalProperties'] : undefined;
  if (schema['type'] === 'boolean') return 'toggle';
  if (Array.isArray(schema['enum'])) return 'choice';
  if (schema['type'] === 'integer' || schema['type'] === 'number') return 'number';
  if (schema['type'] === 'string') return 'text';
  if (schema['type'] === 'array' && Array.isArray(items?.['enum'])) return 'choices';
  if (schema['type'] === 'array' && items?.['type'] === 'string') return 'list';
  if (schema['type'] === 'object' && members?.['type'] === 'string' && schema['properties'] === undefined) return 'map';
  return 'structured';
};

const isSection = (schema: Readonly<Record<string, unknown>>): boolean => schema['type'] === 'object' && isRecord(schema['properties']) && schema['additionalProperties'] === false;

const leavesUnder = (properties: Readonly<Record<string, unknown>>, prefix: readonly string[]): SettingLeaf[] =>
  Object.entries(properties).flatMap(([name, schema]) => {
    if (!isRecord(schema)) return [];
    const path = [...prefix, name];
    return isSection(schema) ? leavesUnder(schema['properties'] as Readonly<Record<string, unknown>>, path) : [{ key: path.join('.'), path, schema, kind: kindOf(schema) }];
  });

export const settingLeaves = (schema: { readonly properties: Readonly<Record<string, unknown>> } = SETTINGS_SCHEMA): SettingLeaf[] => leavesUnder(schema.properties, []);

export type LiveSetting = { readonly name: string; store(context: SlashContext, value: string, signal: AbortSignal): Promise<void> };

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const liveOf = (leaf: SettingLeaf, live: readonly LiveSetting[]): LiveSetting | undefined => {
  const [section, name, ...rest] = leaf.path;
  return section === 'tui' && name !== undefined && rest.length === 0 ? live.find((row) => row.name === kebab(name)) : undefined;
};

export type SettingSource = 'default' | SettingsLayer;

const valueAt = (document: unknown, path: readonly string[]): unknown => path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), document);

export const currentOf = (snapshot: SettingsSnapshot, path: readonly string[]): { value: unknown; source: SettingSource } => {
  for (const view of snapshot.layers.toReversed()) {
    const value = valueAt(view.document, path);
    if (value !== undefined) return { value, source: view.layer };
  }
  return { value: valueAt(snapshot.defaults, path), source: 'default' };
};

const inLayer = (snapshot: SettingsSnapshot, layer: SettingsLayer, path: readonly string[]): unknown => valueAt(snapshot.layers.find((view) => view.layer === layer)?.document, path);

const wordOf = (value: unknown): string => (typeof value === 'boolean' ? switchWordOf(value) : String(value));

export const shownValue = (value: unknown): string => {
  if (value === undefined) return NOT_SET;
  if (Array.isArray(value)) return value.length === 0 ? NONE : value.every((member) => typeof member === 'string') ? value.join(', ') : `${value.length} entries`;
  if (isRecord(value)) return Object.keys(value).length === 0 ? NONE : Object.keys(value).join(', ');
  return wordOf(value);
};

export const settingRowLabel = (label: string, value: unknown, source: SettingSource, applied?: boolean): string =>
  [label, shownValue(value), source, ...(applied === undefined ? [] : [applied ? APPLIES_NOW : APPLIES_NEXT_SESSION])].join('  ');

type Listed = { readonly kind: 'heading' } | { readonly kind: 'open' } | { readonly kind: 'setting'; readonly leaf: SettingLeaf; readonly presentation: SettingPresentation } | { readonly kind: 'command'; readonly command: string };

export const settingsRows = (snapshot: SettingsSnapshot, commands: readonly { readonly name: string }[], written: string | undefined): { rows: PickRow[]; listed: Listed[] } => {
  const leaves = settingLeaves();
  const rows: PickRow[] = [{ label: OPEN_SETTINGS_FILE_ROW }];
  const listed: Listed[] = [{ kind: 'open' }];
  for (const section of SETTING_SECTIONS) {
    const links = Object.entries(COMMAND_LINKS).filter(([, link]) => link.section === section);
    const settings = leaves.flatMap((leaf) => {
      const presentation = SETTING_ROWS[leaf.key];
      return presentation?.section === section ? [{ leaf, presentation }] : [];
    });
    if (links.length + settings.length === 0) continue;
    rows.push({ label: section, separator: true });
    listed.push({ kind: 'heading' });
    for (const [command, link] of links) {
      const known = commands.some((candidate) => candidate.name === command);
      rows.push({ label: `${link.label}  /${command}`, ...(known ? {} : { disabled: true }) });
      listed.push({ kind: 'command', command });
    }
    for (const { leaf, presentation } of settings) {
      const { value, source } = currentOf(snapshot, leaf.path);
      rows.push({ label: settingRowLabel(presentation.label, value, source, written === leaf.key ? presentation.appliesNow : undefined) });
      listed.push({ kind: 'setting', leaf, presentation });
    }
  }
  return { rows, listed };
};

export const settingsFileLines = (snapshot: SettingsSnapshot): string[] => [...snapshot.layers.map((view) => (view.layer === 'user' ? settingsFileLine(view.file) : `${view.layer}: ${view.file}`)), ...(snapshot.mcpFile === undefined ? [] : [`.mcp.json: ${snapshot.mcpFile}`])];

export type Refusal = { readonly refused: string };

export const writeSetting = async (context: SlashContext, layer: SettingsLayer, operation: SettingsOperation): Promise<Refusal | undefined> => {
  try {
    await context.background(SAVING_SETTING, (signal) => context.backend.editSettings(layer, operation, signal));
    return undefined;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { refused: error.message };
  }
};

export const saveTargetOf = async (context: SlashContext, snapshot: SettingsSnapshot, source: SettingSource): Promise<SettingsLayer | undefined> => {
  if (source === 'default' || source === 'user' || !snapshot.targets.includes(source)) return 'user';
  const choice = await context.overlays.choose({ title: SAVE_TO_TITLE, rows: snapshot.targets.map((label) => ({ label })), initial: snapshot.targets.indexOf(source), decideOn: 'enter', escape: 'back', filter: false });
  return choice === undefined ? undefined : snapshot.targets[choice.index];
};

export const chooseSaveTarget = async (context: SlashContext, snapshot: SettingsSnapshot): Promise<SettingsLayer | undefined> => {
  if (snapshot.targets.length < 2) return 'user';
  const choice = await context.overlays.choose({ title: SAVE_TO_TITLE, rows: snapshot.targets.map((label) => ({ label })), initial: 0, decideOn: 'enter', escape: 'back', filter: false });
  return choice === undefined ? undefined : snapshot.targets[choice.index];
};

export const confirmed = async (context: SlashContext, question: string): Promise<boolean> => {
  const choice = await context.overlays.choose({ title: question, rows: CONFIRM_ROWS.map((label) => ({ label })), initial: CONFIRM_ROWS.indexOf('No'), decideOn: 'enter', escape: CONFIRM_ROWS.indexOf('No'), filter: false });
  return choice?.index === CONFIRM_ROWS.indexOf('Yes');
};

type Outcome = { readonly kind: 'left' } | { readonly kind: 'written' } | { readonly kind: 'refused'; readonly sentence: string };

const LEFT: Outcome = { kind: 'left' };

const outcomeOf = (refusal: Refusal | undefined): Outcome => (refusal === undefined ? { kind: 'written' } : { kind: 'refused', sentence: refusal.refused });

const boundsOf = (schema: Readonly<Record<string, unknown>>): { minimum: number | undefined; maximum: number | undefined; whole: boolean } => ({
  minimum: typeof schema['minimum'] === 'number' ? schema['minimum'] : undefined,
  maximum: typeof schema['maximum'] === 'number' ? schema['maximum'] : undefined,
  whole: schema['type'] === 'integer',
});

export const rangeText = (schema: Readonly<Record<string, unknown>>): string => {
  const { minimum, maximum, whole } = boundsOf(schema);
  const noun = whole ? 'a whole number' : 'a number';
  if (minimum !== undefined && maximum !== undefined) return `${noun} from ${minimum} to ${maximum}`;
  if (minimum !== undefined) return `${noun} from ${minimum}`;
  if (maximum !== undefined) return `${noun} up to ${maximum}`;
  return noun;
};

const numberProblem = (schema: Readonly<Record<string, unknown>>, text: string): string | undefined => {
  const { minimum, maximum, whole } = boundsOf(schema);
  const value = Number(text);
  const fits = text.trim() !== '' && Number.isFinite(value) && (!whole || Number.isInteger(value)) && (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum);
  return fits ? undefined : `expected ${rangeText(schema)}`;
};

const typed = (leaf: SettingLeaf, presentation: SettingPresentation, current: unknown, context: SlashContext): Promise<string | undefined> =>
  context.overlays.promptText({
    title: presentation.label,
    ...(leaf.kind === 'number' ? { lines: [rangeText(leaf.schema)] } : {}),
    initial: current === undefined ? '' : String(current),
    validate: (text) => (leaf.kind === 'number' ? numberProblem(leaf.schema, text) : undefined),
  });

const scalarValue = async (leaf: SettingLeaf, presentation: SettingPresentation, current: unknown, context: SlashContext): Promise<{ value: unknown } | undefined> => {
  if (leaf.kind === 'toggle') return { value: current !== true };
  if (leaf.kind === 'choice') {
    const values = leaf.schema['enum'] as readonly unknown[];
    const choice = await context.overlays.choose({ title: presentation.label, rows: values.map((value) => ({ label: String(value) })), initial: Math.max(0, values.indexOf(current)), decideOn: 'enter', escape: 'back', filter: false });
    return choice === undefined ? undefined : { value: values[choice.index] };
  }
  const text = await typed(leaf, presentation, current, context);
  if (text === undefined) return undefined;
  if (leaf.kind === 'number') return { value: Number(text) };
  return { value: text === '' ? undefined : text };
};

const editScalar = async (context: SlashContext, snapshot: SettingsSnapshot, leaf: SettingLeaf, presentation: SettingPresentation, live: LiveSetting | undefined): Promise<Outcome> => {
  const { value: current, source } = currentOf(snapshot, leaf.path);
  const chosen = await scalarValue(leaf, presentation, current, context);
  if (chosen === undefined) return LEFT;
  if (presentation.confirm !== undefined && chosen.value === presentation.confirm.value && !(await confirmed(context, presentation.confirm.question))) return LEFT;
  if (live !== undefined && chosen.value !== undefined) {
    await context.background(SAVING_SETTING, (signal) => live.store(context, wordOf(chosen.value), signal));
    return { kind: 'written' };
  }
  const layer = await saveTargetOf(context, snapshot, source);
  if (layer === undefined) return LEFT;
  return outcomeOf(await writeSetting(context, layer, chosen.value === undefined ? { kind: 'unset', path: leaf.path } : { kind: 'set', path: leaf.path, value: chosen.value }));
};

const moved = <T,>(items: readonly T[], from: number, to: number): T[] => {
  if (to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
};

const without = <T,>(items: readonly T[], index: number): T[] | undefined => {
  const next = items.filter((_, position) => position !== index);
  return next.length === 0 ? undefined : next;
};

type Collection = {
  readonly title: string;
  readonly lines?: readonly string[];
  readonly applied?: string;
  entries(snapshot: SettingsSnapshot): readonly string[];
  add(context: SlashContext, snapshot: SettingsSnapshot): Promise<Refusal | 'left' | undefined>;
  act(context: SlashContext, snapshot: SettingsSnapshot, index: number): Promise<Refusal | 'left' | 'remove' | undefined>;
  removal(snapshot: SettingsSnapshot, index: number): Removal | undefined;
};

export type Removal = { readonly question: string; remove(context: SlashContext): Promise<Refusal | undefined> };

export const removeQuestion = (what: string): string => `Remove ${what}?`;

export const chosenAction = async <Action extends string>(context: SlashContext, title: string, actions: readonly Action[]): Promise<Action | undefined> => {
  const choice = await context.overlays.choose({ title, rows: actions.map((label) => ({ label })), decideOn: 'enter', escape: 'back', filter: false });
  return choice === undefined ? undefined : actions[choice.index];
};

const removeAfterAsking = async (context: SlashContext, removal: Removal | undefined): Promise<Refusal | 'left' | undefined> => {
  if (removal === undefined || !(await confirmed(context, removal.question))) return 'left';
  return removal.remove(context);
};

export const runCollection = async (context: SlashContext, collection: Collection): Promise<boolean> => {
  let at = 0;
  let sentence: string | undefined;
  let changed = false;
  let changedNow = false;
  for (;;) {
    const snapshot = await context.backend.settings();
    const entries = collection.entries(snapshot);
    const choice = await context.overlays.choose({
      title: collection.title,
      lines: [...(collection.lines ?? []), ...(sentence === undefined ? [] : [sentence]), ...(sentence === undefined && changedNow && collection.applied !== undefined ? [collection.applied] : [])],
      rows: [...entries.map((label) => ({ label })), { label: ADD_ROW }],
      initial: Math.min(at, entries.length),
      decideOn: 'enter',
      escape: 'back',
      filter: false,
      alt: { label: DELETE_LABEL, key: 'select.delete' },
    });
    if (choice === undefined) return changed;
    at = choice.index;
    const isAdd = choice.index === entries.length;
    if (isAdd && choice.alt) {
      changedNow = false;
      continue;
    }
    const asked = isAdd ? await collection.add(context, snapshot) : choice.alt ? 'remove' : await collection.act(context, snapshot, choice.index);
    const result = asked === 'remove' ? await removeAfterAsking(context, collection.removal(snapshot, choice.index)) : asked;
    sentence = result === undefined || result === 'left' ? undefined : result.refused;
    changedNow = result === undefined;
    changed = changed || changedNow;
  }
};

const listCollection = (leaf: SettingLeaf, presentation: SettingPresentation, layer: SettingsLayer): Collection => {
  const own = (snapshot: SettingsSnapshot): readonly string[] => {
    const value = inLayer(snapshot, layer, leaf.path);
    return Array.isArray(value) ? (value as string[]) : [];
  };
  const store = (context: SlashContext, next: readonly string[] | undefined): Promise<Refusal | undefined> => writeSetting(context, layer, next === undefined ? { kind: 'unset', path: leaf.path } : { kind: 'set', path: leaf.path, value: next });
  return {
    title: `${presentation.label} (${layer})`,
    entries: own,
    add: async (context, snapshot) => {
      const text = await context.overlays.promptText({ title: presentation.label, validate: (entry) => (entry.trim() === '' ? 'expected a value' : undefined) });
      return text === undefined ? 'left' : store(context, [...own(snapshot), text]);
    },
    act: async (context, snapshot, index) => {
      const items = own(snapshot);
      const chosen = await chosenAction(context, items[index] ?? '', LIST_ACTIONS);
      if (chosen === undefined) return 'left';
      return chosen === 'Remove' ? 'remove' : store(context, moved(items, index, chosen === 'Move up' ? index - 1 : index + 1));
    },
    removal: (snapshot, index) => {
      const items = own(snapshot);
      const item = items[index];
      return item === undefined ? undefined : { question: removeQuestion(item), remove: (context) => store(context, without(items, index)) };
    },
  };
};

const PAIR = /^([^=\s]+)=([\s\S]*)$/;

const mapCollection = (leaf: SettingLeaf, presentation: SettingPresentation, layer: SettingsLayer): Collection => {
  const own = (snapshot: SettingsSnapshot): Readonly<Record<string, unknown>> => {
    const value = inLayer(snapshot, layer, leaf.path);
    return isRecord(value) ? value : {};
  };
  const store = (context: SlashContext, next: Readonly<Record<string, unknown>>): Promise<Refusal | undefined> =>
    writeSetting(context, layer, Object.keys(next).length === 0 ? { kind: 'unset', path: leaf.path } : { kind: 'set', path: leaf.path, value: next });
  return {
    title: `${presentation.label} (${layer})`,
    lines: ['NAME=value'],
    entries: (snapshot) => Object.entries(own(snapshot)).map(([name, value]) => `${name}=${String(value)}`),
    add: async (context, snapshot) => {
      const text = await context.overlays.promptText({ title: presentation.label, lines: ['NAME=value'], validate: (entry) => (PAIR.test(entry) ? undefined : 'expected NAME=value') });
      const pair = text === undefined ? null : PAIR.exec(text);
      if (pair === null) return 'left';
      return store(context, { ...own(snapshot), [pair[1] as string]: pair[2] as string });
    },
    act: async (context, snapshot, index) => {
      const entry = Object.entries(own(snapshot))[index];
      if (entry === undefined) return 'left';
      return (await chosenAction(context, `${entry[0]}=${String(entry[1])}`, REMOVE_ACTIONS)) === undefined ? 'left' : 'remove';
    },
    removal: (snapshot, index) => {
      const entries = Object.entries(own(snapshot));
      const entry = entries[index];
      return entry === undefined ? undefined : { question: removeQuestion(entry[0]), remove: (context) => store(context, Object.fromEntries(entries.filter((_, position) => position !== index))) };
    },
  };
};

const formValues = async (context: SlashContext, title: string, form: readonly FormField[], initial: Readonly<Record<string, unknown>>): Promise<Record<string, unknown> | undefined> => {
  const values: Record<string, unknown> = {};
  for (const field of form) {
    const before = initial[field.name];
    const text = await context.overlays.promptText({
      title: `${title}: ${field.label}`,
      initial: before === undefined ? '' : String(before),
      validate: (entry) => {
        if (entry.trim() === '') return field.required ? 'expected a value' : undefined;
        return field.kind === 'number' && !Number.isFinite(Number(entry)) ? 'expected a number' : undefined;
      },
    });
    if (text === undefined) return undefined;
    if (text.trim() !== '') values[field.name] = field.kind === 'number' ? Number(text) : text;
  }
  return values;
};

const entryLine = (presentation: SettingPresentation, entry: unknown): string => (isRecord(entry) && presentation.line !== undefined ? presentation.line(entry) : JSON.stringify(entry));

const formCollection = (leaf: SettingLeaf, presentation: SettingPresentation, form: readonly FormField[], layer: SettingsLayer): Collection => {
  const own = (snapshot: SettingsSnapshot): readonly unknown[] => {
    const value = inLayer(snapshot, layer, leaf.path);
    return Array.isArray(value) ? (value as unknown[]) : [];
  };
  const store = (context: SlashContext, next: readonly unknown[] | undefined): Promise<Refusal | undefined> => writeSetting(context, layer, next === undefined ? { kind: 'unset', path: leaf.path } : { kind: 'set', path: leaf.path, value: next });
  return {
    title: `${presentation.label} (${layer})`,
    entries: (snapshot) => own(snapshot).map((entry) => entryLine(presentation, entry)),
    add: async (context, snapshot) => {
      const values = await formValues(context, presentation.label, form, {});
      return values === undefined ? 'left' : store(context, [...own(snapshot), { ...values, ...presentation.constants }]);
    },
    removal: (snapshot, index) => {
      const items = own(snapshot);
      return index >= items.length ? undefined : { question: removeQuestion(entryLine(presentation, items[index])), remove: (context) => store(context, without(items, index)) };
    },
    act: async (context, snapshot, index) => {
      const items = own(snapshot);
      const chosen = await chosenAction(context, entryLine(presentation, items[index]), ENTRY_ACTIONS);
      if (chosen === undefined) return 'left';
      if (chosen === 'Remove') return 'remove';
      const before = items[index];
      const values = await formValues(context, presentation.label, form, isRecord(before) ? before : {});
      return values === undefined ? 'left' : store(context, items.map((item, position) => (position === index ? { ...values, ...presentation.constants } : item)));
    },
  };
};

const editChoices = async (context: SlashContext, leaf: SettingLeaf, presentation: SettingPresentation, layer: SettingsLayer): Promise<Outcome> => {
  const values = ((leaf.schema['items'] as Readonly<Record<string, unknown>>)['enum'] as readonly unknown[]).map(String);
  let at = 0;
  let outcome: Outcome = LEFT;
  for (;;) {
    const snapshot = await context.backend.settings();
    const stored = inLayer(snapshot, layer, leaf.path);
    const chosen = Array.isArray(stored) ? (stored as unknown[]).map(String) : (currentOf(snapshot, leaf.path).value as readonly string[] | undefined) ?? [];
    const choice = await context.overlays.choose({
      title: `${presentation.label} (${layer})`,
      lines: outcome.kind === 'refused' ? [outcome.sentence] : [],
      rows: values.map((value) => ({ label: `[${chosen.includes(value) ? 'x' : ' '}] ${value}` })),
      initial: at,
      decideOn: 'enter',
      escape: 'back',
      filter: false,
    });
    if (choice === undefined) return outcome;
    at = choice.index;
    const value = values[choice.index] as string;
    const next = values.filter((candidate) => (candidate === value ? !chosen.includes(candidate) : chosen.includes(candidate)));
    outcome = outcomeOf(await writeSetting(context, layer, { kind: 'set', path: leaf.path, value: next }));
  }
};

const jsonProblem = (text: string): string | undefined => {
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return error.message;
  }
};

const editStructured = async (context: SlashContext, snapshot: SettingsSnapshot, leaf: SettingLeaf, presentation: SettingPresentation, layer: SettingsLayer): Promise<Outcome> => {
  let draft = JSON.stringify(inLayer(snapshot, layer, leaf.path) ?? {}, null, 2);
  let sentence: string | undefined;
  for (;;) {
    const text = await context.overlays.promptText({ title: presentation.label, lines: [...STRUCTURED_LINES, ...(sentence === undefined ? [] : [sentence])], initial: draft, validate: jsonProblem });
    if (text === undefined) return LEFT;
    draft = text;
    const value: unknown = JSON.parse(text);
    const empty = isRecord(value) && Object.keys(value).length === 0;
    const refusal = await writeSetting(context, layer, empty ? { kind: 'unset', path: leaf.path } : { kind: 'set', path: leaf.path, value });
    if (refusal === undefined) return { kind: 'written' };
    sentence = refusal.refused;
  }
};

export const DIALECTS_KEY = 'models.dialects';

const writeDialects = async (context: SlashContext, dialects: object): Promise<Refusal | undefined> => {
  const host = context.backend.modelsHost(new AbortController().signal, context.info);
  try {
    await context.background(SAVING_SETTING, (signal) => editModelsSettings(host.home, host.settingsFile, [{ kind: 'setDialects', dialects }], { lock: host.lock, signal }));
    return undefined;
  } catch (error) {
    if (!(error instanceof ModelsEditRefused)) throw error;
    return { refused: error.message };
  }
};

const editDialects = async (context: SlashContext, snapshot: SettingsSnapshot, leaf: SettingLeaf, presentation: SettingPresentation): Promise<Outcome> => {
  let draft = JSON.stringify(inLayer(snapshot, 'user', leaf.path) ?? {}, null, 2);
  let sentence: string | undefined;
  for (;;) {
    const text = await context.overlays.promptText({ title: presentation.label, lines: [...STRUCTURED_LINES, ...(sentence === undefined ? [] : [sentence])], initial: draft, validate: jsonProblem });
    if (text === undefined) return LEFT;
    draft = text;
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
      sentence = 'The schema dialects are a JSON object.';
      continue;
    }
    const refusal = await writeDialects(context, value);
    if (refusal === undefined) return { kind: 'written' };
    sentence = refusal.refused;
  }
};

const editSetting = async (context: SlashContext, snapshot: SettingsSnapshot, leaf: SettingLeaf, presentation: SettingPresentation, live: readonly LiveSetting[]): Promise<Outcome> => {
  if (leaf.key === DIALECTS_KEY) return editDialects(context, snapshot, leaf, presentation);
  if (leaf.kind === 'toggle' || leaf.kind === 'choice' || leaf.kind === 'number' || leaf.kind === 'text') return editScalar(context, snapshot, leaf, presentation, liveOf(leaf, live));
  const layer = await saveTargetOf(context, snapshot, currentOf(snapshot, leaf.path).source);
  if (layer === undefined) return LEFT;
  if (leaf.kind === 'choices') return editChoices(context, leaf, presentation, layer);
  if (leaf.kind === 'structured' && presentation.form === undefined) return editStructured(context, snapshot, leaf, presentation, layer);
  const collection = leaf.kind === 'list' ? listCollection(leaf, presentation, layer) : leaf.kind === 'map' ? mapCollection(leaf, presentation, layer) : formCollection(leaf, presentation, presentation.form ?? [], layer);
  return (await runCollection(context, collection)) ? { kind: 'written' } : LEFT;
};

export const runSettingsScreen = async (context: SlashContext, live: readonly LiveSetting[]): Promise<void> => {
  let at = 0;
  let written: string | undefined;
  let sentence: string | undefined;
  for (;;) {
    const snapshot = await context.backend.settings();
    const { rows, listed } = settingsRows(snapshot, context.commands, written);
    const choice = await context.overlays.choose({ title: SETTINGS_TITLE, lines: sentence === undefined ? [] : [sentence], rows, initial: at, decideOn: 'enter', escape: 'back', filter: true });
    const chosen = choice === undefined ? undefined : listed[choice.index];
    if (choice === undefined || chosen === undefined || chosen.kind === 'heading') return;
    at = choice.index;
    if (chosen.kind === 'open') {
      context.info(settingsFileLines(snapshot).join('\n'));
      return;
    }
    if (chosen.kind === 'command') {
      await context.commands.find((command) => command.name === chosen.command)?.run('', context);
      continue;
    }
    const outcome = await editSetting(context, snapshot, chosen.leaf, chosen.presentation, live);
    written = outcome.kind === 'written' ? chosen.leaf.key : undefined;
    sentence = outcome.kind === 'refused' ? outcome.sentence : undefined;
  }
};
