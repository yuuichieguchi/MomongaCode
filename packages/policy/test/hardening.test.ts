import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFileRules, decide, matchRule } from '@momonga/policy';
import type { DecideInput, PermissionRule, PermissionSubject, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { fileRulesFor, makeLayout, ruleIn, touch } from './helpers.ts';

const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec' };
const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write' };

type Spec = { allow?: string[]; ask?: string[]; deny?: string[]; mode?: PermissionMode };

const bash = (command: string, spec: Spec = {}) => {
  const layout = makeLayout();
  const make = ruleIn(layout);
  return decide({
    tool: BASH,
    subject: { kind: 'command', tool: 'Bash', command },
    mode: spec.mode ?? 'default',
    rules: [
      ...(spec.allow ?? []).map((t) => make('allow', t)),
      ...(spec.ask ?? []).map((t) => make('ask', t)),
      ...(spec.deny ?? []).map((t) => make('deny', t)),
    ],
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project, fileRules: fileRulesFor([
      ...(spec.allow ?? []).map((t) => make('allow', t)),
      ...(spec.ask ?? []).map((t) => make('ask', t)),
      ...(spec.deny ?? []).map((t) => make('deny', t)),
    ], [layout.project]),
  }).kind;
};

const ALLOW = ['Bash(ls:*)', 'Bash(echo:*)', 'Bash(cat:*)'];

describe('item 0: deny fallback never triggers on a non-literal argument', () => {
  it('matchRule: echo x with an escaped semicolon is a single echo command', () => {
    const layout = makeLayout();
    expect(matchRule(ruleIn(layout)('deny', 'Bash(rm:*)'), { kind: 'command', tool: 'Bash', command: 'echo x \\; rm -rf ~' }, fileRulesFor([ruleIn(layout)('deny', 'Bash(rm:*)')], [ruleIn(layout)('deny', 'Bash(rm:*)').cwd]), 0)).toBe(false);
  });

  it.each(['echo $HOME', 'echo ~ *.txt', 'ls $(date)', 'echo "$X" `date`'])('%j is not denied by Bash(rm:*)', (command) => {
    expect(bash(command, { allow: ALLOW, deny: ['Bash(rm:*)'] })).not.toBe('deny');
  });
});

describe('B1: wrappers around shell -c payloads', () => {
  it.each(['xargs sh -c "rm x"', 'env sh -c "rm x"', 'nice sh -c "rm x"', "timeout 5 bash -c 'rm x'", 'env FOO=1 nice -n 5 sh -c "rm x"'])(
    '%j is denied',
    (command) => {
      expect(bash(command, { deny: ['Bash(rm:*)'] })).toBe('deny');
      expect(bash(command, { deny: ['Bash(rm:*)'], mode: 'bypassPermissions' })).toBe('deny');
    },
  );
});

describe('B2: unanalysable commands fail closed against deny', () => {
  it.each(["(r''m x)", '{ r"m" x; }', 'echo <(true); r""m x'])('%j is denied', (command) => {
    expect(bash(command, { deny: ['Bash(rm:*)'] })).toBe('deny');
    expect(bash(command, { deny: ['Bash(rm:*)'], mode: 'bypassPermissions' })).toBe('deny');
  });
});

describe('B3: opaque command words and payloads fail closed against deny', () => {
  it.each(['R=rm; $R x', 'sh -c "$X"', 'eval $X', 'bash s.sh', 'bash < s.sh', 'echo rm | sh', 'printf rm|bash', 'source s.sh', '. s.sh'])(
    '%j is denied',
    (command) => {
      expect(bash(command, { deny: ['Bash(rm:*)'] })).toBe('deny');
      expect(bash(command, { deny: ['Bash(rm:*)'], mode: 'bypassPermissions' })).toBe('deny');
    },
  );

  it('does not deny ordinary commands', () => {
    expect(bash('echo hi | cat', { allow: ALLOW, deny: ['Bash(rm:*)'] })).toBe('allow');
  });
});

describe('B4: unresolvable redirect targets under write deny rules', () => {
  const DENY = ['Write(~/.bashrc)'];
  it.each(['echo x > "$HOME/.bashrc"', 'echo x >$HOME/.bashrc', 'cd ~; echo x > .bashrc', 'echo x <(true) >"$HOME/.bashrc"'])(
    '%j is denied in bypassPermissions and default',
    (command) => {
      expect(bash(command, { allow: ALLOW, deny: DENY, mode: 'bypassPermissions' })).toBe('deny');
      expect(bash(command, { allow: ALLOW, deny: DENY })).toBe('deny');
    },
  );

  it('without write deny rules bypass allows and default asks', () => {
    expect(bash('echo x > "$HOME/.bashrc"', { allow: ALLOW, mode: 'bypassPermissions' })).toBe('allow');
    expect(bash('echo x > "$HOME/.bashrc"', { allow: ALLOW })).toBe('ask');
  });
});

describe('S3: more wrappers and any-offset deny', () => {
  it.each(['busybox rm x', 'chroot /r rm x', 'ionice -c3 rm x', 'caffeinate rm x', 'flock /tmp/l rm x', 'unbuffer rm x', 'parallel rm ::: x', 'sandbox-exec -p p rm x', 'arch -arm64 rm x'])(
    '%j is denied by Bash(rm:*)',
    (command) => {
      expect(bash(command, { deny: ['Bash(rm:*)'] })).toBe('deny');
    },
  );

  it('best effort only: the sandbox is the backstop for unlink and find -delete', () => {
    expect(bash('unlink x', { deny: ['Bash(rm:*)'] })).not.toBe('deny');
    expect(bash('find . -delete', { deny: ['Bash(rm:*)'] })).not.toBe('deny');
  });
});

describe('S4: dangerous options defeat prefix allow', () => {
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
  ])('%s does not allow %j', (rule, command) => {
    expect(bash(command, { allow: [rule] })).toBe('ask');
  });

  it('still allows ordinary options', () => {
    expect(bash('git log --oneline -n 5', { allow: ['Bash(git log:*)'] })).toBe('allow');
    expect(bash('npm run test --silent', { allow: ['Bash(npm run test:*)'] })).toBe('allow');
    expect(bash('git commit -c HEAD', { allow: ['Bash(git:*)'] })).toBe('allow');
    expect(bash('git log -C', { allow: ['Bash(git:*)'] })).toBe('allow');
  });
});

