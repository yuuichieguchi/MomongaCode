import { archivableIds, duplicateMarks } from '@momonga/memory';
import type { DuplicateKeepers } from '@momonga/memory';
import type { Clock, FileSystem } from '@momonga/foundation';
import type { MemoryRecord } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import type { RecordViews } from './views.ts';

export type PageCursor = { createdAt: number; id: string };

export type UpkeepPass = {
  cursor: PageCursor | null;
  keepers: DuplicateKeepers;
  superseded: ReadonlySet<string>;
  days: Map<string | null, number>;
  missing: Set<string>;
  present: Set<string>;
};

export type MemoryUpkeepOptions = {
  store: Pick<RuntimeStore, 'memories'>;
  clock: Clock;
  fileSystem: Pick<FileSystem, 'stat'>;
  views: RecordViews;
  forgetAfterDays(project: string | null): Promise<number>;
  batchSize: number;
  signal: AbortSignal;
  pass?: UpkeepPass;
  pageRows?: number;
};

export type MemoryUpkeepResult = { duplicates: number; archived: number; skipped: string[]; done: boolean };

const UNLIMITED_ROWS = -1;

export const beginUpkeepPass = (store: Pick<RuntimeStore, 'memories'>): UpkeepPass => ({
  cursor: null,
  keepers: new Map(),
  superseded: store.memories.supersededIds(),
  days: new Map(),
  missing: new Set(),
  present: new Set(),
});

const isDirectory = async (fileSystem: Pick<FileSystem, 'stat'>, target: string): Promise<boolean> => {
  try {
    return (await fileSystem.stat(target)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
};

export const runMemoryUpkeep = async (options: MemoryUpkeepOptions): Promise<MemoryUpkeepResult> => {
  const { store, clock, views, batchSize, signal } = options;
  const pass = options.pass ?? beginUpkeepPass(store);
  const limit = options.pageRows ?? UNLIMITED_ROWS;
  const raw = store.memories.activePage(pass.cursor, limit);
  const skipped: string[] = [];
  const live = raw.filter((record) => !pass.superseded.has(record.id));
  for (const project of new Set(live.flatMap((record) => (record.project === null || pass.present.has(record.project) || pass.missing.has(record.project) ? [] : [record.project])))) {
    signal.throwIfAborted();
    if (await isDirectory(options.fileSystem, project)) {
      pass.present.add(project);
    } else {
      pass.missing.add(project);
      skipped.push(project);
    }
  }
  const page = live.filter((record) => record.project === null || pass.present.has(record.project));
  const duplicates = duplicateMarks(page, pass.keepers);
  const marks = duplicates.slice(0, batchSize);
  for (const mark of marks) store.memories.markDuplicate(mark.id, mark.duplicateOf);
  const last = raw.at(-1);
  const exhausted = limit === UNLIMITED_ROWS || raw.length < limit;
  if (duplicates.length > marks.length) return { duplicates: marks.length, archived: 0, skipped, done: false };
  const marked = new Set(marks.map((mark) => mark.id));
  const groups = new Map<string | null, MemoryRecord[]>();
  for (const record of page.filter((entry) => !marked.has(entry.id))) {
    groups.set(record.project, [...(groups.get(record.project) ?? []), record]);
  }
  const wanted: string[] = [];
  const failures: unknown[] = [];
  for (const [project, group] of groups) {
    signal.throwIfAborted();
    try {
      const known = pass.days.get(project);
      const forgetAfterDays = known ?? (await options.forgetAfterDays(project));
      pass.days.set(project, forgetAfterDays);
      const window = { now: clock.now(), forgetAfterDays };
      wanted.push(...archivableIds(await views.viewsOf(group, signal), window));
    } catch (error) {
      failures.push(error);
    }
  }
  const ids = wanted.slice(0, batchSize - marks.length);
  for (const id of ids) store.memories.archive(id);
  const complete = ids.length === wanted.length;
  if (complete && last !== undefined) pass.cursor = { createdAt: last.createdAt, id: last.id };
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `memory upkeep failed for ${failures.length} projects`);
  return { duplicates: marks.length, archived: ids.length, skipped, done: complete && exhausted };
};
