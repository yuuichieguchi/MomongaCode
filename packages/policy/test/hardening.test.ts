import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFileRules, decide, matchRule } from '@momonga/policy';
import type { PermissionRule, PermissionSubject, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { EMPTY_PROTECTED_SET, ruleEnforcementOf } from '@momonga/foundation';
import { commandRow, kindIn } from './decision-rows.ts';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn, touch } from './helpers.ts';
import { testProbes, testSecretLocations } from '@momonga/testkit';

const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };
const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };

type Spec = { allow?: string[]; ask?: string[]; deny?: string[]; mode?: PermissionMode };

const bash = async (command: string, spec: Spec = {}) => {
  const layout = makeLayout();
  const make = ruleIn(layout);
  return (await decide({ secretLocations: testSecretLocations(layout.home),
    tool: BASH,
    subject: { kind: 'command', tool: 'Bash', command },
    mode: spec.mode ?? 'manual',
    rules: [
      ...(spec.allow ?? []).map((t) => make('allow', t)),
      ...(spec.ask ?? []).map((t) => make('ask', t)),
      ...(spec.deny ?? []).map((t) => make('deny', t)),
    ],
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project, fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]), protectedSet: EMPTY_PROTECTED_SET, fileRules: await fileRulesFor([
      ...(spec.allow ?? []).map((t) => make('allow', t)),
      ...(spec.ask ?? []).map((t) => make('ask', t)),
      ...(spec.deny ?? []).map((t) => make('deny', t)),
    ], [layout.project]),
  })).kind;
};

const ALLOW = ['Bash(ls:*)', 'Bash(echo:*)', 'Bash(cat:*)'];

describe('item 0: deny fallback never triggers on a non-literal argument', () => {
  it('matchRule: echo x with an escaped semicolon is a single echo command', async () => {
    const layout = makeLayout();
    expect(await matchRule(ruleIn(layout)('deny', 'Bash(rm:*)'), { kind: 'command', tool: 'Bash', command: 'echo x \\; rm -rf ~' }, await fileRulesFor([ruleIn(layout)('deny', 'Bash(rm:*)')], [ruleIn(layout)('deny', 'Bash(rm:*)').cwd]), 0, testProbes().canonicalise)).toBe(false);
  });

  it.each(['echo $HOME', 'echo ~ *.txt', 'ls $(date)', 'echo "$X" `date`'])('%j is not denied by Bash(rm:*)', async (command) => {
    expect(await bash(command, { allow: ALLOW, deny: ['Bash(rm:*)'] })).not.toBe('deny');
  });
});

describe('B1: wrappers around shell -c payloads', () => {
  it.each(['xargs sh -c "rm x"', 'env sh -c "rm x"', 'nice sh -c "rm x"', "timeout 5 bash -c 'rm x'", 'env FOO=1 nice -n 5 sh -c "rm x"'])(
    '%j is denied',
    async (command) => {
      expect(await bash(command, { deny: ['Bash(rm:*)'] })).toBe('deny');
      expect(await bash(command, { deny: ['Bash(rm:*)'], mode: 'bypassPermissions' })).toBe('deny');
    },
  );
});

describe('B2: unanalysable commands fail closed against deny', () => {
  it.each(["(r''m x)", '{ r"m" x; }', 'echo <(true); r""m x'])('%j is approved by no allow rule and denied where nobody is asked', async (command) => {
    expect(await bash(command, { deny: ['Bash(rm:*)'], allow: ['Bash'] })).toBe('ask');
    expect(await bash(command, { deny: ['Bash(rm:*)'], mode: 'bypassPermissions' })).toBe('deny');
  });
});

describe('B3: opaque command words and payloads fail closed against deny', () => {
  it.each(['R=rm; $R x', 'sh -c "$X"', 'eval $X', 'bash s.sh', 'bash < s.sh', 'echo rm | sh', 'printf rm|bash', 'source s.sh', '. s.sh'])(
    '%j is approved by no allow rule and denied where nobody is asked',
    async (command) => {
      expect(await bash(command, { deny: ['Bash(rm:*)'], allow: ['Bash'] })).toBe('ask');
      expect(await bash(command, { deny: ['Bash(rm:*)'], mode: 'bypassPermissions' })).toBe('deny');
    },
  );

  it('does not deny ordinary commands', async () => {
    expect(await bash('echo hi | cat', { allow: ALLOW, deny: ['Bash(rm:*)'] })).toBe('allow');
  });
});

