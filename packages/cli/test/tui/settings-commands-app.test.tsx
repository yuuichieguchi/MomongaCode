import fs from 'node:fs';
import { INIT_INSTRUCTION } from '@momonga/runtime';
import { PERMISSION_MODES, PERMISSION_MODE_DESCRIPTIONS } from '@momonga/protocol';
import type { McpServerView } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SLASH_COMMANDS } from '../../src/tui/commands/index.ts';
import { HOOKS_TITLE, HOOK_COMMAND_TITLE, HOOK_EVENT_TITLE, HOOK_MATCHER_TITLE, HOOK_TIMEOUT_TITLE } from '../../src/tui/commands/hooks.ts';
import { ADD_HTTP_ROW, ADD_STDIO_ROW, MCP_ADDRESS_TITLE, MCP_ARGUMENTS_TITLE, MCP_COMMAND_TITLE, MCP_ENVIRONMENT_TITLE, MCP_NAME_TITLE, MCP_TITLE, sessionServerNote } from '../../src/tui/commands/mcp.ts';
import { PERMISSIONS_TITLE, PROTECTED_HEADING, PROTECTED_LINES, TRUST_ROW, TRUST_TITLE } from '../../src/tui/commands/permissions.ts';
import { APPLIES_NEXT_SESSION, APPLIES_NOW, SAVE_TO_TITLE } from '../../src/tui/settings-screen.tsx';
import { FAKE_INIT_INSTRUCTION, runView } from '../fake-backend.ts';
import { KEYS, untilFrame, untilOutput } from '../ink-helpers.ts';
import { command, freshPlace, localFileOf, press, startAt, stored, typeInto, writeSettings } from './settings-harness.tsx';
import type { Started } from './settings-harness.tsx';

const TASK_RUNNING = 'A task is running. Esc stops it.';

const toUser = async (started: Started, shown: string): Promise<string> => {
  const target = await untilFrame(started.app, SAVE_TO_TITLE);
  expect(target).toContain('› 1. user');
  expect(target).toContain('2. project');
  expect(target).toContain('3. local');
  return press(started, KEYS.enter, shown);
};

const openRun = async (started: Started): Promise<void> => {
  await press(started, 'go', '> go');
  started.app.stdin.write(KEYS.enter);
  await started.backend.called('openSession');
  await untilOutput(started.app, '> go');
};

describe('the commands of the settings', () => {
  it.each(['config', 'permissions', 'hooks', 'mcp', 'init'])('/%s is in the command registry', (name) => {
    expect(DEFAULT_SLASH_COMMANDS.map((listed) => listed.name)).toContain(name);
  });
});

