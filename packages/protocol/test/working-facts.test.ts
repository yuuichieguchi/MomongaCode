import { describe, expect, it } from 'vitest';
import { WORKING_FACTS_KEPT, WORKING_FACT_TEXT_CHARS, emptyWorkingFacts, withCommand, withMessage, withWritten } from '@momonga/protocol';

describe('commands kept in the working facts', () => {
  it('never lets successes evict an unresolved failure', () => {
    let facts = withCommand(emptyWorkingFacts(), { command: 'make lint', failed: true, exitCode: 2, seq: 1 });
    for (let index = 0; index < WORKING_FACTS_KEPT + 50; index += 1) {
      facts = withCommand(facts, { command: `echo ${index}`, failed: false, exitCode: 0, seq: index + 2 });
    }
    expect(facts.commands).toHaveLength(WORKING_FACTS_KEPT);
    expect(facts.commands.some((fact) => fact.command === 'make lint' && fact.failed)).toBe(true);
    expect(facts.commands.at(-1)?.command).toBe(`echo ${WORKING_FACTS_KEPT + 49}`);
  });

  it('evicts the oldest failure only when every kept command is a failure', () => {
    let facts = emptyWorkingFacts();
    for (let index = 0; index < WORKING_FACTS_KEPT + 1; index += 1) {
      facts = withCommand(facts, { command: `fail ${index}`, failed: true, seq: index + 1 });
    }
    expect(facts.commands).toHaveLength(WORKING_FACTS_KEPT);
    expect(facts.commands[0]?.command).toBe('fail 1');
  });
});

describe('text kept in the working facts', () => {
  const long = 'x'.repeat(WORKING_FACT_TEXT_CHARS + 500);

  it('bounds a message to the derived size and keeps its seq', () => {
    const [message] = withMessage(emptyWorkingFacts(), { text: long, seq: 7 }).messages;
    expect(message?.text).toHaveLength(WORKING_FACT_TEXT_CHARS);
    expect(message?.seq).toBe(7);
  });

  it('bounds a command and a path the same way', () => {
    expect(withCommand(emptyWorkingFacts(), { command: long, failed: true, seq: 1 }).commands[0]?.command).toHaveLength(WORKING_FACT_TEXT_CHARS);
    expect(withWritten(emptyWorkingFacts(), { path: long, seq: 1 }).written[0]?.path).toHaveLength(WORKING_FACT_TEXT_CHARS);
  });
});