describe('B4: unresolvable redirect targets under write deny rules', () => {
  const DENY = ['Write(~/.bashrc)'];
  it.each(['echo x > "$HOME/.bashrc"', 'echo x >$HOME/.bashrc', 'cd ~; echo x > .bashrc', 'echo x <(true) >"$HOME/.bashrc"'])(
    '%j asks in default and acceptEdits and runs in bypassPermissions, where the kernel enforces the deny rule',
    async (command) => {
      expect(await bash(command, { allow: ALLOW, deny: DENY, mode: 'bypassPermissions' })).toBe('allow');
      expect(await bash(command, { allow: ALLOW, deny: DENY })).toBe('ask');
      expect(await bash(command, { allow: ALLOW, deny: DENY, mode: 'acceptEdits' })).toBe('ask');
    },
  );

  it('without write deny rules bypass allows and default asks', async () => {
    expect(await bash('echo x > "$HOME/.bashrc"', { allow: ALLOW, mode: 'bypassPermissions' })).toBe('allow');
    expect(await bash('echo x > "$HOME/.bashrc"', { allow: ALLOW })).toBe('ask');
  });
});

describe('S3: more wrappers and any-offset deny', () => {
  it.each(['busybox rm x', 'chroot /r rm x', 'ionice -c3 rm x', 'caffeinate rm x', 'flock /tmp/l rm x', 'unbuffer rm x', 'parallel rm ::: x', 'sandbox-exec -p p rm x', 'arch -arm64 rm x'])(
    '%j is denied by Bash(rm:*)',
    async (command) => {
      expect(await bash(command, { deny: ['Bash(rm:*)'] })).toBe('deny');
    },
  );

  it('leaves unlink and find -delete to the sandbox under a Bash(rm:*) deny rule', async () => {
    expect(await bash('unlink x', { deny: ['Bash(rm:*)'] })).not.toBe('deny');
    expect(await bash('find . -delete', { deny: ['Bash(rm:*)'] })).not.toBe('deny');
  });
});

describe('S4: options do not defeat a literal prefix allow (D14)', () => {
  it.each([
    ['Bash(npm run test:*)', 'npm run test --script-shell=/tmp/x'],
    ['Bash(npm run test:*)', 'npm run test --userconfig /tmp/x'],
    ['Bash(npm run test:*)', 'npm run test --prefix /tmp/x'],
    ['Bash(npm run test:*)', 'npm run test --node-options=--require=/tmp/x'],
    ['Bash(npm run test:*)', 'npm run test --globalconfig=/tmp/x'],
    ['Bash(git log:*)', 'git log --upload-pack=/tmp/x'],
    ['Bash(git:*)', 'git --git-dir=/tmp/x log'],
    ['Bash(git:*)', 'git --work-tree /tmp/x log'],
    ['Bash(git:*)', 'git --exec-path=/tmp/x log'],
    ['Bash(git:*)', 'git --config-env=a=B log'],
    ['Bash(git:*)', 'git -c core.pager=x log'],
    ['Bash(git:*)', 'git -C /tmp log'],
    ['Bash(yarn test:*)', 'yarn test --script-shell /tmp/x'],
    ['Bash(pnpm test:*)', 'pnpm test --script-shell=/tmp/x'],
  ])('%s allows %j because the rule words match literally', async (rule, command) => {
    expect(await bash(command, { allow: [rule] })).toBe('allow');
  });

  it('asks when the rule words are not adjacent to the program', async () => {
    expect(await bash('git -C /tmp log', { allow: ['Bash(git log:*)'] })).toBe('ask');
    expect(await bash('git --git-dir=/tmp/x log', { allow: ['Bash(git log:*)'] })).toBe('ask');
  });

  it('still allows ordinary options', async () => {
    expect(await bash('git log --oneline -n 5', { allow: ['Bash(git log:*)'] })).toBe('allow');
    expect(await bash('npm run test --silent', { allow: ['Bash(npm run test:*)'] })).toBe('allow');
    expect(await bash('git commit -c HEAD', { allow: ['Bash(git:*)'] })).toBe('allow');
    expect(await bash('git log -C', { allow: ['Bash(git:*)'] })).toBe('allow');
  });
});

