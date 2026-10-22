import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';

describe('canonicalJson', () => {
  it('sorts keys recursively, keeps array order and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: [true, 'a'] })).toBe(canonicalJson({ y: [true, 'a'], x: 1 }));
  });

  it('encodes primitives like JSON', () => {
    expect(canonicalJson('a"b\n')).toBe('"a\\"b\\n"');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('rejects undefined with a clear error naming the path', () => {
    expect(() => canonicalJson({ a: { b: undefined } })).toThrow(/undefined.*a\.b|a\.b.*undefined/);
    expect(() => canonicalJson(undefined)).toThrow(/undefined/);
    expect(() => canonicalJson([1, undefined])).toThrow(/undefined/);
  });

  it('rejects functions, NaN and Infinity', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/NaN|finite/);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(/Infinity|finite/);
  });
});

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes strings as UTF-8 and bytes identically', () => {
    expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256Hex('abc'));
    expect(sha256Hex(Buffer.from('é', 'utf8'))).toBe(sha256Hex('é'));
  });
});
