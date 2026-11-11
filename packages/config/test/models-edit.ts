import fs from 'node:fs';
import * as config from '@momonga/config';
import * as protocol from '@momonga/protocol';
import { makeTree, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';
import type { KernelLockMechanism } from '@momonga/foundation';

export type Operation = { kind: string } & Record<string, unknown>;
export type EditResult = { wrote: boolean; summaries: string[]; model?: string };
export type Reference = { kind: 'start' | 'fallback' | 'role' | 'classifier' | 'billing'; position?: number; job?: string };
export type Planned = { document: Record<string, unknown>; references: Reference[]; warnings: string[]; summaries: string[] };
export type Plan = Planned | { refused: { code: string; message: string } };
export type Refused = { code: string; message: string };
export type Home = { tree: Tree; file: string };

export const op = (kind: string, args: Record<string, unknown> = {}): Operation => ({ kind, ...args });

const exported = <T>(name: string): T => {
  const value = (config as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@momonga/config does not export ${name} (packages/config/src/models-writers.ts)`);
  return value as T;
};

export const homeWith = (document?: unknown): Home => {
  const tree = makeTree();
  const file = userSettingsPath(tree);
  if (document !== undefined) writeJson(file, document);
  return { tree, file };
};

export const editModels = (home: Home, operations: readonly Operation[], signal: AbortSignal = new AbortController().signal, lock: KernelLockMechanism = testKernelLock()): Promise<EditResult> =>
  exported<(home: string, file: string, operations: readonly Operation[], options: { lock: KernelLockMechanism; signal: AbortSignal }) => Promise<EditResult>>('editModelsSettings')(home.tree.home, home.file, operations, { lock, signal });

export const planModels = (document: unknown, operations: readonly Operation[]): Plan =>
  exported<(document: unknown, operations: readonly Operation[], ports: unknown) => Plan>('planModelsEdit')(document, operations, {
    kinds: (protocol as Record<string, unknown>)['SERVER_KINDS'],
  });

export const refusalOfEdit = async (editing: Promise<unknown>): Promise<Refused> => {
  const error = await editing.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (error === undefined) throw new Error('the edit was accepted');
  const refusedClass = exported<new (...args: never[]) => Error>('ModelsEditRefused');
  if (!(error instanceof refusedClass)) throw new Error(`the edit failed with something other than ModelsEditRefused: ${String(error)}`);
  return { code: (error as Error & { code: string }).code, message: error.message };
};

export const textOf = (home: Home): string => fs.readFileSync(home.file, 'utf8');

export const documentOf = (home: Home): Record<string, unknown> => JSON.parse(textOf(home)) as Record<string, unknown>;

type ModelsSection = { connections?: Record<string, unknown>[]; start?: string; fallback?: string[]; roles?: Record<string, string>; billingChanges?: Record<string, unknown>[]; servers?: Record<string, unknown>; [key: string]: unknown };

export const modelsOf = (home: Home): ModelsSection => (documentOf(home)['models'] ?? {}) as ModelsSection;

export const connectionsOf = (home: Home): Record<string, unknown>[] => modelsOf(home).connections ?? [];

export const idsOf = (connection: Record<string, unknown> | undefined): string[] => ((connection?.['models'] ?? []) as { id: string }[]).map((entry) => entry.id);