describe('S7: read redirections are read subjects', () => {
  it('denies cat < ~/.ssh/id_rsa under Read(~/.ssh/**), even in bypassPermissions', async () => {
    expect(await bash('cat < ~/.ssh/id_rsa', { allow: ALLOW, deny: ['Read(~/.ssh/**)'] })).toBe('deny');
    expect(await bash('cat < ~/.ssh/id_rsa', { allow: ALLOW, deny: ['Read(~/.ssh/**)'], mode: 'bypassPermissions' })).toBe('deny');
  });

  it('asks for reads outside the roots', async () => {
    expect(await bash('cat < /etc/hosts', { allow: ALLOW })).toBe('ask');
    expect(await bash('cat < /etc/hosts', { allow: ALLOW, mode: 'bypassPermissions' })).toBe('allow');
  });

  it('keeps here-strings and fd duplication harmless', async () => {
    expect(await bash('cat <<< hello', { allow: ALLOW })).toBe('allow');
    expect(await bash('ls 2>&1', { allow: ALLOW })).toBe('allow');
  });
});

describe('S8: writer commands are write subjects', () => {
  const DENY = ['Write(./.git/**)'];
  it.each([
    'tee .git/hooks/pre-commit',
    'tee -a .git/hooks/pre-commit',
    'cp x .git/hooks/pre-commit',
    'mv x .git/hooks/pre-commit',
    'dd if=x of=.git/hooks/pre-commit',
    'install x .git/hooks/h',
    'touch .git/hooks/h',
    'truncate -s 0 .git/hooks/h',
    'ln -s x .git/hooks/h',
    'env tee .git/hooks/pre-commit',
  ])('%j is denied', async (command) => {
    expect(await bash(command, { deny: DENY })).toBe('deny');
    expect(await bash(command, { deny: DENY, mode: 'bypassPermissions' })).toBe('deny');
  });

  it('does not treat sed without -i as a writer', async () => {
    expect(await bash('sed s/a/b/ .git/config', { allow: ['Bash(sed:*)'], deny: DENY })).toBe('allow');
  });
});

