import { describe, expect, it } from 'vitest';
import { bashDescriptionOf } from '../../src/builtins/bash.ts';

describe('the Bash description follows the network scopes the sandbox enforces', () => {
  it('offers hosts only where the sandbox enforces them', () => {
    expect(bashDescriptionOf(['none', 'hosts', 'open']).description).toContain('{"hosts"');
    expect(bashDescriptionOf(['none', 'hosts', 'open']).conciseDescription).toContain('{"hosts"');
    const withoutHosts = bashDescriptionOf(['none', 'open']);
    expect(withoutHosts.description).not.toContain('hosts');
    expect(withoutHosts.conciseDescription).not.toContain('hosts');
    expect(withoutHosts.description).toContain('"open"');
  });
});
