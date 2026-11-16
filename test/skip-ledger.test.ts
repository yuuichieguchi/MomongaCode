import { describe, expect, it } from 'vitest';
import { ledgerOf, skipDeclarationOf } from './support/skip-ledger.ts';

describe('the skip ledger', () => {
  it('reads the condition of a skipIf or a runIf as the reason of the skip, across lines', () => {
    expect(skipDeclarationOf(["it.skipIf(process.platform === 'win32')('names it', () => {"], 0)).toEqual({ kind: 'conditional', reason: "skipped if process.platform === 'win32'" });
    expect(skipDeclarationOf(['describe.runIf(HAS_REAL_SANDBOX && f(a, b))(', "  'a sandbox',"], 1)).toEqual({ kind: 'conditional', reason: 'runs only if HAS_REAL_SANDBOX && f(a, b)' });
  });

  it('takes a note given to the skip of the context as its reason', () => {
    expect(ledgerOf([{ file: 'a.test.ts', name: 'a', note: 'bun is missing', declaration: { kind: 'none' } }])).toEqual({ lines: ['a.test.ts > a: bun is missing'], unreasoned: [] });
  });

  it('fails a skip declared with no reason: a bare skip, a todo or a context skip with no note', () => {
    expect(skipDeclarationOf(["    it.skip(title, () => undefined);"], 0)).toEqual({ kind: 'bare' });
    expect(skipDeclarationOf(["  it.todo('later');"], 0)).toEqual({ kind: 'bare' });
    const ledger = ledgerOf([
      { file: 'a.test.ts', name: 'bare', note: undefined, declaration: { kind: 'bare' } },
      { file: 'b.test.ts', name: 'inside', note: undefined, declaration: { kind: 'none' } },
    ]);
    expect(ledger.unreasoned).toEqual(['a.test.ts > bare', 'b.test.ts > inside']);
  });

  it('leaves out a test the run did not select, which is no skip of the test', () => {
    expect(skipDeclarationOf(["  it('a plain test', () => {"], 0)).toEqual({ kind: 'none' });
    expect(ledgerOf([{ file: 'a.test.ts', name: 'a', note: undefined, declaration: { kind: 'unselected' } }])).toEqual({ lines: [], unreasoned: [] });
  });
});
