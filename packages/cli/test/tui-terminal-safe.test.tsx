import { describe, expect, it } from 'vitest';
import { untilFrame, untilOutput, withoutLinks } from './ink-helpers.ts';
import { frame, runStarted, start } from './tui-harness.tsx';

const HOSTILE = 'x\u001b[31m\u001b]8;;http://evil.test\u0007link\u001b]8;;\u0007\u009b2J‮y';
const ESCAPED = 'x\\u001b[31m\\u001b]8;;http://evil.test\\u0007link\\u001b]8;;\\u0007\\u009b2J\\u202ey';

const reachesTheTerminal = (output: string): boolean => /\u001b|‮|\u009b/u.test(output);

describe('the TUI prints text a person did not write escaped', () => {
  it('escapes assistant text, a tool title, the output of a failed tool and a notice', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: `first\n${HOSTILE}` }));
    await untilOutput(app, 'first');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: `Bash ${HOSTILE}`, rawInput: { command: 'ls' } }));
    backend.emit(frame({ type: 'tool.completed', callId: 'c1', status: 'failed', output: `out:${HOSTILE}` }));
    backend.emit(frame({ type: 'notice', level: 'warning', message: `note:${HOSTILE}` }));
    await untilOutput(app, (shown) => withoutLinks(shown).includes(`note:${ESCAPED}`));
    const output = withoutLinks(app.frames.join('\n'));
    expect(app.frames.join('\n')).toContain('\u001b]8;;http://evil.test\u0007http://evil.test\u001b]8;;\u0007');
    expect(reachesTheTerminal(output)).toBe(false);
    expect(output).toContain(`first\n${ESCAPED}`);
    expect(output).toContain(`✗ Bash ${ESCAPED}`);
    expect(output).toContain(`out:${ESCAPED}`);
    app.unmount();
  });

  it('escapes the title, the reason and the option names of a permission prompt', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: HOSTILE, rawInput: { command: 'ls' } }));
    backend.emit(
      frame({
        type: 'tool.permission.requested',
        approvalId: 'ap1',
        callId: 'c1',
        subjectDigest: 'd',
        reason: HOSTILE,
        options: [{ optionId: 'o1', name: HOSTILE, kind: 'allow_once' }],
        shown: { title: 'approval', input: {} },
      }),
    );
    const prompt = withoutLinks(await untilFrame(app, 'Permission requested'));
    expect(reachesTheTerminal(prompt)).toBe(false);
    expect(prompt.split(ESCAPED).length - 1).toBe(4);
    app.unmount();
  });
});
