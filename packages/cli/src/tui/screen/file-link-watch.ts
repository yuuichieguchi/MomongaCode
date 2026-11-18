import { isTerminalStatus } from '../../run/follow.ts';
import type { Entry } from '../transcript.ts';
import { fileLinkCandidates } from './file-links.ts';
import type { FileLinks } from './file-links.ts';
import { isSettled } from './store.ts';
import type { TranscriptStore } from './store.ts';

export type ResolveFileLinks = (candidates: readonly string[], signal: AbortSignal) => Promise<FileLinks>;

export const fileLinkTextOf = (entry: Entry): string | undefined => {
  if (entry.kind === 'assistant') return entry.open ? undefined : entry.text;
  if (entry.kind === 'tool') return isSettled(entry) ? entry.title : undefined;
  return undefined;
};

type Job = { id: number; epoch: number; text: string; candidates: readonly string[] };

const withLinks = (entry: Entry, text: string, found: FileLinks): Entry => {
  if ((entry.kind !== 'assistant' && entry.kind !== 'tool') || fileLinkTextOf(entry) !== text) return entry;
  const before = entry.fileLinks;
  if (before !== undefined && [...found].every(([name, url]) => before.get(name) === url)) return entry;
  return { ...entry, fileLinks: new Map([...(before ?? []), ...found]) };
};

export const watchFileLinks = (store: TranscriptStore, resolve: ResolveFileLinks, signal: AbortSignal, onFailure: (error: unknown) => void): (() => void) => {
  const queue: Job[] = [];
  const asked = new Map<number, string>();
  const missed = new Map<number, Job>();
  let pumping = false;
  const runEnded = (): boolean => {
    const status = store.state().runStatus;
    return status === undefined || isTerminalStatus(status);
  };
  let ended = runEnded();

  const resolved = async (job: Job): Promise<void> => {
    const found = await resolve(job.candidates, signal);
    if (signal.aborted || store.epoch() !== job.epoch) return;
    const missing = job.candidates.filter((name) => !found.has(name));
    if (missing.length > 0) missed.set(job.id, { ...job, candidates: missing });
    else missed.delete(job.id);
    store.changeId(job.id, (entry) => withLinks(entry, job.text, found));
  };

  const pump = async (): Promise<void> => {
    pumping = true;
    for (let job = queue.shift(); job !== undefined && !signal.aborted; job = queue.shift()) {
      await resolved(job).catch((error: unknown) => {
        if (!signal.aborted) onFailure(error);
      });
    }
    pumping = false;
  };

  const ask = (job: Job): void => {
    queue.push(job);
    if (!pumping) void pump();
  };

  const look = (id: number): void => {
    const index = store.indexOfId(id);
    if (index === undefined) return;
    const text = fileLinkTextOf(store.at(index).entry);
    if (text === undefined || asked.get(id) === text) return;
    asked.set(id, text);
    const candidates = fileLinkCandidates(text);
    if (candidates.length > 0) ask({ id, epoch: store.epoch(), text, candidates });
  };

  const runChanged = (): void => {
    const now = runEnded();
    if (now && !ended) {
      const again = [...missed.values()].filter((job) => job.epoch === store.epoch());
      missed.clear();
      for (const job of again) ask(job);
    }
    ended = now;
  };

  for (let index = 0; index < store.count(); index += 1) look(store.at(index).id);
  const unsubscribe = store.subscribe((entryId) => {
    if (signal.aborted) return;
    if (entryId === undefined) runChanged();
    else look(entryId);
  });
  return unsubscribe;
};
