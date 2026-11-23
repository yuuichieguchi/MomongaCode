import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const repo = path.resolve(import.meta.dirname, '..');
const specPath = path.join(repo, 'specs', 'tla', 'CompactAt.tla');
const spec = fs.readFileSync(specPath, 'utf8');
const workerSource = (name: string): string => fs.readFileSync(path.join(repo, 'packages', 'runtime', 'src', 'worker', name), 'utf8');
const contextStep = workerSource('context-step.ts');
const claimRunner = workerSource('claim-runner.ts');

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in ${specPath}`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const buildLoop = (): string => {
  const start = contextStep.indexOf('const buildNextUnguarded = async');
  if (start === -1) throw new Error('buildNextUnguarded is not defined in context-step.ts');
  const end = contextStep.indexOf('\n};\n', start);
  return contextStep.slice(start, end);
};

describe('CompactAt.tla against the context step of the worker', () => {
  it('compacts, forced and proactive, only under autoCompact, as MayCompact guards both actions', () => {
    expect(spec).toMatch(/^MayCompact == auto \\\/ IgnoreAuto$/m);
    expect(definitionOf('OverCompact')).toContain('/\\ MayCompact');
    expect(definitionOf('Proactive')).toContain('/\\ MayCompact');
    const loop = buildLoop();
    expect(loop).toContain('if (error.compaction !== undefined && ctx.autoCompact && !levelsWithCompaction.has(level)) {');
    expect(loop).toContain('if (built.compaction !== undefined && ctx.autoCompact && options.wrapUp === undefined && level === 0 && !proactiveDone) {');
    expect(loop.match(/await compact\(/g)).toHaveLength(2);
  });

  it('attempts a forced compaction at most once per protection level, and a retry clears that guard', () => {
    expect(definitionOf('OverCompact')).toContain('(level \\notin levelsDone \\/ ForgetLevel)');
    expect(definitionOf('OverCompact')).toContain('levelsDone\' = IF r = "retry" THEN levelsDone \\ {level} ELSE levelsDone \\cup {level}');
    const loop = buildLoop();
    expect(loop).toContain('const levelsWithCompaction = new Set<number>();');
    expect(loop).toContain('levelsWithCompaction.add(level);');
    expect(loop).toContain("if (result === 'retry') levelsWithCompaction.delete(level);");
  });

  it('compacts proactively at most once per step, only at level 0 and without a wrap-up, and a retry clears that guard', () => {
    expect(definitionOf('Proactive')).toContain('/\\ ~wrap /\\ level = 0');
    expect(definitionOf('Proactive')).toContain('(~proDone \\/ NoProactiveFlag)');
    expect(definitionOf('Proactive')).toContain('proDone\' = (r # "retry")');
    expect(definitionOf('StartStep')).toContain("levelsDone' = {} /\\ proDone' = FALSE");
    const loop = buildLoop();
    expect(loop).toContain('let proactiveDone = false;');
    expect(loop).toContain('proactiveDone = true;');
    expect(loop).toContain("if (result === 'retry') proactiveDone = false;");
  });

  it('fixes the mark per claim, as the claim reads context.compactAt once and every build of the claim carries it', () => {
    expect(definitionOf('Init')).toContain('mark \\in Marks');
    expect(definitionOf('Reclaim')).toContain("mark' \\in Marks");
    for (const action of ['StartStep', 'BuildRejected', 'OverCompact', 'Raise', 'LastOver', 'SendFit', 'Proactive', 'End', 'Crash']) {
      expect(definitionOf(action), action).toMatch(/UNCHANGED <<[^>]*\bmark\b/);
    }
    expect(claimRunner.match(/settings\.context\(/g)).toHaveLength(1);
    expect(claimRunner).toMatch(/compactAt: compactAtRatioOf\(/);
    expect(contextStep).toMatch(/compactAt: ctx\.compactAt\b/);
  });
});
