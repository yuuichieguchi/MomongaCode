import { describe, expect, it } from 'vitest';
import { escapeXmlAttribute, escapeXmlText, skillContentOpenTag } from '@momonga/protocol';

describe('xml escaping', () => {
  it('escapes markup characters in text but leaves quotes alone', () => {
    expect(escapeXmlText('a <b> & "c"')).toBe('a &lt;b&gt; &amp; "c"');
  });

  it('escapes quotes as well in attribute values', () => {
    expect(escapeXmlAttribute('a "b" <c> & d')).toBe('a &quot;b&quot; &lt;c&gt; &amp; d');
  });

  it('keeps the skill tag attribute escaped through the shared helper', () => {
    expect(skillContentOpenTag('x"y')).toBe('<skill_content name="x&quot;y">');
  });
});
