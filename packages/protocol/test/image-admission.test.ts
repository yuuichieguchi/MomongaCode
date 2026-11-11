import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, base64ByteLength, toPublicRunEvent } from '@momonga/protocol';

const validate = new Ajv2020.default({ strict: true, allErrors: true }).compile(RUN_API_SCHEMAS.CreateRunRequest);

describe('store-protocol-C35: an image is admitted only in a form its byte length can be derived from', () => {
  it('refuses unpadded six-character data at the field images[0].data', () => {
    expect(validate({ input: 'x', images: [{ mediaType: 'image/png', data: 'iVBORw' }] })).toBe(false);
    expect(validate.errors?.map((error) => error.instancePath)).toContain('/images/0/data');
  });

  it('admits padded data and derives an integer byte length from it', () => {
    for (const [data, bytes] of [['iVBORw==', 4], ['iVBORw0=', 5], ['iVBORw0K', 6]] as const) {
      expect(validate({ input: 'x', images: [{ mediaType: 'image/png', data }] })).toBe(true);
      expect(base64ByteLength(data)).toBe(bytes);
      expect(Number.isInteger(base64ByteLength(data))).toBe(true);
    }
  });

  it('reads the length of an unpadded image admitted before the rule, so a stored event still reads', () => {
    expect(base64ByteLength('iVBORw')).toBe(4);
    expect(base64ByteLength('iVBORw0')).toBe(5);
    const event = toPublicRunEvent({ id: 1, runId: 'r', sessionId: 's', seq: 1, step: 0, leaseToken: null, createdAt: 1, type: 'user.message', text: 'x', images: [{ mediaType: 'image/png', data: 'iVBORw' }] } as never);
    expect(event).toMatchObject({ images: [{ mediaType: 'image/png', byteLength: 4 }] });
  });
});