describe('S7: read redirections are read subjects', () => {
  it('denies cat < ~/.ssh/id_rsa under Read(~/.ssh/**), even in bypassPermissions', () => {
    expect(bash('cat < ~/.ssh/id_rsa', { allow: ALLOW, deny: ['Read(~/.ssh/**)'] })).toBe('deny');
    expect(bash('cat < ~/.ssh/id_rsa', { allow: ALLOW, deny: ['Read(~/.ssh/**)'], mode: 'bypassPermissions' })).toBe('deny');
  });

  it('asks for reads outside the roots', () => {
    expect(bash('cat < /etc/hosts', { allow: ALLOW })).toBe('ask');
    expect(bash('cat < /etc/hosts', { allow: ALLOW, mode: 'bypassPermissions' })).toBe('allow');
  });

  it('keeps here-strings and fd duplication harmless', () => {
    expect(bash('cat <<< hello', { allow: ALLOW })).toBe('allow');
    expect(bash('ls 2>&1', { allow: ALLOW })).toBe('allow');
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
    'sed -i s/a/b/ .git/config',
    'install x .git/hooks/h',
    'touch .git/hooks/h',
    'truncate -s 0 .git/hooks/h',
    'ln -s x .git/hooks/h',
    'env tee .git/hooks/pre-commit',
  ])('%j is denied', (command) => {
    expect(bash(command, { deny: DENY })).toBe('deny');
    expect(bash(command, { deny: DENY, mode: 'bypassPermissions' })).toBe('deny');
  });

  it('does not treat sed without -i as a writer', () => {
    expect(bash('sed s/a/b/ .git/config', { allow: ['Bash(sed:*)'], deny: DENY })).toBe('allow');
  });
});