describe('/permissions', () => {
  it('shows the folder trust as read from the runtime and changes it through the trust port', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    const frame = await command(started, '/permissions', PERMISSIONS_TITLE);
    expect(frame).toContain(`6. ${TRUST_ROW}  trusted`);
    await press(started, '6', `› 6. ${TRUST_ROW}`);
    started.app.stdin.write(KEYS.enter);
    const choices = await untilFrame(started.app, TRUST_TITLE);
    expect(choices).toContain('1. Trust this folder');
    expect(choices).toContain('2. Do not trust this folder');
    expect(choices).toContain('3. Clear the decision: the next start asks again');
    await press(started, '2', '› 2. Do not trust this folder');
    started.app.stdin.write(KEYS.enter);
    await started.backend.called('trust:untrusted');
    const after = await untilFrame(started.app, `${TRUST_ROW}: untrusted  ${APPLIES_NEXT_SESSION}`);
    expect(after).toContain(`6. ${TRUST_ROW}  untrusted`);
    await press(started, '6', `› 6. ${TRUST_ROW}`);
    started.app.stdin.write(KEYS.enter);
    await untilFrame(started.app, TRUST_TITLE);
    await press(started, '3', '› 3. Clear the decision');
    started.app.stdin.write(KEYS.enter);
    await started.backend.called('trust:clear');
    expect(await untilFrame(started.app, `6. ${TRUST_ROW}  not decided`)).toContain(PERMISSIONS_TITLE);
    started.app.unmount();
  });

  it('shows the start mode, the three kinds of rules with their counts, the directories and the block that cannot be edited', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(./secrets/**)'] } });
    writeSettings(place.projectFile, { permissions: { allow: ['Bash(npm run lint)'] } });
    const started = await startAt(place);
    const frame = await command(started, '/permissions', PERMISSIONS_TITLE);
    expect(frame).toContain('› 1. Start mode  manual  default');
    expect(frame).toContain('2. Allow rules  2');
    expect(frame).toContain('3. Ask rules  0');
    expect(frame).toContain('4. Deny rules  1');
    expect(frame).toContain('5. Additional directories  0');
    expect(frame).toContain(PROTECTED_HEADING);
    expect(PROTECTED_LINES).toEqual([
      'in the workspace: .momonga, .mcp.json, .envrc, .vscode, .idea',
      'in a Git directory: hooks, config, config.worktree, commondir',
      'a change to these is asked of a person in every mode',
      'adding a standing rule is asked of a person in every mode',
    ]);
    for (const line of PROTECTED_LINES) expect(frame).toContain(line);
    expect(frame).not.toMatch(/\d\. in the workspace/);
    started.app.unmount();
  });

  it('sets the start mode from the five modes with what each does, in the file chosen', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await command(started, '/permissions', PERMISSIONS_TITLE);
    const modes = await press(started, KEYS.enter, '5. bypassPermissions');
    PERMISSION_MODES.forEach((mode, index) => expect(modes).toContain(`${index + 1}. ${mode}  ${PERMISSION_MODE_DESCRIPTIONS[mode]}`));
    await press(started, '2', '› 2. acceptEdits');
    started.app.stdin.write(KEYS.enter);
    const after = await toUser(started, `Start mode: acceptEdits  ${APPLIES_NEXT_SESSION}`);
    expect(after).toContain('1. Start mode  acceptEdits  user');
    expect(stored(place.userFile)).toEqual({ permissions: { defaultMode: 'acceptEdits' } });
    started.app.unmount();
  });

  it('refuses a start mode the project file may not set with the sentence of the loader', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await command(started, '/permissions', PERMISSIONS_TITLE);
    await press(started, KEYS.enter, '5. bypassPermissions');
    await press(started, '5', '› 5. bypassPermissions');
    await press(started, KEYS.enter, SAVE_TO_TITLE);
    await press(started, '2', '› 2. project');
    await press(started, KEYS.enter, 'permissions.defaultMode bypassPermissions is only honored in user settings and on the command line; discarded');
    expect(fs.existsSync(place.projectFile)).toBe(false);
    started.app.unmount();
  });

  it('offers the user file and the local file for a project that is not trusted, never the project file', async () => {
    const place = freshPlace();
    const started = await startAt(place, { trust: { path: place.project, decision: 'untrusted' } });
    await command(started, '/permissions', PERMISSIONS_TITLE);
    await press(started, KEYS.enter, '5. bypassPermissions');
    await press(started, '3', '› 3. plan');
    const target = await press(started, KEYS.enter, SAVE_TO_TITLE);
    expect(target).toContain('› 1. user');
    expect(target).toContain('2. local');
    expect(target).not.toContain('project');
    await press(started, KEYS.enter, `Start mode: plan  ${APPLIES_NEXT_SESSION}`);
    expect(stored(place.userFile)).toEqual({ permissions: { defaultMode: 'plan' } });
    started.app.unmount();
  });

  it('lists the rules of a kind with the file each comes from, adds one checked by the rule parser, and removes one', async () => {
    const place = freshPlace();
    writeSettings(place.projectFile, { permissions: { allow: ['Bash(npm run lint)'] } });
    const started = await startAt(place);
    await command(started, '/permissions', PERMISSIONS_TITLE);
    await press(started, '2', '› 2. Allow rules');
    const list = await press(started, KEYS.enter, '1. Bash(npm run lint)  project');
    expect(list).toContain('2. Add');
    expect(list).toContain('delete: delete');
    expect(list).not.toContain('tab');
    await press(started, '2', '› 2. Add');
    const prompt = await press(started, KEYS.enter, 'Allowed: Bash(npm test:*)');
    expect(prompt).toContain('enter to confirm');
    await press(started, 'Bash(', '> Bash(');
    await press(started, KEYS.enter, 'invalid permission rule "Bash(": missing closing parenthesis');
    expect(fs.existsSync(place.userFile)).toBe(false);
    await press(started, 'npm test:*)', '> Bash(npm test:*)');
    started.app.stdin.write(KEYS.enter);
    const added = await toUser(started, '1. Bash(npm test:*)  user');
    expect(added).toContain('2. Bash(npm run lint)  project');
    expect(added).toContain(APPLIES_NOW);
    await untilOutput(started.app, 'Allowed: Bash(npm test:*)');
    expect(stored(place.userFile)).toEqual({ permissions: { allow: ['Bash(npm test:*)'] } });
    await press(started, '2', '› 2. Bash(npm run lint)  project');
    await press(started, KEYS.tab, '› 2. Bash(npm run lint)  project');
    const asked = await press(started, KEYS.delete, `Remove Bash(npm run lint) from ${place.projectFile}?`);
    expect(asked).toContain('› 1. No');
    await press(started, '2', '› 2. Yes');
    await press(started, KEYS.enter, (frame) => frame.includes('2. Add') && frame.includes(APPLIES_NOW));
    expect(stored(place.projectFile)).toEqual({});
    started.app.unmount();
  });

  it('enter on a deny rule opens its action list and removes nothing; delete asks first, and No leaves the rule', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { permissions: { deny: ['Read(./secrets/**)'] } });
    const started = await startAt(place);
    await command(started, '/permissions', PERMISSIONS_TITLE);
    await press(started, '4', '› 4. Deny rules');
    await press(started, KEYS.enter, '› 1. Read(./secrets/**)  user');
    const actions = await press(started, KEYS.enter, '› 1. Remove');
    expect(actions).toContain('Read(./secrets/**)  user');
    expect(stored(place.userFile)).toEqual({ permissions: { deny: ['Read(./secrets/**)'] } });
    await press(started, KEYS.escape, '2. Add');
    await press(started, KEYS.delete, `Remove Read(./secrets/**) from ${place.userFile}?`);
    await press(started, KEYS.enter, '2. Add');
    expect(stored(place.userFile)).toEqual({ permissions: { deny: ['Read(./secrets/**)'] } });
    await press(started, KEYS.enter, '› 1. Remove');
    await press(started, KEYS.enter, `Remove Read(./secrets/**) from ${place.userFile}?`);
    await press(started, '2', '› 2. Yes');
    await press(started, KEYS.enter, (frame) => frame.includes('1. Add') && frame.includes(APPLIES_NOW));
    expect(stored(place.userFile)).toEqual({});
    started.app.unmount();
  });

  it('an additional directory is removed only after the question is answered Yes', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { permissions: { additionalDirectories: [place.home] } });
    const started = await startAt(place);
    await command(started, '/permissions', PERMISSIONS_TITLE);
    await press(started, '5', '› 5. Additional directories');
    await press(started, KEYS.enter, `› 1. ${place.home}  user`);
    await press(started, KEYS.enter, '› 1. Remove');
    expect(stored(place.userFile)).toEqual({ permissions: { additionalDirectories: [place.home] } });
    await press(started, KEYS.escape, '2. Add');
    await press(started, KEYS.delete, `Remove ${place.home} from ${place.userFile}?`);
    await press(started, KEYS.escape, '2. Add');
    expect(stored(place.userFile)).toEqual({ permissions: { additionalDirectories: [place.home] } });
    await press(started, KEYS.delete, `Remove ${place.home} from ${place.userFile}?`);
    await press(started, '2', '› 2. Yes');
    await press(started, KEYS.enter, (frame) => frame.includes('1. Add') && frame.includes(APPLIES_NOW));
    expect(stored(place.userFile)).toEqual({});
    started.app.unmount();
  });

  it('adds a rule of the local file through the rule writer and an additional directory', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await command(started, '/permissions', PERMISSIONS_TITLE);
    await press(started, '4', '› 4. Deny rules');
    await press(started, KEYS.enter, '1. Add');
    await press(started, KEYS.enter, 'Denied: Bash(npm test:*)');
    await press(started, 'Bash(rm -rf:*)', '> Bash(rm -rf:*)');
    await press(started, KEYS.enter, SAVE_TO_TITLE);
    await press(started, '3', '› 3. local');
    await press(started, KEYS.enter, '1. Bash(rm -rf:*)  local');
    expect(stored(localFileOf(place))).toEqual({ permissions: { deny: ['Bash(rm -rf:*)'] } });
    await press(started, KEYS.escape, PERMISSIONS_TITLE);
    await press(started, '5', '› 5. Additional directories');
    await press(started, KEYS.enter, '1. Add');
    await press(started, KEYS.enter, 'enter to confirm');
    await press(started, place.home, place.home);
    started.app.stdin.write(KEYS.enter);
    await toUser(started, `1. ${place.home}  user`);
    expect(stored(place.userFile)).toEqual({ permissions: { additionalDirectories: [place.home] } });
    started.app.unmount();
  });
});

describe('/hooks', () => {
  it('lists the hooks by event with matcher, command and file, and adds and edits one', async () => {
    const place = freshPlace();
    writeSettings(place.projectFile, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done', timeout: 5 }] }] } });
    const started = await startAt(place);
    const list = await command(started, '/hooks', HOOKS_TITLE);
    expect(list).toContain('› 1. Stop  *  say done  timeout 5  project');
    expect(list).toContain('2. Add');
    await press(started, '2', '› 2. Add');
    const events = await press(started, KEYS.enter, HOOK_EVENT_TITLE);
    for (const event of ['1. PreToolUse', '2. PostToolUse', '3. UserPromptSubmit', '4. Stop', '5. SessionStart']) expect(events).toContain(event);
    await press(started, KEYS.enter, HOOK_MATCHER_TITLE);
    await press(started, 'Bash(', '> Bash(');
    await press(started, KEYS.enter, (frame) => frame.includes(HOOK_MATCHER_TITLE) && frame.split('\n').some((line, index, lines) => line.includes('> Bash(') && (lines[index + 1] ?? '').trim() !== '' && !(lines[index + 1] ?? '').includes('enter to confirm')));
    await press(started, `${KEYS.backspace}`, '> Bash');
    await press(started, KEYS.enter, HOOK_COMMAND_TITLE);
    await typeInto(started, 'echo checked', HOOK_TIMEOUT_TITLE);
    await press(started, '0', '> 0');
    await press(started, KEYS.enter, 'expected a whole number from 1');
    await press(started, `${KEYS.backspace}30`, '> 30');
    started.app.stdin.write(KEYS.enter);
    await toUser(started, 'PreToolUse  Bash  echo checked  timeout 30  user');
    expect(stored(place.userFile)).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked', timeout: 30 }] }] } });
    const shown = await untilFrame(started.app, APPLIES_NOW);
    const row = /(\d)\. PreToolUse {2}Bash/.exec(shown)?.[1] ?? '';
    await press(started, row, `› ${row}. PreToolUse`);
    const actions = await press(started, KEYS.enter, '1. Edit');
    expect(actions).toContain('2. Remove');
    await press(started, KEYS.enter, HOOK_MATCHER_TITLE);
    await press(started, KEYS.enter, HOOK_COMMAND_TITLE);
    await press(started, ' twice', '> echo checked twice');
    await press(started, KEYS.enter, HOOK_TIMEOUT_TITLE);
    await press(started, KEYS.enter, 'PreToolUse  Bash  echo checked twice  timeout 30  user');
    expect(stored(place.userFile)).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked twice', timeout: 30 }] }] } });
    started.app.unmount();
  });

  it('removes a hook only after the question is answered Yes', async () => {
    const place = freshPlace();
    writeSettings(place.projectFile, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done', timeout: 5 }] }] } });
    const started = await startAt(place);
    await command(started, '/hooks', HOOKS_TITLE);
    await press(started, KEYS.delete, (frame) => frame.includes('Remove') && frame.includes('say done') && frame.includes('› 1. No'));
    await press(started, '2', '› 2. Yes');
    await press(started, KEYS.enter, (frame) => frame.includes(HOOKS_TITLE) && !frame.includes('say done'));
    expect(stored(place.projectFile)).toEqual({});
    started.app.unmount();
  });

  it('asks no matcher for an event that has none', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await command(started, '/hooks', HOOKS_TITLE);
    await press(started, KEYS.enter, HOOK_EVENT_TITLE);
    await press(started, '4', '› 4. Stop');
    await press(started, KEYS.enter, HOOK_COMMAND_TITLE);
    await typeInto(started, 'say done', HOOK_TIMEOUT_TITLE);
    started.app.stdin.write(KEYS.enter);
    await toUser(started, 'Stop  *  say done  user');
    expect(stored(place.userFile)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    started.app.unmount();
  });
});

const TRACKER_DIGEST = 'a'.repeat(64);

const OTHER_APPROVAL = { name: 'other', digest: 'b'.repeat(64) };

const SERVERS: readonly McpServerView[] = [
  { name: 'files', scope: 'user', transport: 'stdio', auth: 'not_required' },
  { name: 'tracker', scope: 'project', transport: 'http', url: 'https://tracker.example/mcp', auth: 'required', approval: { digest: TRACKER_DIGEST, changed: false } },
  { name: 'scratch', scope: 'session', transport: 'stdio', auth: 'not_required' },
];

describe('/mcp', () => {
  it('lists the servers with scope, transport and status, and the two rows that add one', async () => {
    const started = await startAt(freshPlace(), { mcpServers: SERVERS });
    const frame = await command(started, '/mcp', ADD_HTTP_ROW);
    expect(frame).toContain('› 1. files  user  stdio  not_required');
    expect(frame).toContain('2. tracker  project  http  required  https://tracker.example/mcp');
    expect(frame).toContain('3. scratch  session  stdio  not_required');
    expect(frame).toContain(`4. ${ADD_STDIO_ROW}`);
    expect(frame).toContain(`5. ${ADD_HTTP_ROW}`);
    started.app.unmount();
  });

  it('adds a stdio server with its command, arguments and environment names to the user file', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await command(started, '/mcp', ADD_HTTP_ROW);
    await press(started, KEYS.enter, MCP_NAME_TITLE);
    await typeInto(started, 'files', MCP_COMMAND_TITLE);
    await typeInto(started, 'npx', MCP_ARGUMENTS_TITLE);
    await typeInto(started, '-y files-server', MCP_ENVIRONMENT_TITLE);
    await typeInto(started, 'FILES_ROOT', APPLIES_NEXT_SESSION);
    expect(stored(place.userFile)).toEqual({ mcpServers: { files: { type: 'stdio', command: 'npx', args: ['-y', 'files-server'], env: { FILES_ROOT: '${FILES_ROOT}' } } } });
    started.app.unmount();
  });

  it('adds an http server, and refuses a name the loader of the MCP servers refuses with its sentence', async () => {
    const place = freshPlace();
    const started = await startAt(place);
    await command(started, '/mcp', ADD_HTTP_ROW);
    await press(started, '2', `› 2. ${ADD_HTTP_ROW}`);
    await press(started, KEYS.enter, MCP_NAME_TITLE);
    await typeInto(started, 'tracker', MCP_ADDRESS_TITLE);
    await typeInto(started, 'https://tracker.example/mcp', APPLIES_NEXT_SESSION);
    expect(stored(place.userFile)).toEqual({ mcpServers: { tracker: { type: 'http', url: 'https://tracker.example/mcp' } } });
    await press(started, KEYS.enter, MCP_NAME_TITLE);
    await typeInto(started, 'bad name', 'invalid MCP server name "bad name"; use letters, digits, "-" and single "_" only');
    expect(stored(place.userFile)).toEqual({ mcpServers: { tracker: { type: 'http', url: 'https://tracker.example/mcp' } } });
    started.app.unmount();
  });

  it('removes a server of the user file after asking, enables and disables a server of the project, and says a session server is in no file', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { mcpServers: { files: { command: 'npx' } }, enabledMcpjsonServers: [OTHER_APPROVAL, 'tracker'], disabledMcpjsonServers: ['tracker'] });
    const started = await startAt(place, { mcpServers: SERVERS });
    await command(started, '/mcp', ADD_HTTP_ROW);
    await press(started, '2', '› 2. tracker');
    const actions = await press(started, KEYS.enter, '1. Enable');
    expect(actions).toContain('2. Disable');
    await press(started, KEYS.enter, APPLIES_NEXT_SESSION);
    expect(stored(place.userFile)).toEqual({ mcpServers: { files: { command: 'npx' } }, enabledMcpjsonServers: [OTHER_APPROVAL, { name: 'tracker', digest: TRACKER_DIGEST }] });
    await press(started, KEYS.enter, '2. Disable');
    await press(started, '2', '› 2. Disable');
    await press(started, KEYS.enter, ADD_HTTP_ROW);
    expect(stored(place.userFile)).toEqual({ mcpServers: { files: { command: 'npx' } }, enabledMcpjsonServers: [OTHER_APPROVAL], disabledMcpjsonServers: ['tracker'] });
    await press(started, '3', '› 3. scratch');
    await press(started, KEYS.enter, (frame) => frame.includes(sessionServerNote('scratch')) && frame.includes(ADD_HTTP_ROW));
    await press(started, '1', '› 1. files');
    await press(started, KEYS.enter, 'Remove files?');
    await press(started, '2', '› 2. Yes');
    await press(started, KEYS.enter, ADD_HTTP_ROW);
    expect(stored(place.userFile)).toEqual({ enabledMcpjsonServers: [OTHER_APPROVAL], disabledMcpjsonServers: ['tracker'] });
    started.app.unmount();
  });
});

describe('/init', () => {
  it('starts a run whose first message is the built-in instruction', async () => {
    const started = await startAt(freshPlace());
    started.app.stdin.write('/init');
    await untilFrame(started.app, '> /init');
    started.app.stdin.write(KEYS.enter);
    await started.backend.called('openSession');
    await untilOutput(started.app, FAKE_INIT_INSTRUCTION);
    expect(started.backend.started.map((run) => run.text)).toEqual([FAKE_INIT_INSTRUCTION]);
    started.backend.finish(runView());
    started.app.unmount();
  });

  it('is refused while a run is open', async () => {
    const started = await startAt(freshPlace());
    await openRun(started);
    await command(started, '/init', TASK_RUNNING);
    expect(started.backend.started.map((run) => run.text)).toEqual(['go']);
    started.backend.finish(runView());
    started.app.unmount();
  });

  it('instructs to read the repository and to create AGENTS.md or improve it without losing what it says', () => {
    expect(INIT_INSTRUCTION).toContain('its layout, how it is built and tested, and the conventions');
    expect(INIT_INSTRUCTION).toContain('write AGENTS.md at the project root');
    expect(INIT_INSTRUCTION).toContain('When AGENTS.md already exists, improve it without losing anything it says');
  });
});
