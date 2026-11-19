import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as config from '@momonga/config';
import { SETTINGS_SCHEMA } from '@momonga/config';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { HUB_ACTIONS, MODELS_TITLE } from '../packages/cli/src/tui/models/texts.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

type WriterRow = { path: string; operations: readonly string[]; inSession: readonly string[]; shell: readonly string[] };
type Pending = { form: string; removedBy: 'N3a' | 'N3b' };
type Schema = Record<string, unknown>;

const root = path.resolve(import.meta.dirname, '..');
const cliSource = path.join(root, 'packages', 'cli', 'src');

const OPERATIONS = [
  'addModel',
  'removeModel',
  'removeConnection',
  'setStart',
  'setFallback',
  'allowBillingChange',
  'forbidBillingChange',
  'setRole',
  'setClassifier',
  'setModelField',
  'setConnectionField',
  'setProvider',
  'declareServer',
  'setServerField',
  'forgetServer',
  'setTimeouts',
  'setEffort',
  'setDialects',
] as const;

const PENDING: readonly Pending[] = [];

const CONNECTION_PATH = 'models.connections[]';
const ENTRY_PATH = `${CONNECTION_PATH}.models[]`;
const REMOVAL_WRITER = { operations: ['removeConnection', 'removeModel'], inSession: ['Models'], shell: ['momonga models remove-server', 'momonga models remove'] } as const;

const FIXED_ROWS: readonly WriterRow[] = [
  { path: `${CONNECTION_PATH}.plan.profile`, operations: ['addModel'], inSession: ['/login'], shell: ['momonga auth login'] },
  { path: CONNECTION_PATH, operations: ['removeConnection'], inSession: ['Models'], shell: ['momonga models remove-server'] },
  { path: 'models.servers.*', operations: ['removeConnection', 'declareServer', 'setServerField', 'forgetServer'], inSession: ['Models'], shell: ['momonga models remove-server --forget-program', 'momonga models add-program', 'momonga models set-program', 'momonga models forget-program'] },
  { path: `${CONNECTION_PATH}.provider`, operations: ['setProvider'], inSession: ['Models'], shell: ['momonga models name'] },
  { path: `${ENTRY_PATH}.id`, operations: ['addModel', 'removeModel', 'setModelField'], inSession: ['Models'], shell: ['momonga models add', 'momonga models remove', 'momonga models set'] },
  { path: 'models.start', operations: ['setStart', ...REMOVAL_WRITER.operations], inSession: ['Models › Model for new sessions', '/model --start', ...REMOVAL_WRITER.inSession], shell: ['momonga models start', ...REMOVAL_WRITER.shell] },
  { path: 'models.fallback[]', operations: ['setFallback', ...REMOVAL_WRITER.operations], inSession: ['Models › Fallback models', ...REMOVAL_WRITER.inSession], shell: ['momonga models fallback', ...REMOVAL_WRITER.shell] },
  { path: 'models.roles.*', operations: ['setRole', ...REMOVAL_WRITER.operations], inSession: ['Models › Models for other roles', ...REMOVAL_WRITER.inSession], shell: ['momonga models role', ...REMOVAL_WRITER.shell] },
  { path: 'autoMode.classifier', operations: ['setClassifier', ...REMOVAL_WRITER.operations], inSession: ['Models › Models for other roles', '/auto-mode', ...REMOVAL_WRITER.inSession], shell: ['momonga models role set classifier', ...REMOVAL_WRITER.shell] },
  { path: 'models.billingChanges[].from', operations: ['allowBillingChange', 'forbidBillingChange'], inSession: ['Models › Billing changes', 'Models › Fallback models'], shell: ['momonga models billing'] },
  { path: 'models.billingChanges[].to', operations: ['allowBillingChange', 'forbidBillingChange'], inSession: ['Models › Billing changes', 'Models › Fallback models'], shell: ['momonga models billing'] },
  { path: 'models.billingChanges[].model', operations: ['allowBillingChange', 'forbidBillingChange', ...REMOVAL_WRITER.operations], inSession: ['Models › Billing changes', 'Models › Fallback models', ...REMOVAL_WRITER.inSession], shell: ['momonga models billing', ...REMOVAL_WRITER.shell] },
  { path: 'models.dialects.*', operations: ['setDialects'], inSession: ['/config'], shell: ['momonga models dialects set'] },
  { path: 'models.headersTimeoutMs', operations: ['setTimeouts'], inSession: ['Models › Wait limits'], shell: ['momonga models timeouts'] },
  { path: 'models.idleTimeoutMs', operations: ['setTimeouts'], inSession: ['Models › Wait limits'], shell: ['momonga models timeouts'] },
  { path: 'models.effort', operations: ['setEffort'], inSession: ['/config'], shell: ['momonga models effort'] },
];

