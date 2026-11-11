import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, base64ByteLength } from '@momonga/protocol';

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

  it('refuses data whose length is not a multiple of four in the derivation itself', () => {
    expect(() => base64ByteLength('iVBORw')).toThrow(RangeError);
  });
});
