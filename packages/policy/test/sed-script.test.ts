import { describe, expect, it } from 'vitest';
import { scanSedScript } from '../src/sed-script.ts';
import { analyzeCommand, allWriteTargets } from '../src/shell.ts';
import { commandRow, kindIn } from './decision-rows.ts';

const DYNAMIC = { unresolvable: { kind: 'dynamic' } };

describe('sed script grammar', () => {
  it.each(['s/a/b/', 's/e/x/g', '1,3d', '/x/p', '$!N;P;D', 'y/abc/xyz/', 'a\\ text', 'p'])('%j is simple', (script) => {
    expect(scanSedScript(script).simple).toBe(true);
  });

  it.each(['w out', 's/a/b/w out', 's/a/b/e', 'e touch x', 'r f', 'R f', 'W f', 's/a/b', ''])('%j is not simple', (script) => {
    expect(scanSedScript(script).simple).toBe(false);
  });

  it('makes sed -n with a simple script approvable and -f non-approvable', () => {
    expect(kindIn(commandRow("sed -n 'p' f"), 'default')).toBe('allow');
    expect(kindIn(commandRow('sed -f s.sed f'), 'default')).toBe('ask');
  });
});

describe('sed script targets for a rule-granted sed', () => {
  it('w gives a write target', () => {
    expect(scanSedScript('w out')).toMatchObject({ writes: [{ literal: 'out' }], reads: [] });
  });

  it('s with the w flag gives a write target', () => {
    expect(scanSedScript('s/a/b/w out')).toMatchObject({ writes: [{ literal: 'out' }] });
  });

  it('r gives a read target', () => {
    expect(scanSedScript('r f')).toMatchObject({ writes: [], reads: [{ literal: 'f' }] });
  });

  it('e gives a dynamic write', () => {
    expect(scanSedScript('e x').writes).toEqual([DYNAMIC]);
  });

  it('an unparsable script gives a dynamic write', () => {
    expect(scanSedScript('s/a/b').writes).toEqual([DYNAMIC]);
  });
});

describe('awk for a rule-granted command', () => {
  const analysed = (command: string) => {
    const analysis = analyzeCommand(command);
    expect(analysis).not.toBeNull();
    return analysis as NonNullable<typeof analysis>;
  };

  it('gives no target for a plain program', () => {
    expect(allWriteTargets(analysed("awk '$1 > 5' f"))).toEqual([]);
  });

  it.each([`awk '{print > "o"}' f`, `awk '{print | "sh"}' f`, `awk 'BEGIN{system("x")}'`])('%s gives one dynamic write and is unanalyzable', (command) => {
    const analysis = analysed(command);
    expect(allWriteTargets(analysis)).toEqual([DYNAMIC]);
    expect(analysis.segments[0]?.unanalyzable).toBe(true);
  });
});

describe('bracket expressions follow BSD compile_delimited (P2-4c)', () => {
  it('rejects the script whose w flag is live behind a bracket', () => {
    expect(scanSedScript('s/[/]/g;s|x|y/w out|').simple).toBe(false);
    expect(scanSedScript('s/[/]/g;s|x|y/w out|').writes).toEqual([{ literal: 'out|' }]);
  });

  it.each(['s/[/]/X/', 's/[]/]/X/', 's/[^]/]/X/', 's/[[:alpha:]/]/X/', 's/[[.a.]/]/X/', 's/[a\\]/X/', '/[/]/p', '\\|[|]|p', 's|[|]|X|', 's/a\\/b/X/', 's/[\\/]/X/'])('%s parses', (script) => {
    expect(scanSedScript(script).simple).toBe(true);
  });

  it.each(['y/[/]/XYZ/', 'y/a/b/;y/[]/(x)/', 's/b/[/]/', 's/[a/b/'])('%s is an error', (script) => {
    expect(scanSedScript(script).simple).toBe(false);
  });
});
