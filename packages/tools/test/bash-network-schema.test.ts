import { describe, expect, it } from 'vitest';
import { bashToolFor } from '../src/builtins/bash.ts';

const offerOf = (sandbox: 'none' | 'seatbelt' | 'bubblewrap') => ({ sandbox, sandboxNetwork: 'ask' as const, bash: { kind: 'resolved' as const, path: '/bin/bash' } });

const networkAlternativesOf = (sandbox: 'none' | 'seatbelt' | 'bubblewrap'): unknown[] => {
  const tool = bashToolFor(offerOf(sandbox) as never);
  const schema = tool.inputSchema as { properties: { network: { anyOf: unknown[] } } };
  return schema.properties.network.anyOf;
};

describe('the network parameter of the Bash input schema offers what the sandbox accepts', () => {
  it('offers no hosts shape under sandbox none, where a command cannot be held to hosts', () => {
    expect(networkAlternativesOf('none')).toEqual([{ enum: ['open'] }]);
  });

  it.each(['seatbelt', 'bubblewrap'] as const)('offers the hosts shape under %s', (sandbox) => {
    expect(networkAlternativesOf(sandbox)).toEqual([
      { enum: ['open'] },
      expect.objectContaining({ required: ['hosts'] }),
    ]);
  });
});
