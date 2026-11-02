import { describe, expect, it } from 'vitest';
import { analyzeCommand, allReadTargets, allWriteTargets } from '../src/shell.ts';
import { commandRow, kindIn } from './decision-rows.ts';

const analysed = (command: string) => {
  const analysis = analyzeCommand(command);
  expect(analysis).not.toBeNull();
  return analysis as NonNullable<typeof analysis>;
};

const writes = (command: string) => allWriteTargets(analysed(command));

const CWD_CHANGED = { unresolvable: { kind: 'cwd-changed' } };
const ROOT_CHANGED = { unresolvable: { kind: 'root-changed' } };
const CONFIG_OVERRIDE = { unresolvable: { kind: 'config-override' } };

describe('option-level directory changes make relative operands unresolvable', () => {
  it.each([
    ['env -C d tee x', 'env -C d tee /abs/x'],
    ['env --chdir=d tee x', 'env --chdir=d tee /abs/x'],
    ['env --chdir d tee x', 'env --chdir d tee /abs/x'],
    ['sudo -D d tee x', 'sudo -D d tee /abs/x'],
    ['sudo --chdir=d tee x', 'sudo --chdir=d tee /abs/x'],
    ['sudo -i tee x', 'sudo -i tee /abs/x'],
    ['sudo --login tee x', 'sudo --login tee /abs/x'],
    ['parallel --wd d tee x', 'parallel --wd d tee /abs/x'],
    ['git -C d clone u x', 'git -C d clone u /abs/x'],
    ['git --git-dir=d clone u x', 'git --git-dir=d clone u /abs/x'],
    ['git --work-tree=d clone u x', 'git --work-tree=d clone u /abs/x'],
  ])('%s gives cwd-changed, %s stays literal', (relative, absolute) => {
    expect(writes(relative)).toContainEqual(CWD_CHANGED);
    expect(writes(relative)).not.toContainEqual({ literal: 'x' });
    expect(writes(absolute)).toContainEqual({ literal: '/abs/x' });
  });

  it.each([
    ['sudo -R d tee x', 'sudo -R d tee /abs/x'],
    ['sudo --chroot=d tee x', 'sudo --chroot=d tee /abs/x'],
    ['chroot /r tee x', 'chroot /r tee /abs/x'],
  ])('%s gives root-changed for relative and absolute operands', (relative, absolute) => {
    expect(writes(relative)).toContainEqual(ROOT_CHANGED);
    expect(writes(absolute)).toContainEqual(ROOT_CHANGED);
    expect(writes(absolute)).not.toContainEqual({ literal: '/abs/x' });
  });

  it('opens the tar archive in the session cwd and resolves members after -C', () => {
    expect(allReadTargets(analysed('tar -C d -xf a.tar'))).toContainEqual({ literal: 'a.tar' });
    expect(writes('tar -C d -xf a.tar')).toContainEqual(CWD_CHANGED);
    expect(writes('tar --directory=d -cf o.tgz m')).toContainEqual({ literal: 'o.tgz' });
    expect(allReadTargets(analysed('tar --directory=d -cf o.tgz m'))).toContainEqual(CWD_CHANGED);
  });
});

describe('payload scope', () => {
  it.each([
    ["env -C d sh -c 'tee x'"],
    ["env -C d -S 'tee x'"],
    ["sudo -D d bash -c 'echo > y'"],
    ["env -C d flock -c 'tee x' f"],
  ])('%s makes the nested relative target cwd-changed', (command) => {
    const targets = writes(command);
    expect(targets).toContainEqual(CWD_CHANGED);
    expect(targets).not.toContainEqual({ literal: 'x' });
    expect(targets).not.toContainEqual({ literal: 'y' });
  });
});

describe('git config overrides', () => {
  it.each(['git -c k=v clone u x', 'git -ck=v clone u x', 'git --config-env=k=V clone u x'])('%s gives config-override for x', (command) => {
    expect(writes(command)).toContainEqual(CONFIG_OVERRIDE);
    expect(writes(command)).not.toContainEqual({ literal: 'x' });
  });

  it('keeps an absolute clone destination literal', () => {
    expect(writes('git clone u /abs')).toContainEqual({ literal: '/abs' });
  });
});

describe('controls (pins)', () => {
  it.each(['env -u X tee x', 'timeout 5 tee x', 'nice tee x', 'nohup tee x', 'stdbuf -o0 tee x', 'xargs tee x', 'doas tee x', 'time tee x'])(
    '%s keeps x literal',
    (command) => {
      expect(writes(command)).toContainEqual({ literal: 'x' });
    },
  );

  it('keeps a shell redirection of the same segment literal', () => {
    expect(writes('env -C d true > rel')).toContainEqual({ literal: 'rel' });
  });

  it('keeps a later segment literal', () => {
    expect(writes('env -C d true; tee y')).toContainEqual({ literal: 'y' });
  });

  it('makes a target after cd unresolvable', () => {
    expect(writes('cd d; tee y')).toContainEqual(CWD_CHANGED);
  });

  it('asks for a wrapper with a directory change under a deny rule, allows it in bypass (pin)', () => {
    const row = commandRow('env -C /outside tee x', { rules: [['deny', 'Write(//outside/**)']] });
    expect(kindIn(row, 'default')).toBe('ask');
    expect(kindIn(row, 'acceptEdits')).toBe('ask');
    expect(kindIn(row, 'bypassPermissions')).toBe('allow');
  });
});
