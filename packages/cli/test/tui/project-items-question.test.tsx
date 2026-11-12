import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { App } from '../../src/tui/app.tsx';
import { APPROVE_ROW, NOT_NOW_ROW, NOT_RECORDED_LINE } from '../../src/tui/project-items.ts';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, renderObservable, settleAtOnce, TEST_KEY_SETTLE_MS, untilFrame } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

const GROUP = { matcher: 'Bash', hooks: [{ type: 'command' as const, command: './scripts/check.sh --fix' }] };

const start = (options: FakeBackendOptions) => {
  const backend = fakeBackend(options);
  const app = renderObservable(<App backend={backend} terminal={fakeScreenTerminal({ columns: 120, rows: 40 })} initialMode={undefined} now={Date.now} timers={settleAtOnce(systemTiming)} keySettleMs={TEST_KEY_SETTLE_MS} onExit={() => undefined} />);
  return { backend, app };
};

describe('a hook group or mandate file of a trusted folder that is new or changed is asked about at the start', () => {
  it('shows the hook group in full and records its digest when the person approves it', async () => {
    const { backend, app } = start({ trustItems: { items: [{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: 'd1', source: '/work/.momonga/settings.json', change: { kind: 'new' } }], refused: [] } });
    const question = await untilFrame(app, APPROVE_ROW);
    expect(question).toContain('PreToolUse hook group');
    expect(question).toContain('/work/.momonga/settings.json');
    expect(question).toContain('./scripts/check.sh --fix');
    expect(question).toContain(NOT_NOW_ROW);
    app.stdin.write(KEYS.enter);
    await backend.called(`approve:${JSON.stringify([{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: 'd1' }])}`);
    await untilFrame(app, 'mode: manual');
    app.unmount();
  });

  it('says a mandate file changed since it was approved, shows it, and leaves it unapproved on Not now', async () => {
    const { backend, app } = start({ trustItems: { items: [{ kind: 'mandate', document: { deny: ['Bash(curl:*)'] }, digest: 'm1', source: '/work/.momonga/mandate.json', change: { kind: 'changed', diff: { hunks: [{ oldStart: 1, newStart: 1, lines: ['-{}', '+{ "deny": ["Bash(curl:*)"] }'] }], added: 1, removed: 1 } } }], refused: [] } });
    const question = await untilFrame(app, APPROVE_ROW);
    expect(question).toContain('changed since you approved it');
    expect(question).toMatch(/1 -\{\}/);
    expect(question).toMatch(/1 \+\{ "deny": \["Bash\(curl:\*\)"\] \}/);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, 'mode: manual');
    expect(backend.calls.some((call) => call.startsWith('approve:'))).toBe(false);
    app.unmount();
  });

  it('shows the sentence of a settings file the loader refuses and goes on to the start', async () => {
    const { app } = start({ trustItems: { items: [], refused: ['/work/.momonga/settings.json: Unexpected end of JSON input'] } });
    await untilFrame(app, '/work/.momonga/settings.json: Unexpected end of JSON input');
    await untilFrame(app, 'mode: manual');
    app.unmount();
  });

  it('shows all of an item whose earlier content is not recorded, and says so', async () => {
    const { app } = start({ trustItems: { items: [{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: 'd1', source: '/work/.momonga/settings.json', change: { kind: 'not-recorded' } }], refused: [] } });
    const question = await untilFrame(app, APPROVE_ROW);
    expect(question).toContain(NOT_RECORDED_LINE);
    expect(question).toContain('./scripts/check.sh --fix');
    app.unmount();
  });

  it('asks about an MCP server of the folder with its whole command and records its config on Approve', async () => {
    const config = { command: 'npx', args: ['docs-server', '--write'] };
    const { backend, app } = start({ trustItems: { items: [{ kind: 'mcp', name: 'docs', config, digest: 'm2', source: '/work/.mcp.json', change: { kind: 'new' } }], refused: [] } });
    const question = await untilFrame(app, APPROVE_ROW);
    expect(question).toContain('The MCP server docs of this folder is new');
    expect(question).toContain('docs-server');
    app.stdin.write(KEYS.enter);
    await backend.called(`approve:${JSON.stringify([{ kind: 'mcp', name: 'docs', config, digest: 'm2' }])}`);
    app.unmount();
  });

  it('shows every line of the current content of a changed item whose diff is omitted, with the reason, before Approve', async () => {
    const group = { matcher: 'Bash', hooks: Array.from({ length: 6 }, (_, index) => ({ type: 'command' as const, command: `./scripts/step-${index}.sh` })) };
    const { app } = start({ trustItems: { items: [{ kind: 'hook', event: 'PreToolUse', group, digest: 'd3', source: '/work/.momonga/settings.json', change: { kind: 'changed', diff: { diffOmitted: 'diff larger than 64 KiB' } } }], refused: [] } });
    const question = await untilFrame(app, APPROVE_ROW);
    expect(question).toContain('diff larger than 64 KiB');
    for (let index = 0; index < 6; index += 1) expect(question).toContain(`./scripts/step-${index}.sh`);
    app.unmount();
  });

  it('shows the full current content under the diff of a changed item', async () => {
    const { app } = start({ trustItems: { items: [{ kind: 'mandate', document: { steps: 50, deny: ['Bash(rm:*)'] }, digest: 'm4', source: '/work/.momonga/mandate.json', change: { kind: 'changed', diff: { hunks: [{ oldStart: 2, newStart: 2, lines: ['-  "steps": 5,', '+  "steps": 50,'] }], added: 1, removed: 1 } } }], refused: [] } });
    const question = await untilFrame(app, APPROVE_ROW);
    expect(question).toMatch(/2 \+  "steps": 50,/);
    expect(question).toContain('"Bash(rm:*)"');
    app.unmount();
  });
});
