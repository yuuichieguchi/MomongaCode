import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const errorsSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/service/errors.ts'), 'utf8');

describe('service errors status', () => {
  it('names the 503 status through the protocol constant, never the literal', () => {
    expect(errorsSource).not.toMatch(/status: 503/);
    expect(errorsSource).toMatch(/status: SERVICE_UNAVAILABLE_STATUS/);
    expect(errorsSource).toMatch(/SERVICE_UNAVAILABLE_STATUS[^\n]*from '@momonga\/protocol'|SERVICE_UNAVAILABLE_STATUS,/);
  });
});
