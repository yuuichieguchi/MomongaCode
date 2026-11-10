import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView, ImageAttachment, SkillView } from '@momonga/protocol';
import { maxDiffLines } from '../src/tui/diff.ts';
import { panelRowsCap } from '../src/tui/screen/layout.ts';
import { FRAME_BOUND_MS, KEYS, untilFrame, untilOutput, withoutLinks } from './ink-helpers.ts';
import { frame, runStarted, start, type } from './tui-harness.tsx';

const FORM: ElicitationRequestView = {
  key: 'profile',
  mode: 'form',
  message: 'Tell me about you',
  requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Your name' }, age: { type: 'integer' } }, required: ['name'] },
};
const URL_REQUEST: ElicitationRequestView = { key: 'consent', mode: 'url', message: 'Sign in to continue', url: 'https://auth.example.test/consent?token=abc123&state=xyz' };

const toolCall = (callId: string, name = 'mcp__calc__ask') =>
  frame({ type: 'tool.call', callId, providerCallId: `p-${callId}`, name, kind: 'other', title: `${name} {}`, rawInput: {} });

const requestInput = (inputId: string, callId: string, requests: ElicitationRequestView[]) =>
  frame({ type: 'tool.elicitation.requested', inputId, callId, server: 'calc', requests });

const PNG: ImageAttachment = { mediaType: 'image/png', data: Buffer.from('png-bytes').toString('base64') };

const PDF: SkillView = { name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/p/.agents/skills/pdf/SKILL.md' };

const wrappedAtWordGaps = (text: string): RegExp =>
  new RegExp(
    text
      .split(' ')
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[ \\n]'),
  );

const pasted = (text: string): string => `\u001b[200~${text}\u001b[201~`;

describe('elicitation in the TUI', () => {
  it('names the server, validates each field and sends the accepted content to the elicitation', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'ask the calculator');
    backend.emit(toolCall('c1'));
    backend.emit(requestInput('in1', 'c1', [FORM]));

    const prompt = await untilFrame(app, 'MCP server calc asks for input');
    expect(prompt).toContain('Tell me about you');
    expect(prompt).toContain('Your name (name, string, required)');

    await type(app, 'Ada', '> Ada');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'age, integer, optional');
    await type(app, 'old', '> old');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'age must be a number');
    expect(backend.elicitationAnswers).toEqual([]);

    app.stdin.write('36');
    await untilFrame(app, '> 36');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, '1. Submit');
    app.stdin.write('1');
    await backend.called('elicit:in1');
    expect(backend.elicitationAnswers).toEqual([{ inputId: 'in1', responses: { profile: { action: 'accept', content: { name: 'Ada', age: 36 } } } }]);
    app.unmount();
  });

  it('lets an optional field be skipped and a person decline instead of answering', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'ask');
    backend.emit(toolCall('c1'));
    backend.emit(requestInput('in1', 'c1', [FORM]));
    await untilFrame(app, 'MCP server calc asks for input');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, '2. Decline');
    app.stdin.write('2');
    await backend.called('elicit:in1');
    expect(backend.elicitationAnswers[0]?.responses).toEqual({ profile: { action: 'decline' } });
    app.unmount();
  });

  it('shows the whole url of a url request and opens it only after the person consents', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'ask');
    backend.emit(toolCall('c1'));
    backend.emit(requestInput('in2', 'c1', [URL_REQUEST]));
    const prompt = await untilFrame(app, 'Sign in to continue');
    expect(prompt).toContain(`URL: ${URL_REQUEST.mode === 'url' ? URL_REQUEST.url : ''}`);
    expect(backend.openedUrls).toEqual([]);
    app.stdin.write('1');
    await backend.called('elicit:in2');
    expect(backend.openedUrls).toEqual([URL_REQUEST.mode === 'url' ? URL_REQUEST.url : '']);
    expect(backend.elicitationAnswers[0]?.responses).toEqual({ consent: { action: 'accept' } });
    app.unmount();
  });

  it('answers the URL elicitation and reports a failed browser launch as a notice', { timeout: 3 * FRAME_BOUND_MS }, async () => {
    const { backend, app } = await start({ openUrlFailure: new Error('no browser') });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'ask');
    backend.emit(toolCall('c1'));
    backend.emit(requestInput('in2', 'c1', [URL_REQUEST]));
    await untilFrame(app, 'Sign in to continue');
    app.stdin.write('1');
    const url = URL_REQUEST.mode === 'url' ? URL_REQUEST.url : '';
    const notice = `MCP server calc: Could not open the browser (no browser). Open this URL to continue: ${url}`;
    const shown = withoutLinks(await untilOutput(app, (output) => wrappedAtWordGaps(notice).test(withoutLinks(output))));
    expect(wrappedAtWordGaps(notice).exec(shown)?.[0].replaceAll('\n', ' ')).toBe(notice);
    expect(await untilOutput(app, `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`)).toContain(url);
    expect(backend.elicitationAnswers).toEqual([{ inputId: 'in2', responses: { consent: { action: 'accept' } } }]);
    app.unmount();
  });

  it('clears the prompt when the runtime reports the elicitation resolved', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'ask');
    backend.emit(toolCall('c1'));
    backend.emit(requestInput('in1', 'c1', [URL_REQUEST]));
    await untilFrame(app, 'Sign in to continue');
    backend.emit(frame({ type: 'tool.elicitation.cancelled', inputId: 'in1', reason: 'expired' }));
    const idle = await untilFrame(app, /^(?![\s\S]*asks for input)[\s\S]*working \(esc to cancel\)/);
    expect(idle).not.toContain('asks for input');
    app.unmount();
  });
});