describe('S2 and S1: slash-less patterns and case', () => {
  it('slash-less allow requires the canonical path inside the roots', () => {
    const layout = makeLayout();
    const rule = ruleIn(layout)('allow', 'Write(*.ts)');
    const roots = [layout.project];
    const subject = (file: string): PermissionSubject => ({ kind: 'path', tool: 'Write', paths: [file], access: 'write' });
    const inside = touch(path.join(layout.project, 'a.ts'));
    const outside = touch(path.join(layout.outside, 'a.ts'));
    fs.symlinkSync(outside, path.join(layout.project, 'link.ts'));
    const decision = (file: string) =>
      decide({ tool: WRITE, subject: subject(file), mode: 'default', rules: [rule], roots, fileRules: fileRulesFor([rule], roots), home: layout.home, cwd: layout.project }).kind;
    expect(decision(inside)).toBe('allow');
    expect(decision(outside)).toBe('ask');
    expect(decision(path.join(layout.project, 'link.ts'))).toBe('ask');
    expect(decision('/etc/a.ts')).toBe('ask');
  });

  it('slash-less deny, ask and allow all match a path below a matched node', () => {
    const layout = makeLayout();
    const make = ruleIn(layout);
    const file = touch(path.join(layout.project, '.env', 'inner.txt'));
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: [file], access: 'read' };
    const roots = [layout.project];
    const decision = (rule: PermissionRule) =>
      decide({ tool: READ, subject, mode: 'default', rules: [rule], roots, home: layout.home, cwd: layout.project, fileRules: computeFileRules([rule], roots, null) } as DecideInput);
    expect(decision(make('deny', 'Read(.env)'))).toMatchObject({ kind: 'deny', source: 'rule' });
    expect(decision(make('ask', 'Read(.env)'))).toMatchObject({ kind: 'ask', source: 'rule' });
    expect(decision(make('allow', 'Read(.env)'))).toMatchObject({ kind: 'allow', source: 'rule' });
    expect(decision(make('allow', 'Read(inner.txt)'))).toMatchObject({ kind: 'allow', source: 'rule' });
  });

  it.skipIf(process.platform === 'linux')('deny and ask compare case-insensitively on case-insensitive volumes while allow stays exact', () => {
    const layout = makeLayout();
    const make = ruleIn(layout);
    const upper: PermissionSubject = { kind: 'path', tool: 'Write', paths: [path.join(layout.project, 'NEWDIR', 'k')], access: 'write' };
    expect(matchRule(make('deny', 'Write(./newdir/**)'), upper, fileRulesFor([make('deny', 'Write(./newdir/**)')], [make('deny', 'Write(./newdir/**)').cwd]), 0)).toBe(true);
    expect(matchRule(make('ask', 'Write(./newdir/**)'), upper, fileRulesFor([make('ask', 'Write(./newdir/**)')], [make('ask', 'Write(./newdir/**)').cwd]), 0)).toBe(true);
    expect(matchRule(make('allow', 'Write(./newdir/**)'), upper, fileRulesFor([make('allow', 'Write(./newdir/**)')], [make('allow', 'Write(./newdir/**)').cwd]), 0)).toBe(false);
    const dot: PermissionSubject = { kind: 'path', tool: 'Read', paths: [path.join(layout.project, '.ENV')], access: 'read' };
    expect(matchRule(make('deny', 'Read(.env)'), dot, fileRulesFor([make('deny', 'Read(.env)')], [make('deny', 'Read(.env)').cwd]), 0)).toBe(true);
    expect(matchRule(make('allow', 'Read(.env)'), dot, fileRulesFor([make('allow', 'Read(.env)')], [make('allow', 'Read(.env)').cwd]), 0)).toBe(false);
  });
});

describe('read tool sanity', () => {
  it('Read tool decisions are unchanged inside roots', () => {
    const layout = makeLayout();
    const file = touch(path.join(layout.project, 'f'));
    expect(
      decide({ tool: READ, subject: { kind: 'path', tool: 'Read', paths: [file], access: 'read' }, mode: 'default', rules: [], roots: [layout.project], home: layout.home, cwd: layout.project, fileRules: fileRulesFor([], [layout.project]) }).kind,
    ).toBe('allow');
  });
});
