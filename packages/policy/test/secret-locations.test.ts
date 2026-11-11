import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET, standardSecretLocations } from '@momonga/foundation';
import { decide } from '@momonga/policy';
import type { Decision, PermissionSubject, PolicyTool } from '@momonga/policy';
import { PERMISSION_MODES } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn } from './helpers.ts';
import type { Layout } from './helpers.ts';

const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const GREP: PolicyTool = { name: 'Grep', kind: 'search', sideEffect: 'read_only' };
const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };
const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

type Rules = { allow?: string[]; ask?: string[] };

type Extra = { roots?: (layout: Layout) => string[]; readRoots?: (layout: Layout) => string[] };

const decideIn = async (layout: Layout, tool: PolicyTool, subject: PermissionSubject, mode: PermissionMode, rules: Rules = {}, extra: Extra = {}): Promise<Decision> => {
  const make = ruleIn(layout);
  const parsed = [...(rules.allow ?? []).map((text) => make('allow', text)), ...(rules.ask ?? []).map((text) => make('ask', text))];
  const roots = extra.roots === undefined ? [layout.project] : extra.roots(layout);
  return decide({
    tool,
    subject,
    mode,
    rules: parsed,
    roots,
    home: layout.home,
    cwd: layout.project,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: isWritableFor(roots),
    protectedSet: EMPTY_PROTECTED_SET,
    fileRules: await fileRulesFor(parsed, roots),
    ...(extra.readRoots === undefined ? {} : { readRoots: extra.readRoots(layout) }),
  });
};

const reading = (file: string, tool = 'Read'): PermissionSubject => ({ kind: 'path', tool, paths: [file], access: 'read' });
const writing = (file: string): PermissionSubject => ({ kind: 'path', tool: 'Write', paths: [file], access: 'write' });

describe('the secret locations', () => {
  it.each(PERMISSION_MODES)('are read-denied in %s mode, with a message that names the location', async (mode) => {
    const layout = makeLayout();
    const key = path.join(layout.home, '.ssh', 'id_rsa');
    const decision = await decideIn(layout, READ, reading(key), mode);

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toBe(`reading ${key} is denied in every permission mode: it is inside ~/.ssh, a secret location`);
    expect((await decideIn(layout, GREP, reading(key, 'Grep'), mode)).kind).toBe('deny');
  });

  it.each(PERMISSION_MODES.filter((mode) => mode !== 'plan'))('are write-denied in %s mode', async (mode) => {
    const layout = makeLayout();
    const file = path.join(layout.home, '.ssh', 'authorized_keys');
    const decision = await decideIn(layout, WRITE, writing(file), mode);

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toBe(`writing to ${file} is denied in every permission mode: it is inside ~/.ssh, a secret location`);
  });

  it.each(PERMISSION_MODES)('are denied in %s mode when the workspace contains them', async (mode) => {
    const layout = makeLayout();
    const decision = await decideIn(layout, READ, reading(path.join(layout.home, '.aws', 'credentials')), mode, {}, { roots: (given) => [given.home] });

    expect(decision.kind).toBe('deny');
  });

  it('are every entry of the one shared list, files and folders alike', async () => {
    const layout = makeLayout();
    const kinds: string[] = [];
    for (const location of standardSecretLocations(layout.home)) {
      kinds.push((await decideIn(layout, READ, reading(location.directory), 'bypassPermissions')).kind);
      kinds.push((await decideIn(layout, READ, reading(path.join(location.directory, 'inner')), 'bypassPermissions')).kind);
    }

    expect(standardSecretLocations(layout.home).map((location) => location.label)).toEqual(expect.arrayContaining(['~/.ssh', '~/.npmrc', 'the Momonga home folder (gateway key, settings, sockets)', 'the platform key store']));
    expect(new Set(kinds)).toEqual(new Set(['deny']));
  });

  it.each(['bypassPermissions', 'manual'] as const)('deny a shell command that reads one, in %s mode', async (mode) => {
    const layout = makeLayout();
    const decision = await decideIn(layout, BASH, { kind: 'command', tool: 'Bash', command: `cat ${path.join(layout.home, '.ssh', 'id_rsa')}` }, mode);

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain('it is inside ~/.ssh, a secret location');
  });

  it('leave a path beside them to the mode', async () => {
    const layout = makeLayout();

    expect((await decideIn(layout, READ, reading(path.join(layout.home, '.sshx', 'id_rsa')), 'bypassPermissions')).kind).toBe('allow');
    expect((await decideIn(layout, READ, reading(path.join(layout.home, 'notes.txt')), 'manual')).kind).toBe('ask');
  });

  it('stay readable where the product makes a folder inside one readable by default (an agent skill directory)', async () => {
    const layout = makeLayout();
    const skills = path.join(layout.home, '.momonga', 'skills');
    const readRoots = (): string[] => [skills];

    expect(await decideIn(layout, READ, reading(path.join(skills, 'a', 'SKILL.md')), 'manual', {}, { readRoots })).toMatchObject({ kind: 'allow' });
    expect((await decideIn(layout, WRITE, writing(path.join(skills, 'a', 'SKILL.md')), 'acceptEdits', {}, { readRoots })).kind).toBe('deny');
    expect((await decideIn(layout, READ, reading(path.join(layout.home, '.momonga', 'state', 'gateway.key')), 'manual', {}, { readRoots })).kind).toBe('deny');
  });

  it('are decided by a written rule before the denial: an ask rule asks, and an allow rule allows (the verifier refuses a run with such a rule)', async () => {
    const layout = makeLayout();
    const key = path.join(layout.home, '.ssh', 'id_rsa');

    expect(await decideIn(layout, READ, reading(key), 'manual', { ask: ['Read(~/.ssh/**)'] })).toMatchObject({ kind: 'ask', source: 'rule' });
    expect(await decideIn(layout, READ, reading(key), 'manual', { allow: ['Read(~/.ssh/**)'] })).toMatchObject({ kind: 'allow', source: 'rule' });
  });
});