describe('MCP authorization in the TUI', () => {
  it('tells the person which command authorizes the server', async () => {
    const { backend, app } = await start();
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'use remote');
    backend.emit(frame({ type: 'mcp.authorization.required', callId: 'c1', server: 'remote' }));
    await untilOutput(app, 'MCP server remote needs authorization; run: momonga mcp login remote');
    app.unmount();
  });
});

describe('skills in the TUI', () => {
  it('completes a skill name with tab and starts the run with the skill field', async () => {
    const { backend, app } = await start({ skills: [PDF] });
    await untilFrame(app, 'mode: manual');
    await type(app, '/pd', '> /pd');
    await untilFrame(app, '/pdf (tab completes)');
    app.stdin.write('\t');
    await untilFrame(app, '> /pdf');
    app.stdin.write('summarize report.pdf');
    await untilFrame(app, '> /pdf summarize report.pdf');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, '> summarize report.pdf');
    expect(backend.started).toEqual([{ text: 'summarize report.pdf', history: 'inherit', options: { skill: 'pdf' } }]);
    app.unmount();
  });

  it('reports the warnings of the skill scan and lists the skill in /help', async () => {
    const { app } = await start({ skills: [PDF], skillWarnings: ['Project skills were skipped because the folder is not trusted'] }, { startup: { version: '1.0.0', home: '/home/none', color: false } });
    await untilOutput(app, 'Project skills were skipped because the folder is not trusted');
    await type(app, '/help', '> /help');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, '/pdf <task>  Extract PDF text');
    app.unmount();
  });
});

describe('images in the TUI', () => {
  it('attaches a pasted image path when the model declares image input and sends it with the next prompt', async () => {
    const { backend, app } = await start({ imageInput: true, images: { '/tmp/shot.png': PNG } });
    await untilFrame(app, 'image input: paste a file path');
    app.stdin.write(pasted('/tmp/shot.png'));
    await untilFrame(app, 'attached shot.png (image/png, 9 bytes)');
    await type(app, 'what is this', '> what is this');
    app.stdin.write(KEYS.enter);
    await untilOutput(app, '> what is this');
    await backend.called('openSession');
    expect(backend.started).toEqual([{ text: 'what is this', history: 'inherit', options: { images: [PNG] } }]);
    app.unmount();
  });

  it('inserts a pasted path as text when the model does not declare image input', async () => {
    const { backend, app } = await start({ imageInput: false, images: { '/tmp/shot.png': PNG } });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'first');
    backend.emit(frame({ type: 'usage.updated', inputTokens: 1, outputTokens: 1, totalTokens: 2 }));
    await untilFrame(app, 'tokens: 2');
    app.stdin.write(pasted('/tmp/shot.png'));
    await untilFrame(app, '> /tmp/shot.png');
    expect(backend.started).toEqual([{ text: 'first', history: 'inherit' }]);
    app.unmount();
  });

  it('removes the last attachment with backspace on an empty input', async () => {
    const { app } = await start({ imageInput: true, images: { '/tmp/shot.png': PNG } });
    await untilFrame(app, 'image input: paste a file path');
    app.stdin.write(pasted('/tmp/shot.png'));
    await untilFrame(app, 'attached shot.png');
    app.stdin.write('\u007f');
    const after = await untilFrame(app, /^(?!.*attached shot\.png)/s);
    expect(after).not.toContain('attached shot.png');
    app.unmount();
  });
});

describe('approval diff size', () => {
  it('clips the diff to the rows the terminal leaves after the prompt chrome', async () => {
    const { backend, app } = await start({}, {}, { rows: 20 });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'write a file');
    const content = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Write', kind: 'edit', title: 'Write /work/a.txt', rawInput: { file_path: '/work/a.txt', content } }));
    backend.emit(
      frame({
        type: 'tool.permission.requested',
        approvalId: 'ap1',
        callId: 'c1',
        subjectDigest: 'd',
        reason: 'edits require approval',
        options: [
          { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'o3', name: 'Reject once', kind: 'reject_once' },
        ],
      }),
    );
    const visible = maxDiffLines(panelRowsCap(20), 2);
    const prompt = await untilFrame(app, 'Permission requested: Write /work/a.txt');
    expect(prompt).toContain(`… ${31 - visible} more lines`);
    expect(prompt).toContain(`+ line ${visible - 2}`);
    expect(prompt).not.toContain(`+ line ${visible - 1}`);
    app.unmount();
  });
});
