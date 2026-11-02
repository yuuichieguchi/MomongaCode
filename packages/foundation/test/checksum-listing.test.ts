import { describe, expect, it } from 'vitest';
import { parseChecksumListing } from '../src/checksum-listing.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('parseChecksumListing', () => {
  it('maps each name to its checksum', () => {
    expect([...parseChecksumListing(`${A}  one\n${B}  two.exe\n`, 'SHA256SUMS')]).toEqual([
      ['one', A],
      ['two.exe', B],
    ]);
  });

  it('names the listing in the error for a malformed line', () => {
    expect(() => parseChecksumListing('nonsense\n', 'SHA256SUMS')).toThrow('malformed SHA256SUMS line: nonsense');
  });

  it('rejects a single-space separator and an uppercase digest', () => {
    expect(() => parseChecksumListing(`${A} one\n`, 'X')).toThrow('malformed X line');
    expect(() => parseChecksumListing(`${'A'.repeat(64)}  one\n`, 'X')).toThrow('malformed X line');
  });
});
