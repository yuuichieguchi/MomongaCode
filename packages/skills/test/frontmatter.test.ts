import { describe, expect, it } from 'vitest';
import { parseSkillFile } from '@momonga/skills';

const parsed = (text: string) => {
  const result = parseSkillFile(text);
  if (result.kind !== 'parsed') throw new Error(`expected a parsed skill file, got ${result.reason}`);
  return result;
};

describe('parseSkillFile', () => {
  it('reads the fields and trims the body', () => {
    const result = parsed('---\nname: pdf\ndescription: Extract text\nlicense: MIT\nmetadata:\n  author: me\n---\n\n# Title\n\nBody\n\n');
    expect(result.fields).toEqual({ name: 'pdf', description: 'Extract text', license: 'MIT', metadata: { author: 'me' } });
    expect(result.body).toBe('# Title\n\nBody');
  });

  it('accepts a byte order mark and CRLF line endings', () => {
    const result = parsed('\uFEFF---\r\nname: pdf\r\ndescription: Extract text\r\n---\r\nBody\r\n');
    expect(result.fields).toEqual({ name: 'pdf', description: 'Extract text' });
    expect(result.body).toBe('Body');
  });

  it('keeps a value that contains a colon', () => {
    const result = parsed('---\nname: pdf\ndescription: Use this skill when: the user asks about PDFs\n---\nBody');
    expect(result.fields['description']).toBe('Use this skill when: the user asks about PDFs');
  });

  it('keeps colons in nested values and leaves valid quoting alone', () => {
    const result = parsed('---\nname: pdf\ndescription: "Already: quoted"\nmetadata:\n  note: first: second\n---\nBody');
    expect(result.fields).toEqual({ name: 'pdf', description: 'Already: quoted', metadata: { note: 'first: second' } });
  });

  it('does not rewrite block scalar content while repairing', () => {
    const result = parsed('---\nname: pdf\nnote: has: colon\ndescription: |\n  keep: this\n  as written\n---\nBody');
    expect(result.fields['description']).toBe('keep: this\nas written\n');
    expect(result.fields['note']).toBe('has: colon');
  });

  it('keeps a value with an embedded quote and backslash after repair', () => {
    const result = parsed('---\nname: pdf\ndescription: say "hi": path C:\\tmp\n---\nBody');
    expect(result.fields['description']).toBe('say "hi": path C:\\tmp');
  });

  it('accepts an empty frontmatter block', () => {
    expect(parsed('---\n---\nBody').fields).toEqual({});
  });

  it('rejects a file without frontmatter', () => {
    expect(parseSkillFile('# Just markdown')).toMatchObject({ kind: 'invalid' });
  });

  it('rejects an unterminated frontmatter block', () => {
    expect(parseSkillFile('---\nname: pdf\ndescription: x\n')).toMatchObject({ kind: 'invalid' });
  });

  it('rejects YAML that stays broken after the colon repair', () => {
    const result = parseSkillFile('---\nname: pdf\ndescription: [unclosed\n---\nBody');
    expect(result).toMatchObject({ kind: 'invalid' });
    expect(result.kind === 'invalid' && result.reason).toContain('not valid YAML');
  });

  it('rejects duplicate keys', () => {
    expect(parseSkillFile('---\nname: a\nname: b\ndescription: x\n---\n')).toMatchObject({ kind: 'invalid' });
  });

  it('rejects an alias bomb as invalid YAML instead of throwing', () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (const [previous, next] of [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']] as const) {
      levels.push(`${next}: &${next} [${Array.from({ length: 10 }, () => `*${previous}`).join(', ')}]`);
    }
    const result = parseSkillFile(`---\nname: pdf\ndescription: x\n${levels.join('\n')}\n---\nBody`);
    expect(result).toMatchObject({ kind: 'invalid' });
    expect(result.kind === 'invalid' && result.reason).toContain('not valid YAML');
  });

  it('rejects a frontmatter that is not a mapping', () => {
    expect(parseSkillFile('---\n- a\n- b\n---\nBody')).toMatchObject({ kind: 'invalid', reason: 'the frontmatter must be a YAML mapping' });
  });
});
