import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';

const exportOf = (name: string): unknown => {
  const value = (protocol as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@momonga/protocol does not export ${name}`);
  return value;
};

const fmServer = (): Record<string, unknown> => exportOf('FM_SERVER') as Record<string, unknown>;

describe('the built-in managed server descriptions (design-managed-servers section 3)', () => {
  it('lists exactly the fm description as the built-in list', () => {
    expect(exportOf('MANAGED_SERVERS')).toEqual([fmServer()]);
  });

  it('describes fm by id, provider, wire, binary, launch argv with the socket placeholder, unix endpoint and readiness', () => {
    expect(fmServer()).toMatchObject({
      id: 'fm',
      provider: 'apple',
      wire: 'chat-completions',
      binary: { defaultPath: '/usr/bin/fm' },
      launch: { argv: ['serve', '--socket', '{socket}'] },
      endpoint: { kind: 'unix' },
      ready: { method: 'GET', path: '/health', status: 200, limitMs: 10_000 },
    });
  });

  it('describes the two fm preconditions in order with their exits, verdicts, English messages and the licence remedy', () => {
    expect(fmServer()['preconditions']).toEqual([
      {
        argv: ['license', '--status'],
        rules: [
          { exitCode: 0, verdict: 'met', message: expect.any(String) },
          { exitCode: 69, verdict: 'refused', message: 'the Apple Foundation Models licence has not been accepted', remedy: 'sudo fm license' },
          { otherExit: true, verdict: 'refused', message: 'the Apple Foundation Models licence check failed' },
        ],
      },
      {
        argv: ['available'],
        rules: [
          { exitCode: 0, verdict: 'met', message: expect.any(String) },
          { otherExit: true, verdict: 'refused', message: 'the Apple system language model is not available' },
        ],
      },
    ]);
  });

  it('keys fm by the binary hash and the host OS build, and restarts with backoff 1000 ms, 5 restarts and a 60000 ms window', () => {
    expect(fmServer()['identity']).toEqual(['binarySha256', 'hostOsBuild']);
    expect(fmServer()['restart']).toEqual({ backoffMs: 1000, maxRestarts: 5, windowMs: 60_000 });
  });

  it('lists the fm model at GET /v1/models data[0].id, takes the envelope tool form and counts tokens with count-tokens -q on stdin', () => {
    expect(fmServer()['models']).toEqual({ listPath: '/v1/models', idPath: ['data', '0', 'id'] });
    expect(fmServer()['toolForms']).toEqual(['envelope']);
    expect(fmServer()['tokenCount']).toEqual({ argv: ['count-tokens', '-q'], input: 'stdin', output: 'integer' });
  });

  it('declares contextWindow and maxOutputTokens, the recorded defaults of fm-target.ts and no sampling', () => {
    expect(fmServer()['declarable']).toEqual(['contextWindow', 'maxOutputTokens']);
    expect(fmServer()['recordedDefaults']).toEqual({ stopSequences: false, imageInput: false, tokenCounting: 'estimated', usageReported: false, maxConcurrency: 1 });
    expect(fmServer()['sampling']).toBe('none');
  });

  it('maps the three fm error texts of the chat-completions vocabulary to their kinds', () => {
    expect(fmServer()['errors']).toHaveLength(3);
    expect(fmServer()['errors']).toEqual(expect.arrayContaining([
      { message: "The model's safety guardrails were triggered.", kind: 'guardrail' },
      { message: "The session's transcript exceeded the model's context size.", kind: 'context_overflow' },
      { message: 'An unsupported generation guide was used.', kind: 'unsupported' },
    ]));
  });
});