describe('S2 and S1: slash-less patterns and case', () => {
  it('slash-less allow requires the canonical path inside the roots', async () => {
    const layout = makeLayout();
    const rule = ruleIn(layout)('allow', 'Write(*.ts)');
    const roots = [layout.project];
    const subject = (file: string): PermissionSubject => ({ kind: 'path', tool: 'Write', paths: [file], access: 'write' });
    const inside = touch(path.join(layout.project, 'a.ts'));
    const outside = touch(path.join(layout.outside, 'a.ts'));
    fs.symlinkSync(outside, path.join(layout.project, 'link.ts'));
    const decision = async (file: string) =>
      await (await decide({ secretLocations: testSecretLocations(layout.home), tool: WRITE, subject: subject(file), mode: 'manual', rules: [rule], roots, fileRules: await fileRulesFor([rule], roots), home: layout.home, cwd: layout.project, fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor(roots), protectedSet: EMPTY_PROTECTED_SET })).kind;
    expect(await decision(inside)).toBe('allow');
    expect(await decision(outside)).toBe('ask');
    expect(await decision(path.join(layout.project, 'link.ts'))).toBe('ask');
    expect(await decision('/etc/a.ts')).toBe('ask');
  });

  it('slash-less deny, ask and allow all match a path below a matched node', async () => {
    const layout = makeLayout();
    const make = ruleIn(layout);
    const file = touch(path.join(layout.project, '.env', 'inner.txt'));
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: [file], access: 'read' };
    const roots = [layout.project];
    const decision = async (rule: PermissionRule) =>
      await decide({ secretLocations: testSecretLocations(layout.home), tool: READ, subject, mode: 'manual', rules: [rule], roots, home: layout.home, cwd: layout.project, fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor(roots), protectedSet: EMPTY_PROTECTED_SET, fileRules: await computeFileRules([rule], roots, null, ruleEnforcementOf('none'), testProbes()) });
    expect(await decision(make('deny', 'Read(.env)'))).toMatchObject({ kind: 'deny', source: 'rule' });
    expect(await decision(make('ask', 'Read(.env)'))).toMatchObject({ kind: 'ask', source: 'rule' });
    expect(await decision(make('allow', 'Read(.env)'))).toMatchObject({ kind: 'allow', source: 'rule' });
    expect(await decision(make('allow', 'Read(inner.txt)'))).toMatchObject({ kind: 'allow', source: 'rule' });
  });

  it.skipIf(process.platform === 'linux')('deny and ask compare case-insensitively on case-insensitive volumes while allow stays exact', async () => {
    const layout = makeLayout();
    const make = ruleIn(layout);
    const upper: PermissionSubject = { kind: 'path', tool: 'Write', paths: [path.join(layout.project, 'NEWDIR', 'k')], access: 'write' };
    expect(await matchRule(make('deny', 'Write(./newdir/**)'), upper, await fileRulesFor([make('deny', 'Write(./newdir/**)')], [make('deny', 'Write(./newdir/**)').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('ask', 'Write(./newdir/**)'), upper, await fileRulesFor([make('ask', 'Write(./newdir/**)')], [make('ask', 'Write(./newdir/**)').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('allow', 'Write(./newdir/**)'), upper, await fileRulesFor([make('allow', 'Write(./newdir/**)')], [make('allow', 'Write(./newdir/**)').cwd]), 0, testProbes().canonicalise)).toBe(false);
    const dot: PermissionSubject = { kind: 'path', tool: 'Read', paths: [path.join(layout.project, '.ENV')], access: 'read' };
    expect(await matchRule(make('deny', 'Read(.env)'), dot, await fileRulesFor([make('deny', 'Read(.env)')], [make('deny', 'Read(.env)').cwd]), 0, testProbes().canonicalise)).toBe(true);
    expect(await matchRule(make('allow', 'Read(.env)'), dot, await fileRulesFor([make('allow', 'Read(.env)')], [make('allow', 'Read(.env)').cwd]), 0, testProbes().canonicalise)).toBe(false);
  });
});

describe('read tool sanity', () => {
  it('Read tool decisions are unchanged inside roots', async () => {
    const layout = makeLayout();
    const file = touch(path.join(layout.project, 'f'));
    expect(
      await (await decide({ secretLocations: testSecretLocations(layout.home), tool: READ, subject: { kind: 'path', tool: 'Read', paths: [file], access: 'read' }, mode: 'manual', rules: [], roots: [layout.project], home: layout.home, cwd: layout.project, fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]), protectedSet: EMPTY_PROTECTED_SET, fileRules: await fileRulesFor([], [layout.project]) })).kind,
    ).toBe('allow');
  });
});

describe('S8: sed -i follows the resolved sed (3.5, revision 25)', () => {
  const DENY = [['deny', 'Write(./.git/**)']] as const;
  const FORMER_DENIES = ['sed -i s/a/b/ .git/config', 'sed --expression=s/a/b/ -i .git/config', 'sed --file=s.sed -i .git/config', 'sed --in-place -e s/a/b/ .git/config'];
  const NON_APPLE: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
    ['a Homebrew sed', { sed: '/opt/homebrew/bin/sed' }],
    ['an unresolved sed', {}],
  ];

  it.each(NON_APPLE.flatMap(([label, programs]) => FORMER_DENIES.map((command) => [command, label, programs] as const)))('%s with %s is denied by the union reading', async (command, _label, programs) => {
    const row = commandRow(command, { rules: DENY, fs: () => ({ programs }) });
    expect(await kindIn(row, 'manual')).toBe('deny');
    expect(await kindIn(row, 'bypassPermissions')).toBe('deny');
  });

  it.each(FORMER_DENIES)('%s with /usr/bin/sed has no target on Darwin: asks in default, allowed in bypass', async (command) => {
    const row = commandRow(command, { rules: DENY, fs: () => ({ programs: { sed: '/usr/bin/sed' } }) });
    expect(await kindIn(row, 'manual')).toBe('ask');
    expect(await kindIn(row, 'bypassPermissions')).toBe('allow');
  });

  it.each([
    ["sed -i '' s/a/b/ .git/config", { sed: '/usr/bin/sed' }],
    ["sed -i '' s/a/b/ .git/config", { sed: '/opt/homebrew/bin/sed' }],
    ['sed -i .bak s/a/b/ .git/config', { sed: '/usr/bin/sed' }],
    ['sed -i .bak s/a/b/ .git/config', { sed: '/opt/homebrew/bin/sed' }],
  ] as const)('%s is denied whatever sed resolves to (%o)', async (command, programs) => {
    const row = commandRow(command, { rules: DENY, fs: () => ({ programs }) });
    expect(await kindIn(row, 'manual')).toBe('deny');
    expect(await kindIn(row, 'bypassPermissions')).toBe('deny');
  });

  it('asks as a protected write for a GNU sed -i s/a/b/ .git/HEAD under Bash(sed:*)', async () => {
    const row = commandRow('sed -i s/a/b/ .git/HEAD', {
      rules: [['allow', 'Bash(sed:*)']],
      protection: true,
      fs: () => ({ programs: { sed: '/opt/homebrew/bin/sed' } }),
      prepare: (layout) => void touch(path.join(layout.project, '.git', 'HEAD')),
    });
    for (const mode of ['manual', 'acceptEdits', 'bypassPermissions'] as const) expect(await kindIn(row, mode)).toBe('prot');
  });
});
