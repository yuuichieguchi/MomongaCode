import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PromptRequest, RequestError, SessionNotification } from '@agentclientprotocol/sdk';
import { MCP_MODERN_SERVER_PATH, startMcpHttpFixture } from '@momonga/testkit';
import type { FakeScriptedReply } from '@momonga/testkit';
import cliPackage from '../packages/cli/package.json' with { type: 'json' };
import { startAcpClient, updatesOf } from './support/acp.ts';
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { baseSettings, sandboxChoiceOf, startStack, startUpstream, writeSettingsFile } from './support/stack.ts';
import { chatCompletions, hangReply, messagesOf, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const ORIGINAL = 'greeting = "hello"\n';
const EDITED = 'greeting = "hello, momonga"\n';
const FINAL_TEXT = 'Updated the greeting in config.toml.';
const SKILL_BODY_MARKER = 'PDF-SKILL-BODY-MARKER-4f7a';
const CONTEXT_WINDOW = 8192;

type Prepared = { home: E2eHome; project: string; target: string; fake: Awaited<ReturnType<typeof startUpstream>> };

const prepare = async (script: (target: string, project: string) => FakeScriptedReply[]): Promise<Prepared> => {
  const home = await createE2eHome();
  const project = fs.realpathSync.native(home.project);
  const target = path.join(project, 'config.toml');
  fs.writeFileSync(target, ORIGINAL);
  const fake = await startUpstream(home, { home, script: script(target, project) });
  writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
  return { home, project, target, fake };
};

const editTask = (target: string, project: string): FakeScriptedReply[] => [
  toolCallReply('Glob', { pattern: '*.toml', path: project }, 'call_glob'),
  toolCallReply('Read', { file_path: target }, 'call_read'),
  toolCallReply('Edit', { file_path: target, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_edit'),
  textReply(FINAL_TEXT),
];

const textPrompt = (sessionId: string, text: string): PromptRequest => ({ sessionId, prompt: [{ type: 'text', text }] });

const messageTexts = (updates: readonly SessionNotification[], kind: 'agent_message_chunk' | 'user_message_chunk'): string[] =>
  updates.flatMap(({ update }) =>
    (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'user_message_chunk') && update.sessionUpdate === kind && update.content.type === 'text'
      ? [update.content.text]
      : [],
  );

const codeOf = async (call: Promise<unknown>): Promise<number> => {
  try {
    await call;
  } catch (error) {
    return (error as RequestError).code;
  }
  throw new Error('the request was expected to fail');
};

describe('acp: momonga acp', () => {
  it(titleOf('acp-daemon-restart'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, project } = await prepare(() => []);
    const acp = startAcpClient(home);
    await acp.initialize();
    const first = await acp.agent.request('session/new', { cwd: project, mcpServers: [] });
    expect(first.sessionId).not.toBe('');

    const stopped = await runCli(home, ['daemon', 'stop']);
    expect(stopped.stdout).toBe('momonga daemon stopped\n');

    const second = await acp.agent.request('session/new', { cwd: project, mcpServers: [] });
    expect(second.sessionId).not.toBe(first.sessionId);
    const status = await runCli(home, ['daemon', 'status']);
    expect(status.code).toBe(0);
  });

  it(titleOf('acp-edit-task'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, project, target, fake } = await prepare(editTask);
    const acp = startAcpClient(home, { capabilities: { session: { notices: {}, compaction: {} } } });

    const initialized = await acp.initialize();
    expect(initialized).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: 'momonga', version: '0.0.0' },
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, promptCapabilities: { embeddedContext: true } },
    });
    const created = await acp.agent.request('session/new', { cwd: project, mcpServers: [] });
    expect(created.modes?.currentModeId).toBe('default');
    expect(created.modes?.availableModes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan']);
    await acp.agent.request('session/set_mode', { sessionId: created.sessionId, modeId: 'acceptEdits' });

    const result = await acp.agent.request('session/prompt', textPrompt(created.sessionId, 'Update the greeting'));

    expect(result.stopReason).toBe('end_turn');
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
    const calls = updatesOf(acp.updates, 'tool_call');
    expect(calls.map((call) => ('kind' in call ? call.kind : undefined))).toEqual(['search', 'read', 'edit']);
    expect(calls.map((call) => ('status' in call ? call.status : undefined))).toEqual(['pending', 'pending', 'pending']);
    const completed = updatesOf(acp.updates, 'tool_call_update').filter((update) => 'status' in update && update.status === 'completed');
    expect(completed).toHaveLength(3);
    const edit = completed.at(-1);
    expect(edit).toMatchObject({ content: [{ type: 'diff', path: target, oldText: ORIGINAL, newText: EDITED }] });
    expect(messageTexts(acp.updates, 'agent_message_chunk').join('')).toBe(FINAL_TEXT);
    const usage = updatesOf(acp.updates, 'usage_update');
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.at(-1)).toMatchObject({ size: CONTEXT_WINDOW });
    expect(chatCompletions(fake)).toHaveLength(4);
    await acp.untilUpdate((notification) => notification.update.sessionUpdate === 'available_commands_update', 'the available commands update');

    const wireIndexOf = (needle: string): number => acp.wire.findIndex((line) => line.includes(needle));
    expect(wireIndexOf('"availableModes"')).toBeGreaterThanOrEqual(0);
    expect(wireIndexOf('"availableModes"')).toBeLessThan(wireIndexOf('"available_commands_update"'));
    expect(acp.wire.length).toBeGreaterThan(0);
    for (const line of acp.wire) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    expect(await acp.finish()).toEqual({ code: 0, signal: null });
    expect(acp.stderr()).toBe('');
  });

  it(titleOf('acp-permission'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, project, target, fake } = await prepare((file, directory) => [
      toolCallReply('Read', { file_path: file }, 'call_read'),
      toolCallReply('Edit', { file_path: file, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_allowed'),
      textReply('edited'),
      toolCallReply('Edit', { file_path: file, old_string: '"hello, momonga"', new_string: '"goodbye"' }, 'call_rejected'),
      textReply(`rejected in ${directory}`),
    ]);
    const choices = ['allow_once', 'reject_once'];
    const acp = startAcpClient(home, {
      permission: ({ options }) => {
        const choice = choices.shift();
        const option = options.find((candidate) => candidate.kind === choice);
        if (option === undefined) throw new Error(`no ${choice} option among ${JSON.stringify(options)}`);
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      },
    });
    await acp.initialize();
    const { sessionId } = await acp.agent.request('session/new', { cwd: project, mcpServers: [] });

    const first = await acp.agent.request('session/prompt', textPrompt(sessionId, 'Edit once'));

    expect(first.stopReason).toBe('end_turn');
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
    expect(acp.permissionRequests).toHaveLength(1);
    const asked = acp.permissionRequests[0];
    expect(asked?.sessionId).toBe(sessionId);
    expect(asked?.options.map((option) => option.kind).sort()).toEqual(['allow_always', 'allow_once', 'reject_always', 'reject_once']);
    expect(asked?.toolCall).toMatchObject({ kind: 'edit', status: 'pending', rawInput: { file_path: target }, locations: [{ path: target }] });

    const second = await acp.agent.request('session/prompt', textPrompt(sessionId, 'Edit again'));

    expect(second.stopReason).toBe('end_turn');
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
    expect(acp.permissionRequests).toHaveLength(2);
    const failed = updatesOf(acp.updates, 'tool_call_update').filter((update) => 'status' in update && update.status === 'failed');
    expect(failed).toHaveLength(1);
    const lastCall = messagesOf(chatCompletions(fake).at(-1)).at(-1);
    expect(lastCall?.role).toBe('tool');
    expect(lastCall?.content).toBe('The user rejected this tool call.');
    expect(await acp.finish()).toEqual({ code: 0, signal: null });
  });

  it(titleOf('acp-child-permission'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, project, target } = await prepare((file) => [
      toolCallReply('Agent', { description: 'edit', prompt: 'Change the greeting', subagent_type: 'editor' }, 'call_agent'),
      toolCallReply('Read', { file_path: file }, 'call_child_read'),
      toolCallReply('Edit', { file_path: file, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_child_edit'),
      textReply('child edited the greeting'),
      textReply(FINAL_TEXT),
    ]);
    fs.mkdirSync(home.paths.agents, { recursive: true });
    fs.writeFileSync(path.join(home.paths.agents, 'editor.md'), '---\nname: editor\ndescription: edits files\ntools: Read, Edit\n---\nYou edit files.\n');
    const acp = startAcpClient(home, {
      permission: ({ options }) => {
        const option = options.find((candidate) => candidate.kind === 'allow_once');
        if (option === undefined) throw new Error(`no allow_once option among ${JSON.stringify(options)}`);
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      },
    });
    await acp.initialize();
    const { sessionId } = await acp.agent.request('session/new', { cwd: project, mcpServers: [] });

    const prompted = await acp.agent.request('session/prompt', textPrompt(sessionId, 'Change the greeting through the editor'));

    expect(prompted.stopReason).toBe('end_turn');
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
    expect(acp.permissionRequests).toHaveLength(1);
    expect(acp.permissionRequests[0]?.toolCall).toMatchObject({ kind: 'edit', title: `editor: Edit ${target}`, rawInput: { file_path: target } });
    const waiting = updatesOf(acp.updates, 'tool_call_update').filter((update) => JSON.stringify(update).includes('waiting for subagent editor'));
    expect(waiting).toHaveLength(1);
    expect(messageTexts(acp.updates, 'agent_message_chunk').join('')).toBe(FINAL_TEXT);
    expect(await acp.finish()).toEqual({ code: 0, signal: null });
  });

  it(titleOf('acp-cancel'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, project, fake } = await prepare(() => [hangReply('thinking about it')]);
    const acp = startAcpClient(home);
    await acp.initialize();
    const { sessionId } = await acp.agent.request('session/new', { cwd: project, mcpServers: [] });

    const prompt = acp.agent.request('session/prompt', textPrompt(sessionId, 'Take your time'));
    await until(() => chatCompletions(fake).length > 0, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the upstream to receive the request' });
    await acp.agent.notify('session/cancel', { sessionId });

    expect((await prompt).stopReason).toBe('cancelled');
    const next = await codeOf(acp.agent.request('session/prompt', textPrompt('missing-session', 'hello')));
    expect(next).toBe(-32002);
    expect(await acp.finish()).toEqual({ code: 0, signal: null });
  });

  it(titleOf('acp-mode'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, project } = await prepare(() => []);
    const acp = startAcpClient(home);
    await acp.initialize();
    const { sessionId } = await acp.agent.request('session/new', { cwd: project, mcpServers: [] });

    await acp.agent.request('session/set_mode', { sessionId, modeId: 'plan' });
    await acp.untilUpdate((notification) => notification.update.sessionUpdate === 'current_mode_update', 'the announcement of the plan mode');

    const runtime = createRuntimeClient(home);
    try {
      const view = await runtime.json('GET', `/v1/sessions/${sessionId}`);
      expect(view.body).toMatchObject({ session: { id: sessionId, permissionMode: 'plan' } });

      expect((await runtime.json('PATCH', `/v1/sessions/${sessionId}`, { permissionMode: 'acceptEdits' })).status).toBe(200);
      await acp.untilUpdate(
        (notification) => notification.update.sessionUpdate === 'current_mode_update' && notification.update.currentModeId === 'acceptEdits',
        'the announcement of a mode change another client made',
      );
    } finally {
      await runtime.close();
    }
    expect(updatesOf(acp.updates, 'current_mode_update')).toEqual([
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      { sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' },
    ]);
    expect(await codeOf(acp.agent.request('session/set_mode', { sessionId, modeId: 'bypassPermissions' }))).toBe(-32602);
    expect(await codeOf(acp.agent.request('session/set_mode', { sessionId, modeId: 'auto' }))).toBe(-32602);
    expect(await codeOf(acp.agent.request('session/set_mode', { sessionId, modeId: 'nonsense' }))).toBe(-32602);
    expect(await acp.finish()).toEqual({ code: 0, signal: null });
  });

  it(titleOf('acp-load'), { timeout: 2 * E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, project, target, fake } = await prepare((file, directory) => [...editTask(file, directory), textReply('second answer')]);
    const first = startAcpClient(home);
    await first.initialize();
    const { sessionId } = await first.agent.request('session/new', { cwd: project, mcpServers: [] });
    await first.agent.request('session/set_mode', { sessionId, modeId: 'acceptEdits' });
    await first.agent.request('session/prompt', textPrompt(sessionId, 'Update the greeting'));
    expect(await first.finish()).toEqual({ code: 0, signal: null });

    const second = startAcpClient(home);
    await second.initialize();
    expect(await codeOf(second.agent.request('session/load', { sessionId: 'missing-session', cwd: project, mcpServers: [] }))).toBe(-32002);
    expect(await codeOf(second.agent.request('session/load', { sessionId, cwd: home.root, mcpServers: [] }))).toBe(-32602);
    const loaded = await second.agent.request('session/load', { sessionId, cwd: project, mcpServers: [] });

    expect(loaded.modes?.currentModeId).toBe('acceptEdits');
    expect(updatesOf(second.updates, 'current_mode_update')).toEqual([]);
    expect(messageTexts(second.updates, 'user_message_chunk')).toEqual(['Update the greeting']);
    expect(updatesOf(second.updates, 'tool_call').map((call) => ('kind' in call ? call.kind : undefined))).toEqual(['search', 'read', 'edit']);
    expect(updatesOf(second.updates, 'tool_call_update').filter((update) => 'status' in update && update.status === 'completed')).toHaveLength(3);
    expect(messageTexts(second.updates, 'agent_message_chunk').join('')).toBe(FINAL_TEXT);
    expect(second.permissionRequests).toEqual([]);

    const continued = await second.agent.request('session/prompt', textPrompt(sessionId, 'Thank you'));

    expect(continued.stopReason).toBe('end_turn');
    expect(messageTexts(second.updates, 'agent_message_chunk').join('')).toBe(`${FINAL_TEXT}second answer`);
    const request = JSON.stringify(chatCompletions(fake).at(-1)?.body);
    expect(request).toContain('Update the greeting');
    expect(request).toContain('Thank you');
    expect(fs.readFileSync(target, 'utf8')).toBe(EDITED);
    expect(await second.finish()).toEqual({ code: 0, signal: null });
  });

  it(titleOf('acp-mcp'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, project, fake } = await prepare(() => [toolCallReply('mcp__fx__echo', { text: 'hi from the editor server' }, 'call_echo'), textReply('echoed')]);
    const acp = startAcpClient(home, { permission: ({ options }) => ({ outcome: { outcome: 'selected', optionId: options.find((option) => option.kind === 'allow_once')?.optionId ?? '' } }) });
    await acp.initialize();
    expect(await codeOf(acp.agent.request('session/new', { cwd: project, mcpServers: [{ type: 'sse', name: 'legacy', url: 'https://example.invalid/sse', headers: [] }] }))).toBe(-32602);
    const { sessionId } = await acp.agent.request('session/new', {
      cwd: project,
      mcpServers: [{ name: 'fx', command: process.execPath, args: [MCP_MODERN_SERVER_PATH], env: [] }],
    });

    const result = await acp.agent.request('session/prompt', textPrompt(sessionId, 'Echo something'));

    expect(result.stopReason).toBe('end_turn');
    const requests = chatCompletions(fake);
    expect(JSON.stringify(requests[0]?.body)).toContain('mcp__fx__echo');
    const completed = updatesOf(acp.updates, 'tool_call_update').filter((update) => 'status' in update && update.status === 'completed');
    expect(JSON.stringify(completed)).toContain('hi from the editor server');
    expect(await acp.finish()).toEqual({ code: 0, signal: null });
  });

  it(titleOf('acp-elicitation'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const fixture = await startMcpHttpFixture({ era: 'modern' });
    const { home, project, fake } = await prepare(() => [toolCallReply('mcp__remote__mrtr_elicit', {}, 'call_ask'), textReply('done')]);
    const acp = startAcpClient(home, {
      capabilities: { elicitation: { form: {} } },
      permission: ({ options }) => ({ outcome: { outcome: 'selected', optionId: options.find((option) => option.kind === 'allow_once')?.optionId ?? '' } }),
      elicitation: () => ({ action: 'accept', content: { name: 'Ada' } }),
    });
    try {
      await acp.initialize();
      const { sessionId } = await acp.agent.request('session/new', { cwd: project, mcpServers: [{ type: 'http', name: 'remote', url: fixture.url, headers: [] }] });

      const result = await acp.agent.request('session/prompt', textPrompt(sessionId, 'Ask me who I am'));

      expect(result.stopReason).toBe('end_turn');
      expect(acp.elicitationRequests).toHaveLength(1);
      expect(acp.elicitationRequests[0]).toMatchObject({ mode: 'form', sessionId, message: 'Who are you?' });
      const answered = messagesOf(chatCompletions(fake).at(-1)).filter((message) => message.role === 'tool');
      expect(JSON.stringify(answered)).toContain('hello Ada');
      expect(fixture.rpcRecords('tools/call')).toHaveLength(2);
      expect(await acp.finish()).toEqual({ code: 0, signal: null });
    } finally {
      await fixture.close();
    }
  });

  it(titleOf('acp-commands'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const project = fs.realpathSync.native(home.project);
    const skillDirectory = path.join(project, '.agents', 'skills', 'pdf');
    fs.mkdirSync(skillDirectory, { recursive: true });
    fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), `---\nname: pdf\ndescription: Extract PDF text\n---\n# PDF\n\n${SKILL_BODY_MARKER}\n`);
    const stack = await startStack({ home, sandbox: 'none', script: [textReply('Started with the skill.')], version: cliPackage.version });
    const runtime = createRuntimeClient(home);
    try {
      expect((await runtime.json('PUT', '/v1/trust', { path: project, decision: 'trusted' })).status).toBe(200);
    } finally {
      await runtime.close();
    }
    const acp = startAcpClient(home);
    await acp.initialize();
    const { sessionId } = await acp.agent.request('session/new', { cwd: project, mcpServers: [] });

    const announced = await acp.untilUpdate((notification) => notification.update.sessionUpdate === 'available_commands_update', 'the available commands update');
    expect(announced.update).toEqual({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'pdf', description: 'Extract PDF text' }] });
    const result = await acp.agent.request('session/prompt', textPrompt(sessionId, '/pdf Summarize the attached file'));

    expect(result.stopReason).toBe('end_turn');
    const requests = chatCompletions(stack.fake);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.body)).toContain(SKILL_BODY_MARKER);
    expect(await acp.finish()).toEqual({ code: 0, signal: null });
  });
});
