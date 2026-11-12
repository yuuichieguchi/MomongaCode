import { describe, expect, it } from 'vitest';
import { fieldsOf, parseFieldInput } from '../src/elicit/form.ts';

const ORIGIN = { server: 'fx', key: 'level' };

const SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['3', '1', '2'] },
    color: { type: 'string', enum: ['red', 'green'] },
  },
};

const field = (name: string) => {
  const found = fieldsOf(SCHEMA).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no field ${name}`);
  return found;
};

describe('a value typed on the command line is matched as a value (cli-commands-C40)', () => {
  it('--set level=2 sets the value 2, not the second choice', async () => {
    expect(await parseFieldInput(ORIGIN, field('level'), '2', 'typed')).toEqual({ ok: true, value: '2' });
  });

  it('takes no position on the command line', async () => {
    expect(await parseFieldInput(ORIGIN, field('color'), '2', 'typed')).toMatchObject({ ok: false });
  });

  it('takes a position in the interactive list only when no value matches', async () => {
    expect(await parseFieldInput(ORIGIN, field('color'), '2', 'listed')).toEqual({ ok: true, value: 'green' });
    expect(await parseFieldInput(ORIGIN, field('level'), '2', 'listed')).toEqual({ ok: true, value: '2' });
  });
});
