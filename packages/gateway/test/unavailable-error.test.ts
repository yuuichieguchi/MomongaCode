import { describe, expect, it } from 'vitest';
import { GatewayError } from '../src/core/errors.ts';
import { unavailableError } from '../src/core/unavailable.ts';

describe('the error a request path answers for capabilities whose tool calling is unavailable', () => {
  it('carries the status, type, code, message and param of the unavailable value', () => {
    const error = unavailableError({ state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: 'no numbers for A', param: 'model' });
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.status).toBe(412);
    expect(error.body).toEqual({ message: 'no numbers for A', type: 'invalid_request', param: 'model', code: 'capabilities_unknown' });
  });

  it('has a null param when the unavailable value names none', () => {
    const error = unavailableError({ state: 'unavailable', status: 502, type: 'server_error', code: 'adapter_error', message: 'boom' });
    expect(error.status).toBe(502);
    expect(error.body).toEqual({ message: 'boom', type: 'server_error', param: null, code: 'adapter_error' });
  });
});
