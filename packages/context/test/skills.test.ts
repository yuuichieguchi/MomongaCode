import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { InputItem } from '@momonga/protocol';
import { assistant, call, capabilitiesFor, harness, inputFor, output, sourcesWith, textOf, user } from './helpers.ts';

const WRAPPED = '<skill_content name="pdf">\nExtract text.\n\nSkill directory: /skills/pdf\n</skill_content>';
const POINTER = 'Skill pdf is active. Its instructions are kept in the protected context above.';

const texts = (items: readonly InputItem[]): string[] =>
  items.map((item) => (item.type === 'message' ? textOf(item.content) : item.type === 'function_call_output' ? textOf(item.output) : item.type));

const activation = [call(1, 'a1'), output(2, 'a1', WRAPPED), assistant(3, 'activated')];

describe('skill catalog', () => {
  it('is a developer item right after the system prompt', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ skillCatalog: '<available_skills/>' }) }), ports);
    expect(result.input[1]).toMatchObject({ type: 'message', role: 'developer', content: '<available_skills/>' });
  });

  it('is absent without a catalog', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith() }), ports);
    expect(result.input.filter((item) => item.type === 'message' && item.role === 'developer')).toEqual([]);
  });

  it('is part of the pinned digest', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const bare = await buildContext(inputFor(capabilities, { sources: sourcesWith() }), ports);
    const withCatalog = await buildContext(inputFor(capabilities, { sources: sourcesWith({ skillCatalog: 'skills' }) }), ports);
    expect(withCatalog.pinnedDigest).not.toBe(bare.pinnedDigest);
  });
});

describe('activated skills', () => {
  it('keep the pinned digest stable when a skill is activated', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const before = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: activation }) }), ports);
    const after = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: activation, activatedSkills: [{ name: 'pdf', content: WRAPPED }] }), expectedPinnedDigest: before.pinnedDigest }),
      ports,
    );
    expect(after.pinnedDigest).toBe(before.pinnedDigest);
  });

  it('replace the history copy of the activation output with a pointer', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: activation, activatedSkills: [{ name: 'pdf', content: WRAPPED }] }) }),
      ports,
    );
    const rendered = texts(result.input);
    expect(rendered.filter((text) => text.includes('Extract text.'))).toHaveLength(1);
    expect(rendered).toContain(POINTER);
    expect(rendered).toContain(`Activated skill pdf:\n${WRAPPED}`);
  });

  it('leave the history copy alone when the skill is not held', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: activation }) }), ports);
    expect(texts(result.input)).toContain(WRAPPED);
  });

  it('do not mistake another tool output for an activation', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: [call(1, 'c1'), output(2, 'c1', 'the file mentions <skill_content name="pdf"> in text')], activatedSkills: [{ name: 'pdf', content: WRAPPED }] }) }),
      ports,
    );
    expect(texts(result.input)).toContain('the file mentions <skill_content name="pdf"> in text');
  });

  it('survive a compaction of the history that carried the activation', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const filler = [call(10, 'f0'), output(11, 'f0', 'later work')];
    const result = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({
          history: [user(0, 'start'), ...activation, ...filler],
          activatedSkills: [{ name: 'pdf', content: WRAPPED }],
          summary: { item: { type: 'message', role: 'user', content: 'summary of earlier work' }, replacedThroughSeq: 3 },
        }),
      }),
      ports,
    );
    const rendered = texts(result.input);
    expect(rendered).toContain(`Activated skill pdf:\n${WRAPPED}`);
    expect(rendered).toContain('summary of earlier work');
    expect(rendered).not.toContain(POINTER);
    expect(rendered).not.toContain(WRAPPED);
  });
});
