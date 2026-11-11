import { describe, expect, it } from 'vitest';
import { attachmentSummaryOf, includedShellTexts, toPublicRunEvent, userMessageContent, userShellText } from '@momonga/protocol';
import type { MessageAttachment, RunEvent, UserShellRecord } from '@momonga/protocol';

const FILE: MessageAttachment = { type: 'attached_file', path: 'src/app.tsx', content: '     1\tone\n     2\ttwo', truncated: false };
const NOTE: MessageAttachment = { type: 'attachment_note', path: '.env', text: 'The user referenced .env, which cannot be attached (denied by a rule). Do not try to read it unless asked.', shown: '.env: not attached (denied by a rule)' };
const SHOWN: UserShellRecord = { command: 'make test', exitCode: 2, output: 'FAIL', include: true };
const KEPT_OUT: UserShellRecord = { command: 'cat notes', exitCode: 0, output: 'private', include: false };

describe('what the model receives for a user message', () => {
  it('is the text alone when nothing is attached', () => {
    expect(userMessageContent('hello', undefined)).toEqual([{ type: 'input_text', text: 'hello' }]);
  });

  it('gives the output of ! in the form of a user shell command apart from the typed text, and leaves the output of !! out', () => {
    expect(userShellText(SHOWN)).toBe('<user_shell_command><command>make test</command><exit_code>2</exit_code><output>FAIL</output></user_shell_command>');
    expect(includedShellTexts([SHOWN, KEPT_OUT])).toEqual([userShellText(SHOWN)]);
    expect(userMessageContent('why', undefined)).toEqual([{ type: 'input_text', text: 'why' }]);
  });

  it('gives an interrupted command an empty exit code', () => {
    expect(userShellText({ command: 'sleep 9', exitCode: null, output: '' })).toBe('<user_shell_command><command>sleep 9</command><exit_code></exit_code><output></output></user_shell_command>');
  });

  it('puts one part per attached file and per note after the text', () => {
    expect(userMessageContent('explain @src/app.tsx', undefined, { attachments: [FILE, NOTE] })).toEqual([
      { type: 'input_text', text: 'explain @src/app.tsx' },
      { type: 'input_text', text: '<attached_file path="src/app.tsx">\n     1\tone\n     2\ttwo\n</attached_file>' },
      { type: 'input_text', text: NOTE.text },
    ]);
  });
});

describe('what a client receives for a user message', () => {
  it('names the path and the line count of an attached file and the notice of a refused one, never the content', () => {
    expect(attachmentSummaryOf(FILE)).toEqual({ type: 'attached_file', path: 'src/app.tsx', lines: 2 });
    expect(attachmentSummaryOf(NOTE)).toEqual({ type: 'attachment_note', path: '.env', shown: '.env: not attached (denied by a rule)' });
    const event: RunEvent = { type: 'user.message', text: 'explain', attachments: [FILE, NOTE], shell: [KEPT_OUT], id: 1, runId: 'r', sessionId: 's', seq: 1, step: 0, leaseToken: 0, createdAt: 1 };
    const shown = toPublicRunEvent(event);
    expect(shown).toMatchObject({ attachments: [attachmentSummaryOf(FILE), attachmentSummaryOf(NOTE)], shell: [KEPT_OUT] });
    expect(JSON.stringify(shown)).not.toContain('one');
  });
});
