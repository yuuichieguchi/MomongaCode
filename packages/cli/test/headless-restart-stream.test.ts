import { EXIT_OK } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { watchRun } from '../src/run/headless.ts';
import { runView } from './fake-backend.ts';
import { eventFrame, textDelta, watchedRun } from './headless-fakes.ts';

describe('a restarted stream in a headless run', () => {
  it('drops the text entries the restart names and keeps the rest, whatever its step and attempt say', async (context) => {
    const frames = [
      textDelta(1, 'm0', 'Kept before.'),
      textDelta(2, 'm1', 'I looked at'),
      eventFrame(3, { type: 'model.stream.restarted', step: 7, attempt: 9, itemIds: ['m1'] }),
      textDelta(4, 'm2', 'It adds two numbers.'),
    ];
    const run = watchedRun(withTempDir(context, { asHome: true }), frames, runView({ id: 'run-1', status: 'COMPLETED' }));

    expect(await watchRun(run.ports, run.paths, { client: run.client, runId: 'run-1', format: 'text', verbose: false, interrupt: new AbortController().signal, onInterrupt: 'cancel' })).toBe(EXIT_OK);

    expect(run.stdout.join('')).toBe('Kept before.\nIt adds two numbers.\n');
  });

  it('keeps every entry of a restart that names none', async (context) => {
    const frames = [textDelta(1, 'm1', 'Answer.'), eventFrame(2, { type: 'model.stream.restarted', step: 1, attempt: 0, itemIds: [] })];
    const run = watchedRun(withTempDir(context, { asHome: true }), frames, runView({ id: 'run-1', status: 'COMPLETED' }));

    expect(await watchRun(run.ports, run.paths, { client: run.client, runId: 'run-1', format: 'json', verbose: false, interrupt: new AbortController().signal, onInterrupt: 'cancel' })).toBe(EXIT_OK);

    expect(run.stdout.join('')).toContain('"Answer."');
  });
});
