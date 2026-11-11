import { describe, expect, it } from 'vitest';
import { productSources, relativeOf } from './support/source-scan.ts';
import fs from 'node:fs';

const OWN_ENVIRONMENT = /\bmomonga(?:Layout|Paths)\((?:[^()]|\([^()]*\))*,\s*\{\}\s*\)/;

describe('no product source gives the layout an environment of its own', () => {
  it('every call of the layout passes the environment its process holds', () => {
    const offenders = productSources().filter((file) => OWN_ENVIRONMENT.test(fs.readFileSync(file, 'utf8'))).map(relativeOf);
    expect(offenders).toEqual([]);
  });

  it('the scan sees a call that passes an empty environment', () => {
    expect(OWN_ENVIRONMENT.test("const paths = momongaPaths(await canonical(home), process.platform, {});")).toBe(true);
    expect(OWN_ENVIRONMENT.test('const paths = momongaLayout(home, platform, env);')).toBe(false);
  });
});
