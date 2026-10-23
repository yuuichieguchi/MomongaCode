import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { finishApprovingPrompts, launchRuntime, scriptedToolCall, startStack } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: 60_000 };

describe('token budget after a low reported prompt usage (system timers, in-process gateway)', () => {
  it('a run with contextWindow 8192 and a scripted Read whose usage reports prompt_tokens 10 reaches COMPLETED, not pinned_overflow', PROCESS_TIMEOUT, async () => {
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
