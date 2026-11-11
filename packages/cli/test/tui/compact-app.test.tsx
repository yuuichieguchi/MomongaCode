import { describe, expect, it } from 'vitest';
import { DEFAULT_SLASH_COMMANDS } from '../../src/tui/commands/index.ts';
import { runView } from '../fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import { frame, runStarted, start, type } from '../tui-harness.tsx';

const WIDE = { columns: 140, rows: 60 };
const TASK_RUNNING = 'A task is running. Esc stops it.';

const compacting = async (line: string, call: string) => {
  const started = await start({}, {}, WIDE);
  await type(started.app, line, `> ${line}`);
  started.app.stdin.write(KEYS.enter);
  await started.backend.called(call);
  await untilOutput(started.app, `> ${line}`);
  return started;
};

describe('/compact', () => {
  it('is in the command registry with its usage', () => {
    expect(DEFAULT_SLASH_COMMANDS.find((listed) => listed.name === 'compact')?.usage).toBe('[instructions]');
  });

  it('starts the compaction, shows the phase in the waiting row and writes the row with the token counts', async () => {
    const { app, backend } = await compacting('/compact', 'compact');
    expect(backend.started).toEqual([]);
    backend.emit(frame({ type: 'context.compacting', step: 0, attempt: 1 }));
    await untilFrame(app, 'compacting the conversation');
    backend.emit(frame({ type: 'context.compacted', summary: 's', replacedThroughSeq: 3, tokensBefore: 84_000, tokensAfter: 12_000 }));
    const shown = await untilOutput(app, 'Compacted: 84k -> 12k tokens');
    expect(shown).not.toContain('context compacted');
    backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
    backend.finish(runView());
    await untilFrame(app, (now) => !now.includes('compacting the conversation'));
    app.unmount();
  });

  it('gives the text after the command as the focus of the summary', async () => {
    const { app, backend } = await compacting('/compact keep the parser decisions', 'compact:keep the parser decisions');
    backend.finish(runView());
    app.unmount();
  });

  it('shows the notice of a compaction that had nothing to cut', async () => {
    const { app, backend } = await compacting('/compact', 'compact');
    backend.emit(frame({ type: 'notice', level: 'info', message: 'Nothing to compact.', code: 'nothing_to_compact' }));
    await untilOutput(app, 'Nothing to compact.');
    backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }));
    backend.finish(runView());
    app.unmount();
  });

  it('is refused while a run is open', async () => {
    const { app, backend } = await start({}, {}, WIDE);
    await runStarted(backend, app, 'go');
    await type(app, '/compact', '> /compact');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, TASK_RUNNING);
    expect(backend.calls.filter((call) => call.startsWith('compact'))).toEqual([]);
    backend.finish(runView());
    app.unmount();
  });
});
