import { describe, expect, it } from 'vitest';
import { MIN_ROOM_TOKENS, buildContext, inputCeilingFor, itemCapFor } from '@momonga/context';
import type { InputItem } from '@momonga/protocol';
import { assistant, call, capabilitiesFor, harness, inputFor, output, sourcesWith, tokensOfItem, user } from './helpers.ts';

describe('the caps derived from the room left after the skills', () => {
  it('cap a tool output by the room that remains, not by the room the pinned layers alone leave', async () => {
    const capabilities = capabilitiesFor(8000);
    const { ports } = harness(capabilities);
    const ceiling = inputCeilingFor(capabilities);
    const bare = await buildContext(inputFor(capabilities, { sources: sourcesWith() }), ports);
    const leftover = 4 * MIN_ROOM_TOKENS;
    const skills = [{ name: 'big', content: 'x'.repeat(4 * (ceiling - bare.inputTokens - leftover)) }];
    const history = [user(1, 'start'), call(2, 'c1'), output(3, 'c1', 'line of output\n'.repeat(400)), assistant(4, 'done')];

    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ activatedSkills: skills, history, taskSeq: 1 }) }), ports);

    const floor = await buildContext(inputFor(capabilities, { sources: sourcesWith({ activatedSkills: skills }) }), ports);
    const rendered = built.input.find((item) => item.type === 'function_call_output') as InputItem;
    const roomLeft = ceiling - floor.inputTokens;
    expect(roomLeft).toBeLessThan(ceiling - bare.inputTokens);
    expect(tokensOfItem(rendered)).toBeLessThanOrEqual(itemCapFor(capabilities, roomLeft));
    expect(tokensOfItem(rendered)).toBeLessThan(itemCapFor(capabilities, ceiling - bare.inputTokens));
  });
});
