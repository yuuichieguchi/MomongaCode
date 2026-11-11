import { describe, expect, it } from 'vitest';
import { EVENT_PAYLOAD_RENAMES, STORED_MODEL_KEYS, withCurrentNames } from '@momonga/protocol';

const renames = EVENT_PAYLOAD_RENAMES['tool.permission.classified'];

describe('a stored name that changed is read through the rename table of its record kind', () => {
  it('reads the alias of an old tool.permission.classified as its model', () => {
    if (renames === undefined) throw new Error('tool.permission.classified has no rename table');
    expect(withCurrentNames({ type: 'tool.permission.classified', callId: 'c1', subjectDigest: 'd', alias: 'local', outcome: 'ask' }, renames)).toEqual({
      type: 'tool.permission.classified',
      callId: 'c1',
      subjectDigest: 'd',
      model: 'local',
      outcome: 'ask',
    });
  });

  it('leaves a record written with the current name as it is, and prefers the current name when both are present', () => {
    if (renames === undefined) throw new Error('tool.permission.classified has no rename table');
    expect(withCurrentNames({ model: 'ollama/x:latest', outcome: 'allow' }, renames)).toEqual({ model: 'ollama/x:latest', outcome: 'allow' });
    expect(withCurrentNames({ model: 'ollama/x:latest', alias: 'local' }, renames)).toEqual({ model: 'ollama/x:latest' });
  });

  it('reads no name an object inherits as a rename', () => {
    expect(withCurrentNames({ constructor: 'kept', toString: 'kept' }, { alias: 'model' })).toEqual({ constructor: 'kept', toString: 'kept' });
  });

  it('holds the classifier rename in the event table, not among the model keys nothing reads', () => {
    expect(Object.keys(STORED_MODEL_KEYS).sort()).toEqual(['modelChanged', 'pin', 'previousModel']);
  });
});
