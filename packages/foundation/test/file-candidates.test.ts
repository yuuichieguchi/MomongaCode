import { describe, expect, it } from 'vitest';
import { directoryEntriesOf } from '@momonga/foundation';

describe('the entries of a directory from its file list', () => {
  it('reduces each path to its first component', () => {
    expect(directoryEntriesOf(['b.ts', 'lib/x.ts', 'lib/y/z.ts', 'a.ts'])).toEqual(['a.ts', 'b.ts', 'lib/']);
  });
});
