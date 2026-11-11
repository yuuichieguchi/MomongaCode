import crypto from 'node:crypto';
import path from 'node:path';
import { defineProductSchema } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { CONDITION_WHENS, PERMISSION_MODES } from '@momonga/protocol';
import type { ConditionWhen, Mandate, PermissionMode } from '@momonga/protocol';
import { ASK_RESPONSES, DatasetError, describeFirstError, isInsideWorkspace, jsonOf } from './dataset.ts';
import type { AskResponse } from './dataset.ts';
import type { WorkspaceFiles } from './files.ts';
import { EVIDENCE_KINDS, ORACLE_CHECKS_SCHEMA } from './oracle-check.ts';
import type { OracleCheck } from './oracle-check.ts';

export { EVIDENCE_KINDS };
export type { OracleCheck };

export const BENCH_FORMAT = 'momonga-bench/1';
export const BENCH_DEFAULT_RUNS = 3;

export const BENCH_TASK_TYPES = ['bug_fix', 'add_test', 'lint_fix', 'docs_update', 'dependency_update'] as const;
export type BenchTaskType = (typeof BENCH_TASK_TYPES)[number];

export const BENCH_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type BenchDifficulty = (typeof BENCH_DIFFICULTIES)[number];

export type BenchTask = {
  id: string;
  repository: string;
  taskType: BenchTaskType;
  difficulty: BenchDifficulty;
  labelledBy: string;
  labelledAt: string;
  prompt: string;
  permissionMode: PermissionMode;
  onAsk: AskResponse;
  budget: { maxSteps: number; maxTotalTokens: number; timeoutMs: number };
  runs?: number;
  setup: { run: string; timeoutMs: number }[];
  graderFiles: Record<string, string>;
  declaration: { id: string; command: string; when: ConditionWhen }[];
  oracle: OracleCheck[];
  reference: { directory: string };
};

export type Benchmark = {
  format: typeof BENCH_FORMAT;
  name: string;
  repositories: Record<string, { directory: string; digest: string }>;
  tasks: BenchTask[];
};

const text = { type: 'string', minLength: 1 } as const;
const count = { type: 'integer', minimum: 1 } as const;
export const BENCH_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    format: { const: BENCH_FORMAT },
    name: text,
    repositories: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { directory: text, digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
        required: ['directory', 'digest'],
        additionalProperties: false,
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          repository: text,
          taskType: { enum: [...BENCH_TASK_TYPES] },
          difficulty: { enum: [...BENCH_DIFFICULTIES] },
          labelledBy: text,
          labelledAt: text,
          prompt: text,
          permissionMode: { enum: [...PERMISSION_MODES] },
          onAsk: { enum: [...ASK_RESPONSES] },
          budget: {
            type: 'object',
            properties: { maxSteps: count, maxTotalTokens: count, timeoutMs: count },
            required: ['maxSteps', 'maxTotalTokens', 'timeoutMs'],
            additionalProperties: false,
          },
          runs: count,
          setup: { type: 'array', items: { type: 'object', properties: { run: text, timeoutMs: count }, required: ['run', 'timeoutMs'], additionalProperties: false } },
          graderFiles: { type: 'object', additionalProperties: { type: 'string' } },
          declaration: {
            type: 'array',
            items: { type: 'object', properties: { id: text, command: text, when: { enum: [...CONDITION_WHENS] } }, required: ['id', 'command', 'when'], additionalProperties: false },
          },
          oracle: ORACLE_CHECKS_SCHEMA,
          reference: { type: 'object', properties: { directory: text }, required: ['directory'], additionalProperties: false },
        },
        required: [
          'id',
          'repository',
          'taskType',
          'difficulty',
          'labelledBy',
          'labelledAt',
          'prompt',
          'permissionMode',
          'onAsk',
          'budget',
          'setup',
          'graderFiles',
          'declaration',
          'oracle',
          'reference',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['format', 'name', 'repositories', 'tasks'],
  additionalProperties: false,
} as const;

export const mandateOfTask = (task: Pick<BenchTask, 'declaration'>): Mandate | undefined =>
  task.declaration.length === 0 ? undefined : { completion: { conditions: task.declaration.map(({ id, command, when }) => ({ id, command, when })) } };

const validateBenchmarkShape: ProductValidator<Benchmark> = defineProductSchema('eval/bench', BENCH_SCHEMA);

const assertBenchmarkConsistent = (benchmark: Benchmark, source: string): void => {
  const seen = new Set<string>();
  for (const [id, repository] of Object.entries(benchmark.repositories)) {
    if (!isInsideWorkspace(repository.directory)) throw new DatasetError(`${source}: repository ${id} has the directory ${JSON.stringify(repository.directory)}, which must be a relative path inside the benchmark directory`);
  }
  for (const task of benchmark.tasks) {
    if (seen.has(task.id)) throw new DatasetError(`${source}: duplicate task id ${task.id}`);
    seen.add(task.id);
    if (benchmark.repositories[task.repository] === undefined) throw new DatasetError(`${source}: task ${task.id} names the repository ${task.repository}, which the file does not declare`);
    if (!isInsideWorkspace(task.reference.directory)) throw new DatasetError(`${source}: task ${task.id} has the reference directory ${JSON.stringify(task.reference.directory)}, which must be a relative path inside the benchmark directory`);
    const inside = [
      ...Object.keys(task.graderFiles),
      ...task.oracle.flatMap((check) => (check.kind === 'command' ? [] : check.paths.map((entry) => entry.replace(/\/$/, '')))),
    ];
    for (const name of inside) {
      if (!isInsideWorkspace(name)) throw new DatasetError(`${source}: task ${task.id} names the path ${JSON.stringify(name)}; paths must be relative paths inside the workspace`);
    }
    const checkIds = new Set<string>();
    for (const check of task.oracle) {
      if (checkIds.has(check.id)) throw new DatasetError(`${source}: task ${task.id} has two oracle checks with the id ${check.id}`);
      checkIds.add(check.id);
    }
  }
};

export const parseBenchmark = (fileText: string, source: string): Benchmark => {
  const value = jsonOf(fileText, source);
  const format = typeof value === 'object' && value !== null ? (value as { format?: unknown }).format : undefined;
  if (format !== BENCH_FORMAT) throw new DatasetError(`${source}: the benchmark declares format ${JSON.stringify(format)}, which is not supported; this build reads ${BENCH_FORMAT}`);
  const verdict = validateBenchmarkShape(value);
  if (!verdict.valid) throw new DatasetError(`${source}: invalid benchmark at ${describeFirstError(verdict.errors)}`);
  assertBenchmarkConsistent(verdict.value, source);
  return verdict.value;
};

type TreeFiles = Pick<WorkspaceFiles, 'readdirEntries' | 'readFile'>;

const filesUnder = async (files: TreeFiles, root: string, relative = ''): Promise<string[]> => {
  const entries = await files.readdirEntries(path.join(root, relative));
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(files, root, child) : [child];
    }),
  );
  return nested.flat();
};

export const treeDigest = async (files: TreeFiles, directory: string): Promise<string> => {
  const hash = crypto.createHash('sha256');
  const names = (await filesUnder(files, directory)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const relative of names) {
    const content = crypto.createHash('sha256').update(await files.readFile(path.join(directory, relative))).digest('hex');
    hash.update(`${relative}\0${content}\0`);
  }
  return `sha256:${hash.digest('hex')}`;
};
