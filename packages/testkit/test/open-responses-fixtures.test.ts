import { describe, expect, it } from 'vitest';
import { createOpenResponsesValidator, responseResource, textResponseEvents, usageOf } from '@momonga/testkit';

const validator = createOpenResponsesValidator();

describe('createOpenResponsesValidator', () => {
  it('derives the stream event type to component table from the vendored spec', () => {
    const names = validator.streamEventSchemaNames();
    expect(names.get('response.created')).toBe('ResponseCreatedStreamingEvent');
    expect(names.get('response.output_text.delta')).toBe('ResponseOutputTextDeltaStreamingEvent');
    expect(names.get('error')).toBe('ErrorStreamingEvent');
    expect(names.size).toBe(24);
  });

  it('rejects an instance that violates a component', () => {
    const check = validator.validate('ResponseResource', { id: 'resp_1' });
    expect(check.valid).toBe(false);
    expect(check.errors.length).toBeGreaterThan(0);
  });

  it('throws a clear error for an unknown component name', () => {
    expect(() => validator.validate('NoSuchComponent', {})).toThrow(/no component schema named NoSuchComponent/);
  });
});

describe('Open Responses fixtures', () => {
  it('builds a ResponseResource accepted by the vendored schema', () => {
    const check = validator.validate('ResponseResource', responseResource({ id: 'resp_1', model: 'm', status: 'completed', usage: usageOf(2, 3) }));
    expect(check.errors).toEqual([]);
  });

  it('builds a text event sequence whose every event matches its component', () => {
    const events = textResponseEvents({ model: 'm', chunks: ['Hel', 'lo'] });
    const names = validator.streamEventSchemaNames();
    for (const event of events) {
      const name = names.get(event.type);
      expect(name, event.type).toBeDefined();
      expect(validator.validate(name as string, event).errors, event.type).toEqual([]);
    }
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('computes total_tokens as the sum of input and output', () => {
    expect(usageOf(7, 5)).toEqual({
      input_tokens: 7,
      output_tokens: 5,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });
});
