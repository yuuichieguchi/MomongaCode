import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { finishApprovingPrompts, launchRuntime, scriptedToolCall, startStack } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

describe('token budget against the input tokens a server reports (system timers, in-process gateway)', () => {
  it('a run with contextWindow 8192 whose server reports prompt_tokens 10 for a context of thousands fails with input_truncated, not pinned_overflow', PROCESS_TIMEOUT, async () => {
    const stack = await startStack((temp) => ({
      script: [scriptedToolCall('Read', { file_path: path.join(temp.project, 'notes.txt') }, 'call_1', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })],
    }));
    fs.writeFileSync(path.join(stack.temp.project, 'notes.txt'), 'remember this\n');
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id, { input: 'Read the notes' });
    expect(await finishApprovingPrompts(launched, stack.temp, run.id)).toBe('FAILED');
    const view = (await launched.http('GET', `/v1/runs/${run.id}`)).json.run;
    expect(view.error.code).toBe('input_truncated');
    expect(view.error.message).toContain("server's context length");
    expect(view.error.message).toContain('contextWindow');
    expect(stack.completions()).toBe(1);
  });

  it('a run with contextWindow 8192 whose server counts the request it received reaches COMPLETED', PROCESS_TIMEOUT, async () => {
    const stack = await startStack((temp) => ({ script: [scriptedToolCall('Read', { file_path: path.join(temp.project, 'notes.txt') })] }));
    fs.writeFileSync(path.join(stack.temp.project, 'notes.txt'), 'remember this\n');
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id, { input: 'Read the notes' });
    expect(await finishApprovingPrompts(launched, stack.temp, run.id)).toBe('COMPLETED');
    const view = (await launched.http('GET', `/v1/runs/${run.id}`)).json.run;
    expect(view.error).toBeUndefined();
    expect(stack.completions()).toBe(2);
  });
});
