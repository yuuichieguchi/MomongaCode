import { describe, expect, it } from 'vitest';
import { decide, modelVisibleTools } from '@momonga/policy';
import type { PolicyTool } from '@momonga/policy';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn } from './helpers.ts';

const TOOLS: readonly PolicyTool[] = [
  { name: 'Read', kind: 'read', sideEffect: 'read_only' },
  { name: 'Glob', kind: 'search', sideEffect: 'read_only' },
  { name: 'Grep', kind: 'search', sideEffect: 'read_only' },
];

const kindsUnder = async (effect: 'deny' | 'ask' | 'allow', text: string, target: (project: string, outside: string) => string): Promise<string[]> => {
  const layout = makeLayout();
  const rules = [ruleIn(layout)(effect, text)];
  const kinds: string[] = [];
  for (const tool of TOOLS) {
    const decision = await decide({
      tool,
      subject: { kind: 'path', tool: tool.name, paths: [target(layout.project, layout.outside)], access: 'read' },
      mode: 'manual',
      rules,
      roots: [layout.project],
      home: layout.home,
      cwd: layout.project,
      fs: fakeFs(),
      searchPath: TEST_SEARCH_PATH,
      isWritable: isWritableFor([layout.project]),
      protectedSet: EMPTY_PROTECTED_SET,
      fileRules: await fileRulesFor(rules, [layout.project]),
    });
    kinds.push(decision.kind);
  }
  return kinds;
};

describe('a rule on Read covers the whole read family', () => {
  it.each(['Read', 'Read(**)'])('deny %s refuses Read, Glob and Grep', async (text) => {
    expect(await kindsUnder('deny', text, (project) => `${project}/a.txt`)).toEqual(['deny', 'deny', 'deny']);
  });

  it.each(['Read', 'Read(**)'])('ask %s asks for Read, Glob and Grep', async (text) => {
    expect(await kindsUnder('ask', text, (project) => `${project}/a.txt`)).toEqual(['ask', 'ask', 'ask']);
  });

  it('allow Read allows Read, Glob and Grep outside the workspace', async () => {
    expect(await kindsUnder('allow', 'Read', (_project, outside) => `${outside}/a.txt`)).toEqual(['allow', 'allow', 'allow']);
  });

  it('hides the whole family from the model under a deny rule without a specifier', () => {
    const rules = [ruleIn(makeLayout())('deny', 'Read')];

    expect(modelVisibleTools([...TOOLS], { mode: 'manual', rules })).toEqual([]);
  });
});
