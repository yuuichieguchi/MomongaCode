import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestModule, TestSuite } from 'vitest/node';

export type SkipDeclaration = { readonly kind: 'conditional'; readonly reason: string } | { readonly kind: 'bare' } | { readonly kind: 'none' } | { readonly kind: 'unselected' };

export type SkippedTest = { readonly file: string; readonly name: string; readonly note: string | undefined; readonly declaration: SkipDeclaration };

export type SkipLedger = { readonly lines: readonly string[]; readonly unreasoned: readonly string[] };

const DECLARATION_HEAD = /\b(?:it|test|describe)\b/;

const HEAD_LOOKBACK_LINES = 5;

const CONDITIONAL = /\.(skipIf|runIf)\(/;

const BARE = /\b(?:it|test|describe)\.(?:skip|todo)\(/;

const balancedArgumentOf = (text: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
};

export const skipDeclarationOf = (lines: readonly string[], index: number): SkipDeclaration => {
  let head = index;
  while (head > 0 && index - head < HEAD_LOOKBACK_LINES && !DECLARATION_HEAD.test(lines[head] ?? '')) head -= 1;
  const text = lines.slice(head, index + 1).join('\n');
  const conditional = CONDITIONAL.exec(text);
  if (conditional !== null) {
    const condition = balancedArgumentOf(text, conditional.index + conditional[0].length - 1).replace(/\s+/g, ' ').trim();
    return { kind: 'conditional', reason: conditional[1] === 'skipIf' ? `skipped if ${condition}` : `runs only if ${condition}` };
  }
  return BARE.test(text) ? { kind: 'bare' } : { kind: 'none' };
};

export const ledgerOf = (skipped: readonly SkippedTest[]): SkipLedger => {
  const lines: string[] = [];
  const unreasoned: string[] = [];
  for (const test of skipped) {
    const where = `${test.file} > ${test.name}`;
    if (test.note !== undefined && test.note.trim() !== '') lines.push(`${where}: ${test.note}`);
    else if (test.declaration.kind === 'conditional') lines.push(`${where}: ${test.declaration.reason}`);
    else if (test.declaration.kind !== 'unselected') unreasoned.push(where);
  }
  return { lines, unreasoned };
};

const declarationAt = (lines: readonly string[], entity: TestCase | TestSuite): SkipDeclaration =>
  entity.location === undefined ? { kind: 'none' } : skipDeclarationOf(lines, entity.location.line - 1);

const declarationOfTest = (lines: readonly string[], test: TestCase): SkipDeclaration => {
  const chain: Array<TestCase | TestSuite> = [test];
  for (let parent = test.parent; parent.type === 'suite'; parent = parent.parent) chain.push(parent);
  for (const entity of chain) {
    const declaration = declarationAt(lines, entity);
    if (declaration.kind !== 'none') return declaration;
  }
  return test.diagnostic() === undefined ? { kind: 'unselected' } : { kind: 'none' };
};

const noteOf = (test: TestCase): string | undefined => {
  const result = test.result();
  return result.state === 'skipped' ? result.note : undefined;
};

export const skippedTestsOf = (modules: readonly TestModule[], root: string): SkippedTest[] =>
  modules.flatMap((module) => {
    const skipped = [...module.children.allTests('skipped')];
    if (skipped.length === 0) return [];
    const lines = fs.readFileSync(module.moduleId, 'utf8').split('\n');
    const file = path.relative(root, module.moduleId).split(path.sep).join('/');
    return skipped.map((test) => ({ file, name: test.fullName, note: noteOf(test), declaration: declarationOfTest(lines, test) }));
  });

export default class SkipLedgerReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: { readonly config: { readonly root: string } }): void {
    this.root = vitest.config.root;
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    const ledger = ledgerOf(skippedTestsOf(modules, this.root));
    if (ledger.lines.length > 0) process.stdout.write(`\nSkipped tests (${ledger.lines.length}):\n${ledger.lines.map((line) => `  ${line}`).join('\n')}\n`);
    if (ledger.unreasoned.length === 0) return;
    process.stderr.write(`\nSkipped with no reason (give the skip a condition or a note), which fails the run:\n${ledger.unreasoned.map((line) => `  ${line}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}
