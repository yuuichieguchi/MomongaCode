import { describe, expect, it } from 'vitest';
import { HAS_RG, RG_PATH, makeBuiltins, resultOf } from './fixtures.ts';

describe.runIf(HAS_RG)('Grep over a named binary file in content mode', () => {
  it('names the binary file that matches and keeps the records of the other files', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const binary = 'data.bin';
    tools.write(binary, 'match\0tail\n');
    tools.write('text.txt', 'match here\n');
    const result = resultOf(await tools.run('Grep', { pattern: 'match', path: binary, output_mode: 'content' }, { env: { PATH: RG_PATH, LANG: 'C' } }));
    expect(result.status).toBe('completed');
    expect(result.output).toBe(`${binary}: binary file matches; its lines are not shown`);
  });
});
