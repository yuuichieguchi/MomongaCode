import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINIMUM_PAIRS, YIELD_ACCEPTANCE, YIELD_DATASET_FORMAT, YIELD_REPORT_KIND } from '@momonga/eval';
import type { YieldReport } from '@momonga/eval';
import type { FakeRoute } from '@momonga/testkit';
import { skipCase, titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { calibrationRoute, prefixProbeRoute } from './support/context-window.ts';
import { createE2eHome } from './support/home.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, upstreamModelRef, withStructuredModel, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const STRUCTURED_MODEL_ID = 'structured';
const STRUCTURED_MODEL_REF = upstreamModelRef(STRUCTURED_MODEL_ID);
const LEARN_TASK = 'Write the codename into codename.txt and run the check.';
const REUSE_TASK = 'Name the codename of the release.';
const CHECK = 'echo verified';
const ANCHOR = 'amber-falcon';
const NOTE = `The codename of the release is ${ANCHOR}, kept in codename.txt.`;
const RECALL_OPEN = '<recalled_memories>';
const RECORDED_RUN = '<recorded_run>';
const SESSIONS_PER_FAMILY = 3;

type ChatBody = { messages?: { role?: unknown; content?: unknown }[] };

const textsOf = (body: unknown): { role: string; text: string }[] =>
  ((body as ChatBody).messages ?? []).map((message) => ({ role: String(message.role), text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }));

const workspaceOf = (body: unknown): string => {
  const system = textsOf(body).find((message) => message.role === 'system')?.text ?? '';
  const match = /The working directory is (.+?) and the platform is/.exec(system);
  if (match?.[1] === undefined) throw new Error('the system prompt does not name the working directory');
  return match[1];
};

const asks = (body: unknown, needle: string): boolean => textsOf(body).some((message) => message.role === 'user' && message.text.includes(needle));

const isReflection = (body: unknown): boolean => textsOf(body).some((message) => message.text.includes(RECORDED_RUN));

const toolResultsOf = (body: unknown): number => textsOf(body).filter((message) => message.role === 'tool').length;

const reflectionRoute: FakeRoute = {
  match: isReflection,
  reply: textReply(JSON.stringify({ candidates: [{ text: NOTE, kind: 'fact', paths: ['codename.txt'] }] })),
};

const learnRoute: FakeRoute = {
  match: (body) => asks(body, LEARN_TASK),
  reply: (body) => {
    const done = toolResultsOf(body);
    if (done === 0) return toolCallReply('Write', { file_path: path.join(workspaceOf(body), 'codename.txt'), content: 'see the release notes\n' }, 'call_write');
    if (done === 1) return toolCallReply('Bash', { command: CHECK, description: 'run the check' }, 'call_check');
    return textReply('Wrote codename.txt and checked it.');
  },
};

const reuseRoute: FakeRoute = { match: (body) => asks(body, REUSE_TASK), reply: textReply('The codename is known.') };

const session = { permissionMode: 'acceptEdits', onAsk: 'allow_once' } as const;

const familyOf = (index: number) => ({
  id: `codename-${index}`,
  learn: { input: LEARN_TASK, ...session, files: { 'README.md': '# Release\n' }, verification: CHECK },
  reuse: { input: REUSE_TASK, ...session, graders: [{ kind: 'status', equals: 'COMPLETED' }] },
  accept: { anchors: [ANCHOR] },
});

const DATASET = { format: YIELD_DATASET_FORMAT, name: 'yield-e2e', families: Array.from({ length: MINIMUM_PAIRS }, (_unused, index) => familyOf(index)) };

describe('momonga eval yield live', () => {
  it.skipIf(skipCase('eval-yield-live'))(titleOf('eval-yield-live'), { timeout: 8 * E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const fake = await startUpstream(home, { home, routes: [prefixProbeRoute, calibrationRoute, reflectionRoute, learnRoute, reuseRoute] });
    writeSettingsFile(home, withStructuredModel(baseSettings(home, sandboxChoiceOf({ home }).kind), STRUCTURED_MODEL_ID));
    const dataset = path.join(home.root, 'yield.json');
    fs.writeFileSync(dataset, JSON.stringify(DATASET));
    const reportFile = path.join(home.root, 'yield-report.json');

    const live = await runCli(home, ['eval', 'yield', dataset, '--model', STRUCTURED_MODEL_REF, '--report', reportFile], {
      boundMs: DATASET.families.length * SESSIONS_PER_FAMILY * E2E_RUN_COMPLETED_BOUND_MS,
    });

    expect(live.stderr).toBe('');
    expect(live.stdout).toContain('if accepted by the dataset anchors');
    expect(live.stdout).toContain('model: fake');
    expect(live.stdout).toContain('gate: FAIL');
    expect(live.code).toBe(1);

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as YieldReport;
    expect(report).toMatchObject({ kind: YIELD_REPORT_KIND, acceptance: YIELD_ACCEPTANCE, model: 'fake', models: [STRUCTURED_MODEL_REF] });
    expect(report.gate?.passed).toBe(false);
    expect(report.families).toHaveLength(MINIMUM_PAIRS);
    for (const family of report.families) {
      expect(family.learn).toMatchObject({ status: 'COMPLETED', candidates: 1, accepted: 1, rejected: 0, reflection: { state: 'done', calls: 1 } });
      expect(family.learn.reflection.inputTokens).toBeGreaterThan(0);
      expect(family.nothingAccepted).toBe(false);
      expect(family.recalledAccepted).toBe(1);
      expect(family.reuse.without.passed).toBe(true);
      expect(family.reuse.with.passed).toBe(true);
      expect(family.reuse.with.runId).not.toBe(family.reuse.without.runId);
    }

    const reuseRequests = chatCompletions(fake).filter((request) => asks(request.body, REUSE_TASK));
    expect(reuseRequests).toHaveLength(2 * MINIMUM_PAIRS);
    const recalling = reuseRequests.filter((request) => JSON.stringify(request.body).includes(RECALL_OPEN));
    expect(recalling).toHaveLength(MINIMUM_PAIRS);
    for (const request of recalling) expect(JSON.stringify(request.body)).toContain(NOTE);
    const plain = reuseRequests.filter((request) => !JSON.stringify(request.body).includes(RECALL_OPEN));
    for (const request of plain) expect(JSON.stringify(request.body)).not.toContain(ANCHOR);
    expect(new Set(reuseRequests.map((request) => workspaceOf(request.body))).size).toBe(2 * MINIMUM_PAIRS);
    for (const request of reuseRequests) expect(fs.existsSync(workspaceOf(request.body))).toBe(false);
  });
});