const fieldOfLeaf = (leaf: string, prefix: string): string =>
  leaf
    .slice(prefix.length + 1)
    .split('.')
    .map((segment) => (segment.endsWith('[]') ? segment.slice(0, -2) : segment))
    .filter((segment) => segment !== '*')
    .join('.');

const settable = (subject: 'model' | 'server', field: string): boolean => {
  try {
    config.settableFieldPath(subject, field);
    return true;
  } catch (error) {
    if (error instanceof config.ModelsEditRefused) return false;
    throw error;
  }
};

const fieldRowOf = (leaf: string): WriterRow | undefined => {
  if (leaf.startsWith(`${ENTRY_PATH}.`)) {
    return settable('model', fieldOfLeaf(leaf, ENTRY_PATH)) ? { path: leaf, operations: ['setModelField'], inSession: ['Models'], shell: ['momonga models set'] } : undefined;
  }
  if (leaf.startsWith(`${CONNECTION_PATH}.`)) {
    return settable('server', fieldOfLeaf(leaf, CONNECTION_PATH)) ? { path: leaf, operations: ['setConnectionField', 'addModel'], inSession: ['Models'], shell: ['momonga models set-server', 'momonga models add'] } : undefined;
  }
  return undefined;
};

const rows = (): readonly WriterRow[] => [...FIXED_ROWS, ...settingLeaves().flatMap((leaf) => (FIXED_ROWS.some((row) => covers(row.path, leaf)) ? [] : (fieldRowOf(leaf) ?? [])))];

const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);

const branchesOf = (schema: Schema): Schema[] => ['oneOf', 'anyOf', 'allOf'].flatMap((key) => (Array.isArray(schema[key]) ? (schema[key] as unknown[]).filter(isSchema) : []));

const leavesOf = (schema: Schema, at: string): string[] => {
  const below: string[] = [];
  for (const branch of branchesOf(schema)) below.push(...leavesOf(branch, at));
  if (isSchema(schema['properties'])) for (const [key, child] of Object.entries(schema['properties'])) if (isSchema(child)) below.push(...leavesOf(child, `${at}.${key}`));
  if (isSchema(schema['additionalProperties'])) below.push(...leavesOf(schema['additionalProperties'], `${at}.*`));
  if (isSchema(schema['items']) && (isSchema(schema['items']['properties']) || branchesOf(schema['items']).length > 0)) below.push(...leavesOf(schema['items'], `${at}[]`));
  return below.length === 0 ? [at] : below;
};

const sectionOf = (...keys: string[]): Schema => {
  let schema: Schema = SETTINGS_SCHEMA as unknown as Schema;
  for (const key of keys) {
    const properties = schema['properties'];
    if (!isSchema(properties) || !isSchema(properties[key])) throw new Error(`SETTINGS_SCHEMA has no ${keys.join('.')}`);
    schema = properties[key];
  }
  return schema;
};

const settingLeaves = (): string[] => [...new Set([...leavesOf(sectionOf('models'), 'models'), ...leavesOf(sectionOf('autoMode', 'classifier'), 'autoMode.classifier')])].sort();

const withoutListMark = (keyPath: string): string => (keyPath.endsWith('[]') ? keyPath.slice(0, -2) : keyPath);

const covers = (rowPath: string, leaf: string): boolean => {
  if (withoutListMark(rowPath) === withoutListMark(leaf)) return true;
  return rowPath.endsWith('.*') && leaf.startsWith(rowPath.slice(0, -1));
};

const wordsOf = (form: string): string[] => form.split(/\s+/).filter((word) => word.length > 0 && !word.startsWith('--') && !word.startsWith('<') && !word.startsWith('['));

const slashFormOf = (form: string): string => wordsOf(form).slice(0, 2).join(' ');

const shellFormOf = (form: string): string => wordsOf(form).slice(0, 3).join(' ');

