import { describe, expect, it } from 'vitest';
import { GatewayRequestError, transportFailureOf } from '../../src/gateway-client.ts';

const withCode = (code: string, message = 'socket trouble'): Error => Object.assign(new Error(message), { code });

describe('the transport rule for errors raised while talking to the gateway', () => {
  it.each(['EAGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'EHOSTUNREACH', 'ETIMEDOUT', 'SOME_FUTURE_CODE'])(
    'turns an unlisted code %s into gateway_unavailable that is not proven unsent',
    (code) => {
      const failure = transportFailureOf(withCode(code));
      expect(failure).toBeInstanceOf(GatewayRequestError);
      expect(failure).toMatchObject({ type: 'transport', code: 'gateway_unavailable' });
      expect(failure?.provenNotSent).toBe(false);
    },
  );

  it.each(['ENOENT', 'ECONNREFUSED'])('proves the request unsent for %s', (code) => {
    expect(transportFailureOf(withCode(code))).toMatchObject({ type: 'transport', code: 'gateway_unavailable', provenNotSent: true });
  });

  it('reads the code of the cause', () => {
    expect(transportFailureOf(new Error('fetch failed', { cause: withCode('EAGAIN') }))).toMatchObject({ code: 'gateway_unavailable', provenNotSent: false });
  });

  it('leaves an error without a system or undici code to the caller', () => {
    expect(transportFailureOf(new Error('the parser blew up'))).toBeUndefined();
    expect(transportFailureOf('cancel')).toBeUndefined();
  });
});
