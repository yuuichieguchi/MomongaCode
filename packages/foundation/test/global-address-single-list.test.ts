import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const THE_ONE_LIST = 'foundation/src/global-address.ts';

const GENERATED_BUNDLE = /\.generated\.ts$/;

type Mark = { readonly what: string; readonly pattern: RegExp };

const MARKS: readonly Mark[] = [
  { what: 'a BlockList filled with a written range', pattern: /\.add(?:Subnet|Address|Range)\(\s*['"`]/ },
  { what: 'an IPv4 range in CIDR form', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/ },
  { what: 'an IPv6 range in CIDR form', pattern: /[0-9a-f]{0,4}::(?:[0-9a-f:]*)\/\d{1,3}\b/i },
  { what: 'the base of a private, loopback, shared or link-local IPv4 range', pattern: /\b(?:10\.0\.0\.0|127\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0|169\.254\.0\.0|100\.64\.0\.0|198\.18\.0\.0|224\.0\.0\.0|240\.0\.0\.0)\b/ },
  { what: 'an IPv4 range written as octets', pattern: /\[\s*(?:10|127|172|192|169|100|198|224|240)\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\]/ },
  { what: 'the base of a private, loopback, shared or link-local IPv4 range written as a number', pattern: /\b0x(?:7f000000|0a000000|ac100000|c0a80000|a9fe0000|64400000|c6120000|e0000000|f0000000)\b/i },
  { what: 'the base of a local IPv6 range', pattern: /\b(?:fe80|fec0|fc00|fd00|ff00)::/i },
  { what: 'an IPv6 range written as a group value', pattern: /\b0x(?:fe80|fec0|fc00|ff00|ff9b|2002|ffc0|fe00)\b/i },
  { what: 'a pattern for an embedded IPv4 address', pattern: /::ffff:/i },
];

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !GENERATED_BUNDLE.test(entry.name) ? [full] : [];
  });

const productSources = (): string[] =>
  fs
    .readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(PACKAGES, entry.name, 'src')))
    .flatMap((entry) => sourceFiles(path.join(PACKAGES, entry.name, 'src')));

const marksIn = (text: string): string[] =>
  text.split('\n').flatMap((line, index) => MARKS.filter(({ pattern }) => pattern.test(line)).map(({ what }) => `${index + 1}: ${what}: ${line.trim().slice(0, 120)}`));

describe('the address ranges are written once', () => {
  const files = productSources();

  it('scans the sources of every package', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => path.relative(PACKAGES, file))).toContain(THE_ONE_LIST);
  });

  it('no source file outside the one definition writes an address range', () => {
    const second = files
      .filter((file) => path.relative(PACKAGES, file) !== THE_ONE_LIST)
      .flatMap((file) => marksIn(fs.readFileSync(file, 'utf8')).map((found) => `${path.relative(PACKAGES, file)}:${found}`));
    expect(second).toEqual([]);
  });

  it('the one definition is where the ranges are written', () => {
    const found = marksIn(fs.readFileSync(path.join(PACKAGES, THE_ONE_LIST), 'utf8'));
    expect(found.some((line) => line.includes('IPv4 range in CIDR form'))).toBe(true);
    expect(found.some((line) => line.includes('IPv6 range in CIDR form'))).toBe(true);
  });

  it.each([
    "blocked.addSubnet('10.0.0.0', 8, 'ipv4');",
    "const PRIVATE = ['192.168.0.0/16'];",
    "const LOCAL = 'fc00::/7';",
    'const RANGE = [ipv4Number([10, 0, 0, 0]), 8];',
    'if ((g0 & 0xffc0) === 0xfe80) return false;',
    'const RANGES = [[0x7f000000, 8], [0xc0a80000, 16]];',
    'const MAPPED = /^::ffff:(.+)$/i;',
    "list.addAddress('::1', 'ipv6');",
  ])('recognises %s as a second list', (line) => {
    expect(marksIn(line)).not.toEqual([]);
  });

  it.each(["const HOST = '127.0.0.1';", 'list.addSubnet(cidr, prefix, familyName(cidr));', "const url = 'http://127.0.0.1:11434/v1';", "if (address === '::1') return true;"])('does not take %s for a range list', (line) => {
    expect(marksIn(line)).toEqual([]);
  });
});
