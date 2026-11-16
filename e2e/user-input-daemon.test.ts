import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createE2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { shutdownBarrier, startStack } from './support/stack.ts';
import { chatCompletions, textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const NOTE = 'the note the mention attaches';
const SHELL_OUTPUT = 'shell-output-for-the-model';

describe('the user input of the daemon: ! commands and @ mentions through the runtime the product starts (P-265)', () => {
  it('a ! command runs in the session folder through the runtime and its output reaches the next run; an @ mention in a trusted folder reaches the model as the file contents', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, needsBash: true, script: [textReply('seen')] });
    const runtime = createRuntimeClient(home);
    try {
      fs.writeFileSync(path.join(home.project, 'notes.txt'), NOTE);
      const { session } = await runtime.createSession();
      const output: string[] = [];

      const ended = await runtime.userShell(session.id, `ls notes.txt && printf ${SHELL_OUTPUT}`, true, { onOutput: (text) => void output.push(text), onUnprotected: () => undefined });

      expect(ended).toMatchObject({ kind: 'exit', record: { command: `ls notes.txt && printf ${SHELL_OUTPUT}`, exitCode: 0, include: true } });
      expect(output.join('')).toContain(`notes.txt\n${SHELL_OUTPUT}`);
      expect((await runtime.json('GET', `/v1/sessions/${session.id}/user-shell`)).body).toMatchObject({ pending: [{ exitCode: 0, include: true }] });

      expect((await runtime.json('PUT', '/v1/trust', { path: home.project, decision: 'trusted' })).status).toBe(200);
      const { run } = await runtime.createRun(session.id, 'look at @notes.txt', { attachMentions: true });
      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} is COMPLETED` });
      const sent = JSON.stringify(chatCompletions(stack.fake).at(-1)?.body);
      expect(sent).toContain(SHELL_OUTPUT);
      expect(sent).toContain(NOTE);
    } finally {
      await runtime.close();
    }
    await shutdownBarrier(stack);
  });
});
