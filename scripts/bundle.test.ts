import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bundle, defaultEntry } from './bundle.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempDir } from '@momonga/testkit';

const scratch = createTempDir();

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('the single-file bundle', () => {
  it(
    'carries neither the native loader nor the code-from-strings helper of ata-validator',
    async () => {
      const outfile = path.join(scratch, 'main.js');
      await bundle({ entry: defaultEntry, outfile });
      const text = fs.readFileSync(outfile, 'utf8');
      expect(text).toContain('packages/ata-validator/lib/validator-core.js');
      expect(text).toContain('context-starter');
      expect(text).not.toContain('@ata-validator/native');
      expect(text).not.toContain('packages/ata-validator/lib/native-load.js');
      expect(text).not.toContain('packages/ata-validator/lib/compile-fn.js');
    },
    UNBOUNDED_BUILD_WAIT_MS,
  );
});
