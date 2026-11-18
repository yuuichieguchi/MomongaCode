import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { calleeName, lineOf, parentsOf, parseSource, parsedProductSource, productSources, relativeOf } from './support/source-scan.ts';
import type { ParsedSource, SourceNode } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const VALIDATE = 'validateUntrusted';
const COMPILE = 'compileUntrustedSchema';
const OFF_THREAD_CHECK = 'checkWithPatterns';
const ENTRIES = new Set([VALIDATE, COMPILE, 'createUntrustedBoundary', 'createUntrustedSchemaCompiler', 'evaluateWithPatternAnswers']);

const ENGINE_FILES: Readonly<Record<string, string>> = {
  'packages/foundation/src/untrusted-schema.ts': 'defines the compiler of untrusted schemas',
  'packages/foundation/src/validate-untrusted.ts': 'defines validateUntrusted and the boundary',
  'packages/foundation/src/pattern-check.ts': 'is the off-thread check itself',
  'packages/foundation/src/product-schema.ts': 'validates product schemas on the calling thread (protocol-schema 5.7); test/product-schema-patterns.test.ts proves none holds a deferred pattern',
};

const SITES_OF_PROTOCOL_SCHEMA_5_6 = [
  'packages/cli/src/elicit/form.ts',
  'packages/gateway/src/adapters/shared/response-emitter.ts',
  'packages/mcp/src/input-requests.ts',
  'packages/mcp/src/output-validation.ts',
  'packages/tools/src/builtins/jobs.ts',
  'packages/tools/src/validate.ts',
];

type Finding = { readonly file: string; readonly line: number; readonly name: string };

const isFunction = (node: SourceNode): boolean => node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';

const insideOffThreadCheck = (node: SourceNode, parents: ReadonlyMap<SourceNode, SourceNode | undefined>): boolean => {
  for (let current: SourceNode | undefined = node; current !== undefined; current = parents.get(current)) {
    const parent = parents.get(current);
    if (isFunction(current) && parent?.type === 'CallExpression' && calleeName(parent) === OFF_THREAD_CHECK && (parent['arguments'] as unknown[])[0] === current) return true;
  }
  return false;
};

const scan = (source: ParsedSource, file: string): { readonly bypasses: Finding[]; readonly checked: Finding[] } => {
  const parents = parentsOf(source);
  const bypasses: Finding[] = [];
  const checked: Finding[] = [];
  for (const { node, parent, key } of source.references) {
    const name = node['name'];
    if (typeof name !== 'string' || !ENTRIES.has(name)) continue;
    if (parent?.type === 'ExportSpecifier') continue;
    const finding = { file, line: lineOf(source, node), name };
    const isCallee = parent?.type === 'CallExpression' && key === 'callee';
    if (isCallee && name === COMPILE && parents.get(parent)?.type === 'ExpressionStatement') continue;
    if (isCallee && name === VALIDATE && insideOffThreadCheck(parent, parents)) {
      checked.push(finding);
      continue;
    }
    bypasses.push(finding);
  }
  return { bypasses, checked };
};

const productFindings = () => {
  const files = productSources().filter((file) => !(relativeOf(file) in ENGINE_FILES));
  const scans = files.map((file) => scan(parsedProductSource(file), relativeOf(file)));
  return { bypasses: scans.flatMap((result) => result.bypasses), checked: scans.flatMap((result) => result.checked) };
};

describe('every validation of an untrusted schema against a value goes through the off-thread check', () => {
  it('has no call of the validation entries outside checkWithPatterns', () => {
    expect(productFindings().bypasses).toEqual([]);
  });

  it('validates through checkWithPatterns exactly at the sites protocol-schema 5.6 names', () => {
    expect([...new Set(productFindings().checked.map((finding) => finding.file))].sort()).toEqual(SITES_OF_PROTOCOL_SCHEMA_5_6);
  });

  it.each([
    ['a direct call', "import { validateUntrusted } from '@momonga/foundation';\nexport const f = (s: object, v: unknown) => validateUntrusted('id', s, v);\n"],
    ['a call in a function given to another caller', "import { checkWithPatterns, validateUntrusted } from '@momonga/foundation';\nconst later = (run: () => unknown) => run();\nexport const f = (s: object, v: unknown) => later(() => validateUntrusted('id', s, v));\nexport const g = () => checkWithPatterns(() => true);\n"],
    ['the entry passed as a value', "import { validateUntrusted } from '@momonga/foundation';\nexport const f = [validateUntrusted];\n"],
    ['a compiled validator kept', "import { compileUntrustedSchema } from '@momonga/foundation';\nexport const f = (s: object) => compileUntrustedSchema(s);\n"],
  ])('sees %s as a bypass', (_kind, text) => {
    expect(scan(parseSource('probe.ts', text), 'probe.ts').bypasses).not.toEqual([]);
  });

  it('accepts a call inside the pass given to checkWithPatterns', () => {
    const text = "import { checkWithPatterns, validateUntrusted } from '@momonga/foundation';\nexport const f = (s: object, v: unknown) => checkWithPatterns(() => validateUntrusted('id', s, v), {});\n";
    expect(scan(parseSource('probe.ts', text), 'probe.ts')).toEqual({ bypasses: [], checked: [{ file: 'probe.ts', line: 2, name: VALIDATE }] });
  });
});
