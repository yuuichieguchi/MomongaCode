import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETRY_KINDS, claimRetry, readAttemptRecord, readMarkerGroup, recordMarkerGroup } from '@momonga/foundation';
import type { RetryKind } from '@momonga/foundation';
import { cfgNames } from './formal/cfg-names.ts';
import { readManifest } from './formal/manifest.ts';

const specDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'ProcessMarker.tla'), 'utf8');
const manifest = readManifest(path.join(specDir, 'manifest.json'));

const modelEvents = (): string[] => {
  const match = /^Events == \{([^}]*)\}/m.exec(spec);
  if (match === null) throw new Error('Events is not defined in ProcessMarker.tla');
  return (match[1] as string).split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
};

type Write = { readonly position: number; readonly bytes: string; readonly after: string };

const recordingFiles = (): { files: { read(file: string): Promise<string>; writeByte(file: string, position: number, byte: string): Promise<void> }; text(): string; writes: Write[] } => {
  let content = '';
  const writes: Write[] = [];
  return {
    files: {
      read: async () => content,
      writeByte: async (_file, position, bytes) => {
        content = content.padEnd(position, '\0').slice(0, position) + bytes + content.slice(position + bytes.length);
        writes.push({ position, bytes, after: content });
      },
    },
    text: () => content,
    writes,
  };
};

type Step = { readonly kind: 'retry'; readonly event: RetryKind } | { readonly kind: 'group' } | { readonly kind: 'crash' };

const stepsOf = (length: number): Step[][] => {
  const alphabet: Step[] = [...RETRY_KINDS.map((event): Step => ({ kind: 'retry', event })), { kind: 'group' }, { kind: 'crash' }];
  let runs: Step[][] = [[]];
  for (let index = 0; index < length; index += 1) runs = runs.flatMap((run) => alphabet.map((step) => [...run, step]));
  return runs;
};

const MARKER = '/markers/m1';
const GROUP = 4242;
const names = { nameOf: () => undefined, recall: () => undefined };

describe('the attempt record of a marker does what specs/tla/ProcessMarker.tla states, on the event sequences of the model', () => {
  it('the retry kinds of the record are the Events of the model, in both directions', () => {
    expect([...RETRY_KINDS].sort()).toEqual(modelEvents().sort());
  });

  it('every retry is written to the record before it is granted, each event is granted at most once across crashes (OneRetryPerEvent), at most four in all (AtMostFourRetries), and a recorded group survives every later claim', async () => {
    const config = cfgNames(specDir, 'ProcessMarker.retryFull');
    expect(config.invariants).toEqual(expect.arrayContaining(['OneRetryPerEvent', 'AtMostFourRetries']));
    const failures: string[] = [];
    for (const run of stepsOf(5)) {
      const record = recordingFiles();
      const granted = new Map<RetryKind, number>();
      let grouped = false;
      for (const step of run) {
        if (step.kind === 'crash') continue;
        if (step.kind === 'group') {
          if (!grouped) await recordMarkerGroup(MARKER, GROUP, { files: record.files, names });
          grouped = true;
          continue;
        }
        const writesBefore = record.writes.length;
        const outcome = await claimRetry(MARKER, step.event, { signal: new AbortController().signal, files: record.files });
        if (outcome !== 'claimed') continue;
        granted.set(step.event, (granted.get(step.event) ?? 0) + 1);
        const persisted = record.writes.slice(writesBefore).some((write) => (/^r[01]{5}/.test(write.after) ? write.after[RETRY_KINDS.indexOf(step.event) + 1] === '1' : false));
        if (!persisted) failures.push(`${JSON.stringify(run)}: ${step.event} granted before the record held it`);
        if (grouped && (await readMarkerGroup(MARKER, { files: record.files })) !== GROUP) failures.push(`${JSON.stringify(run)}: the claim of ${step.event} lost the recorded group`);
      }
      for (const [event, count] of granted) if (count > 1) failures.push(`${JSON.stringify(run)}: ${event} granted ${count} times`);
      if ([...granted.values()].reduce((sum, count) => sum + count, 0) > 4) failures.push(`${JSON.stringify(run)}: more than four retries granted`);
      const reread = await readAttemptRecord(MARKER, { files: record.files });
      for (const event of granted.keys()) if (!reread.spent[event]) failures.push(`${JSON.stringify(run)}: ${event} is not spent after a crash`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('a record the reader cannot parse grants no retry, as the model treats an unknown record as spent', async () => {
    const record = recordingFiles();
    await record.files.writeByte(MARKER, 0, 'garbage');
    for (const event of RETRY_KINDS) expect(await claimRetry(MARKER, event, { signal: new AbortController().signal, files: record.files })).toBe('spent');
  });

  it('the fifth retry is an every-run evidence configuration that violates AtMostFourRetries', () => {
    expect(manifest.entries.find((entry) => entry.config === 'ProcessMarker.fifthRetry')).toMatchObject({ role: 'evidence', tier: 'every-run' });
  });
});
