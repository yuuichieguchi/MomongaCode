import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FakeScriptedReply } from '@momonga/testkit';
import { skipCase, titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { UPSTREAM_MODEL_REF, baseSettings, sandboxChoiceOf, startUpstream, upstreamModelRef, withClassifierModel, withStructuredSessionModel, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const CLASSIFIER_ID = 'guard';
const CLASSIFIER_MODEL = upstreamModelRef(CLASSIFIER_ID);

const verdictReply = (verdict: 'safe' | 'unsafe', confidence: 'high' | 'medium' | 'low'): FakeScriptedReply =>
  textReply(JSON.stringify({ verdict, confidence, rationale: `scripted ${verdict}/${confidence}` }));

const withClassifier = (settings: Record<string, unknown>): Record<string, unknown> => withClassifierModel(settings, CLASSIFIER_ID);

const blockingHook = (event: 'PreToolUse' | 'UserPromptSubmit', message: string) => ({
  [event]: [{ ...(event === 'PreToolUse' ? { matcher: 'Write' } : {}), hooks: [{ type: 'command', command: `echo "${message}" >&2; exit 2` }] }],
});

type Scenario = { script: FakeScriptedReply[]; settings?: (base: Record<string, unknown>) => Record<string, unknown> };

const prepare = async (needsBash: boolean, scenario: (home: E2eHome) => Scenario) => {
  const home = await createE2eHome();
  const { script, settings } = scenario(home);
  const fake = await startUpstream(home, { home, script });
  const base = baseSettings(home, sandboxChoiceOf({ home, needsBash }).kind);
  writeSettingsFile(home, settings === undefined ? base : settings(base));
  return { home, fake };
};

describe('momonga -p with hooks and auto mode', () => {
  it.skipIf(skipCase('cli-hook-denial'))(titleOf('cli-hook-denial'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepare(true, (created) => ({
      script: [toolCallReply('Write', { file_path: path.join(created.project, 'frozen.txt'), content: 'written\n' }), textReply('understood')],
      settings: (base) => ({ ...base, hooks: blockingHook('PreToolUse', 'writes are frozen') }),
    }));

    const result = await runCli(home, ['-p', 'Write the file', '--dangerously-skip-permissions']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('momonga: hook PreToolUse blocked (exit 2, decision deny): echo "writes are frozen" >&2; exit 2\n  writes are frozen\n');
    expect(result.stderr).toContain('denied by a hook: writes are frozen');
    expect(fs.existsSync(path.join(home.project, 'frozen.txt'))).toBe(false);
    expect(chatCompletions(fake)).toHaveLength(2);
  });

  it(titleOf('cli-auto-print'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepare(false, (created) => ({
      script: [toolCallReply('Write', { file_path: path.join(created.project, 'allowed.txt'), content: 'written\n' }), verdictReply('safe', 'high'), textReply('written')],
      settings: withClassifier,
    }));
    const target = path.join(home.project, 'allowed.txt');

    const result = await runCli(home, ['-p', 'Write the file', '--permission-mode', 'auto']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`momonga: auto mode allowed Write allowed.txt; classifier ${CLASSIFIER_MODEL} judged Write allowed.txt safe with high confidence: scripted safe/high\n`);
    expect(fs.readFileSync(target, 'utf8')).toBe('written\n');
  });

  it(titleOf('cli-auto-session-model'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepare(false, (created) => ({
      script: [toolCallReply('Write', { file_path: path.join(created.project, 'allowed.txt'), content: 'written\n' }), verdictReply('safe', 'high'), textReply('written')],
      settings: withStructuredSessionModel,
    }));

    const result = await runCli(home, ['-p', 'Write the file', '--permission-mode', 'auto']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`momonga: auto mode allowed Write allowed.txt; classifier ${UPSTREAM_MODEL_REF} judged Write allowed.txt safe with high confidence: scripted safe/high\n`);
    expect(result.stderr).not.toContain('mode_unavailable');
    expect(fs.readFileSync(path.join(home.project, 'allowed.txt'), 'utf8')).toBe('written\n');
    const requests = chatCompletions(fake);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1]?.body)).toContain('<proposed_tool_call>');
  });

  it(titleOf('cli-auto-default-mode-session-model'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepare(false, (created) => ({
      script: [toolCallReply('Write', { file_path: path.join(created.project, 'allowed.txt'), content: 'written\n' }), verdictReply('safe', 'high'), textReply('written')],
      settings: (base) => ({ ...withStructuredSessionModel(base), permissions: { defaultMode: 'auto' } }),
    }));

    const result = await runCli(home, ['-p', 'Write the file']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`momonga: auto mode allowed Write allowed.txt; classifier ${UPSTREAM_MODEL_REF} judged Write allowed.txt safe with high confidence: scripted safe/high\n`);
    expect(fs.readFileSync(path.join(home.project, 'allowed.txt'), 'utf8')).toBe('written\n');
    expect(chatCompletions(fake)).toHaveLength(3);
  });

  it.skipIf(skipCase('cli-user-prompt-blocked'))(titleOf('cli-user-prompt-blocked'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepare(true, () => ({
      script: [textReply('never reached')],
      settings: (base) => ({ ...base, hooks: blockingHook('UserPromptSubmit', 'no prompts today') }),
    }));

    const result = await runCli(home, ['-p', 'Say hello']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('momonga: hook UserPromptSubmit blocked (exit 2');
    expect(result.stderr).toContain('(a UserPromptSubmit hook blocked the prompt: no prompts today)');
    expect(chatCompletions(fake)).toHaveLength(0);
  });
});
