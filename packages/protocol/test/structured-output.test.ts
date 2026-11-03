import { describe, expect, it } from 'vitest';
import { requireStructuredOutput } from '@momonga/protocol';

describe('requireStructuredOutput', () => {
  it('accepts an alias whose target holds a json schema', () => {
    expect(requireStructuredOutput({ structuredOutput: 'json_schema' }, 'models.roles.reflection', 'cheap')).toEqual({ ok: true });
  });

  it('refuses an alias without structured output, naming the setting, the alias and the capability', () => {
    const verdict = requireStructuredOutput({ structuredOutput: 'none' }, 'models.roles.analysis', 'plain');
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining('models.roles.analysis') });
    expect(verdict.ok ? '' : verdict.reason).toContain('plain');
    expect(verdict.ok ? '' : verdict.reason).toContain('structured output');
  });
});
