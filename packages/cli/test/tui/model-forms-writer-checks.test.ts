import { describe, expect, it } from 'vitest';
import { baseUrlProblem, declaredCommandProblem } from '@momonga/config';
import { addressProblem } from '../../src/tui/models/add.ts';
import { programCommandProblem } from '../../src/tui/models/hub.ts';

describe('the model forms refuse what the settings writer refuses, with its words, before the confirm row (C50)', () => {
  it('refuses an address with credentials or a query, and keeps one with a path', () => {
    expect(addressProblem('http://user:pass@127.0.0.1:11434')).toBe(baseUrlProblem('http://user:pass@127.0.0.1:11434', false));
    expect(addressProblem('http://user:pass@127.0.0.1:11434')).toBeDefined();
    expect(addressProblem('http://127.0.0.1:11434/v1?x=1')).toBeDefined();
    expect(addressProblem('http://127.0.0.1:11434/v1')).toBeUndefined();
    expect(addressProblem('ftp://127.0.0.1')).toBeDefined();
  });

  it('refuses a program command that is not a full path in the program editor of the hub', () => {
    expect(programCommandProblem('llama-server')).toBe(`The command ${declaredCommandProblem('llama-server') ?? ''}`);
    expect(programCommandProblem('llama-server')).toBeDefined();
    expect(programCommandProblem('/usr/local/bin/llama-server')).toBeUndefined();
  });
});