const slashSources = (): string =>
  [path.join(cliSource, 'tui', 'slash.ts'), ...fs.readdirSync(path.join(cliSource, 'tui', 'commands')).map((name) => path.join(cliSource, 'tui', 'commands', name))].map((file) => fs.readFileSync(file, 'utf8')).join('\n');

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const slashReached = (form: string, sources: string): boolean => {
  const [command, sub] = wordsOf(form);
  if (command === undefined || !new RegExp(`name:\\s*['"]${escaped(command.slice(1))}['"]`).test(sources)) return false;
  return sub === undefined || new RegExp(`['"]${escaped(sub)}['"]`).test(sources);
};

const shellReached = (form: string, register: string): boolean => {
  const [, group, sub] = wordsOf(form);
  if (group === undefined || !new RegExp(`\\.command\\(\\s*['"]${escaped(group)}[ '"]`).test(register)) return false;
  return sub === undefined || new RegExp(`\\b${escaped(group)}\\s*\\.command\\(\\s*['"]${escaped(sub)}[ '"]`).test(register);
};

const pendingOf = (increment: Pending['removedBy']): string[] => PENDING.filter((entry) => entry.removedBy === increment).map((entry) => entry.form).sort();

describe('every model setting can be changed from inside MomongaCode (I-N13)', () => {
  it('every leaf of the schema under models and autoMode.classifier has a writer: a fixed row or a field the models writer can set', () => {
    const table = rows();
    const leaves = settingLeaves();
    expect(leaves).toContain('models.start');
    expect(leaves).toContain('models.connections[].models[].id');
    expect(leaves).toContain('models.connections[].provider');
    expect(leaves.filter((leaf) => leaf.startsWith('models.targets') || leaf.startsWith('models.aliases'))).toEqual([]);
    expect(leaves.filter((leaf) => !table.some((row) => covers(row.path, leaf)))).toEqual([]);
    for (const row of table) expect(row.operations.length, row.path).toBeGreaterThan(0);
  });

  it('every operation of the writer is named by a row, and a row names only operations of the writer', () => {
    expect([...new Set(rows().flatMap((row) => row.operations))].sort()).toEqual([...OPERATIONS].sort());
  });

  it('every in-session way a row names is a row of the Models screen, reached from /model and /config', () => {
    const screenForms = [...new Set(rows().flatMap((row) => row.inSession).filter((form) => !form.startsWith('/')))].sort();
    expect(screenForms.length).toBeGreaterThan(0);
    expect(screenForms.filter((form) => { const [screen, row] = form.split(' › '); return screen !== MODELS_TITLE || (row !== undefined && !(HUB_ACTIONS as readonly string[]).includes(row)); })).toEqual([]);
  });

  it('every in-session command a row names is in the slash registry, or is listed as pending until the screens are built', () => {
    const sources = slashSources();
    const named = [...new Set(rows().flatMap((row) => row.inSession).filter((form) => form.startsWith('/')).map(slashFormOf))].sort();
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((form) => !slashReached(form, sources))).toEqual(pendingOf('N3b'));
  });

  it('a row reaches a setting through /config only when the settings screen has a row of that key', () => {
    const screen = fs.readFileSync(path.join(cliSource, 'tui', 'settings-screen.tsx'), 'utf8');
    const throughConfig = rows().filter((row) => row.inSession.some((form) => slashFormOf(form) === '/config'));
    const screenKeyOf = (rowPath: string): string => withoutListMark(rowPath.endsWith('.*') ? rowPath.slice(0, -2) : rowPath);
    expect(throughConfig.length).toBeGreaterThan(0);
    expect(throughConfig.map((row) => screenKeyOf(row.path)).filter((key) => !new RegExp(`['"]${escaped(key)}['"]\\s*:\\s*\\{\\s*label`).test(screen))).toEqual([]);
  });

  it('every shell form a row names is registered, or is listed as pending until the shell forms are built', () => {
    const register = fs.readFileSync(path.join(cliSource, 'commands', 'register.ts'), 'utf8');
    const named = [...new Set(rows().flatMap((row) => row.shell).map(shellFormOf))].sort();
    expect(named.filter((form) => !form.startsWith('momonga '))).toEqual([]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((form) => !shellReached(form, register))).toEqual(pendingOf('N3a'));
  });
});
