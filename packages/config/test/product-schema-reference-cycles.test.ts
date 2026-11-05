import { describe, expect, it } from 'vitest';
import { ataEngine, createUntrustedBoundary } from '@momonga/foundation';
import { OPEN_RESPONSES_COMPONENT_NAMES, OPEN_RESPONSES_REMOTE_DOCUMENTS, openResponsesComponentSchema } from '@momonga/protocol';
import { SETTINGS_SCHEMA } from '@momonga/config';

describe('product schemas under the reference-cycle refusal', () => {
  it('compiles the settings schema', () => {
    const boundary = createUntrustedBoundary({ remotes: new Map(), engine: ataEngine });
    expect(() => boundary.compile(SETTINGS_SCHEMA as Record<string, unknown>)).not.toThrow();
  });

  it('compiles every component of the vendored Open Responses spec', () => {
    const boundary = createUntrustedBoundary({ remotes: OPEN_RESPONSES_REMOTE_DOCUMENTS, engine: ataEngine });
    expect(OPEN_RESPONSES_COMPONENT_NAMES.length).toBeGreaterThan(0);
    const refused = OPEN_RESPONSES_COMPONENT_NAMES.filter((component) => {
      try {
        boundary.compile(openResponsesComponentSchema(component));
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toEqual([]);
  });
});
