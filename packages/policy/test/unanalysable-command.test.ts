import { describe, expect, it } from 'vitest';
import { decide } from '@momonga/policy';
import type { Decision, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn } from './helpers.ts';

const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

type Spec = { allow?: string[]; ask?: string[]; deny?: string[]; governingAsk?: string[]; mode?: PermissionMode; mandate?: true };

const bash = async (command: string, spec: Spec = {}): Promise<Decision> => {
  const layout = makeLayout();
  const make = ruleIn(layout);
  const rules = [
    ...(spec.allow ?? []).map((text) => make('allow', text)),
    ...(spec.ask ?? []).map((text) => make('ask', text)),
    ...(spec.governingAsk ?? []).map((text) => ({ ...make('ask', text), layer: 'governance' as const })),
    ...(spec.deny ?? []).map((text) => make('deny', text)),
  ];
  return decide({
    tool: BASH,
    subject: { kind: 'command', tool: 'Bash', command },
    mode: spec.mode ?? 'manual',
    rules,
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: isWritableFor([layout.project]),
    protectedSet: EMPTY_PROTECTED_SET,
    fileRules: await fileRulesFor(rules, [layout.project]),
    ...(spec.mandate === undefined ? {} : { mandate: spec.mandate }),
  });
};

const DENY = ['Bash(git push --force:*)'];

const UNANALYSED = [
  ['cat <<EOF\nx\nEOF', 'here-document'],
  ['echo $((1+1))', 'arithmetic expansion'],
  ["python3 -c 'x'", "python3 -c 'x'"],
  ['cat 設計.md', 'non-ASCII character'],
] as const;

describe('a command that cannot be analysed while a Bash deny rule exists', () => {
  it.each(UNANALYSED)('%s is a decision for a person, told the part and that a deny rule exists, with no rule named', async (command, part) => {
    const decision = await bash(command, { deny: DENY });

    expect(decision).toMatchObject({ kind: 'ask', humanOnly: true });
    expect(decision.reason).toContain(`could not be analysed (${part})`);
    expect(decision.reason).toContain('a deny rule for Bash exists');
    expect(decision.reason).not.toContain('git push');
    expect(decision.rule).toBeUndefined();
  });

  it.each(UNANALYSED)('%s is approved by no allow rule', async (command) => {
    const decision = await bash(command, { deny: DENY, allow: ['Bash(cat:*)', 'Bash(echo:*)', 'Bash(python3:*)'] });

    expect(decision).toMatchObject({ kind: 'ask', humanOnly: true });
  });

  it.each(UNANALYSED)('%s is approved by no mode default', async (command) => {
    const decision = await bash(command, { deny: DENY, mode: 'acceptEdits' });

    expect(decision).toMatchObject({ kind: 'ask', humanOnly: true });
  });

  it.each(UNANALYSED)('%s is denied with the same reason where nobody is asked (bypassPermissions)', async (command, part) => {
    const decision = await bash(command, { deny: DENY, mode: 'bypassPermissions', allow: ['Bash(cat:*)'] });

    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain(`could not be analysed (${part})`);
    expect(decision.reason).toContain('a deny rule for Bash exists');
    expect(decision.reason).not.toContain('git push');
    expect(decision.rule).toBeUndefined();
  });

  it('stays a decision for a person under a mandate, so the run is held and not refused as outside the mandate', async () => {
    const decision = await bash('cat <<EOF\nx\nEOF', { deny: DENY, mandate: true });

    expect(decision).toMatchObject({ kind: 'ask', humanOnly: true });
    expect(decision).not.toHaveProperty('denial');
  });

  it('is still denied by the rule whose words stand in command position', async () => {
    const decision = await bash('git push --force origin $(cat <<EOF\nx\nEOF\n)', { deny: ['Bash(git push --force:*)'] });
    const wrapped = await bash('sudo --no-such-option rm -rf x', { deny: ['Bash(sudo:*)'] });

    expect(wrapped).toMatchObject({ kind: 'deny', source: 'rule' });
    expect(wrapped.rule?.text).toBe('Bash(sudo:*)');
    expect(decision.kind).not.toBe('allow');
  });

  it('is denied by a deny rule without a specifier', async () => {
    expect(await bash('cat <<EOF\nx\nEOF', { deny: ['Bash'] })).toMatchObject({ kind: 'deny', source: 'rule' });
  });
});

describe('a command that cannot be analysed with no Bash deny rule', () => {
  it.each(UNANALYSED)('%s gets the ask of the mode, which a person or the classifier can answer', async (command) => {
    const decision = await bash(command);

    expect(decision.kind).toBe('ask');
    expect(decision.humanOnly).toBeUndefined();
    expect(decision.reason).not.toContain('deny rule');
  });

  it('matches no ask rule by name: an ask rule makes it an ask that names the part, and no allow rule approves it', async () => {
    const decision = await bash('cat <<EOF\nx\nEOF', { ask: ['Bash(npm publish:*)'], allow: ['Bash(cat:*)'] });

    expect(decision.kind).toBe('ask');
    expect(decision.rule).toBeUndefined();
    expect(decision.reason).toContain('could not be analysed (here-document)');
    expect(decision.reason).toContain('an ask rule for Bash exists');
    expect(decision.reason).not.toContain('npm publish');
  });

  it('is a decision for a person in every mode while a governing ask rule exists', async () => {
    const decision = await bash('cat <<EOF\nx\nEOF', { governingAsk: ['Bash(npm publish:*)'], mode: 'bypassPermissions' });

    expect(decision).toMatchObject({ kind: 'ask', humanOnly: true });
    expect(decision.reason).not.toContain('npm publish');
  });
});
