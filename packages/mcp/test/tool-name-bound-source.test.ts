import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceOf = (file: string): string => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src', file), 'utf8');

describe('the MCP tool-name bound', () => {
  it('is the protocol constant, not a local copy', () => {
    const source = sourceOf('source.ts');
    expect(source).not.toMatch(/const MAX_TOOL_NAME_CHARS\s*=/);
    expect(source).toMatch(/import \{[^}]*MAX_TOOL_NAME_CHARS[^}]*\} from '@momonga\/protocol'/);
  });
});
