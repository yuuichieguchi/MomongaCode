import { describe, expect, it } from 'vitest';
import { NO_USER_DIALECTS } from '../src/dialect/choice.ts';
import { selectDialect } from '../src/probe/select-dialect.ts';
import type { SelectionReply, SelectionRequest } from '../src/probe/select-dialect.ts';

const FINAL = '{"kind":"final","text":"hello"}';
const CALL = '{"kind":"tool_calls","calls":[{"name":"probe_forecast","arguments":{"city":"Tokyo","unit":"celsius"}}]}';

const selected = async (replyTo: (request: SelectionRequest) => string) => {
  const transport = {
    legs: { responseFormat: true, tools: false },
    request: async (request: SelectionRequest): Promise<SelectionReply> => ({ kind: 'ok', content: replyTo(request) }),
  };
  const { dialect } = await selectDialect({ transport, samples: 2, userDialects: NO_USER_DIALECTS, declaredDialect: undefined });
  return dialect.selected;
};

describe('the probe judges an envelope reply by the rule of the run-time reader', () => {
  it('accepts a reply in the order the reader reads', async () => {
    expect(await selected((request) => (request.kind === 'demanding' ? CALL : FINAL))).not.toBeNull();
  });

  it('refuses a reply with kind after another field, which the reader rejects', async () => {
    const reordered = '{"calls":[{"name":"probe_forecast","arguments":{"city":"Tokyo","unit":"celsius"}}],"kind":"tool_calls"}';
    expect(await selected((request) => (request.kind === 'demanding' ? reordered : FINAL))).toBeNull();
  });

  it('refuses a neutral reply that carries a field the reader rejects in a final reply', async () => {
    expect(await selected((request) => (request.kind === 'demanding' ? CALL : '{"kind":"final","text":"hello","calls":[]}'))).toBeNull();
  });
});
