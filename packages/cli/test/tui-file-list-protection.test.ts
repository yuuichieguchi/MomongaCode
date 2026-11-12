import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BACKEND = path.join(import.meta.dirname, '../src/tui/backend.ts');

describe('the file list of the terminal UI', () => {
  it('starts git through the launch that denies the home, never an unprotected one', () => {
    const source = fs.readFileSync(BACKEND, 'utf8');
    expect(source).not.toContain('unprotectedLaunch');
    expect(source).toContain('hostHomeProtectedLaunch');
  });
});
