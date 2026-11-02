import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_MODE_UNAVAILABLE, PERMISSION_MODES, isUnavailableMode } from '@momonga/protocol';

const packagesDir = path.resolve(import.meta.dirname, '..', '..');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe('auto mode availability (DUP-9)', () => {
  it('names auto as the only unavailable mode', () => {
    expect(isUnavailableMode('auto')).toBe(true);
    for (const mode of PERMISSION_MODES.filter((candidate) => candidate !== 'auto')) expect(isUnavailableMode(mode)).toBe(false);
    expect(PERMISSION_MODES.filter((mode) => mode !== 'auto')).toHaveLength(4);
    expect(isUnavailableMode(undefined)).toBe(false);
  });

  it('carries the code and the message', () => {
    expect(AUTO_MODE_UNAVAILABLE).toEqual({ code: 'mode_unavailable', message: 'auto mode is not available yet' });
  });

  it('spells the message only in protocol', () => {
    const holders = fs
      .readdirSync(packagesDir)
      .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
      .flatMap((name) => sourceFiles(path.join(packagesDir, name, 'src')))
      .filter((file) => /mode is not available yet/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(packagesDir, file));
    expect(holders.length).toBeGreaterThan(0);
    expect(holders.every((file) => file.startsWith('protocol/src/'))).toBe(true);
  });
});
