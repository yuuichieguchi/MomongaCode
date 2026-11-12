import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_SETTING_KEYS } from '@momonga/config';
import { POLICY_OVERLAY_SCHEMA } from '../packages/eval/src/context-policy.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE = fs.readFileSync(path.join(ROOT, 'docs/reference.md'), 'utf8');
const REGISTER = fs.readFileSync(path.join(ROOT, 'packages/cli/src/commands/register.ts'), 'utf8');

type SchemaNode = { type?: string; properties?: Record<string, SchemaNode> };

const leavesOf = (node: SchemaNode, prefix: string): string[] =>
  Object.entries(node.properties ?? {}).flatMap(([name, child]) => {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    return child.type === 'object' && child.properties !== undefined ? leavesOf(child, key) : [key];
  });

const settingsHelpOf = (source: string): string => {
  const line = source.split('\n').find((entry) => entry.includes(".option('--settings <file>'"));
  if (line === undefined) throw new Error('register.ts declares no --settings option');
  return line;
};

const tableRowsOf = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('| `'));

describe('the documents name every core key (design core-on 3.5, test 10)', () => {
  it('names every key of the core list, in its full dotted form, in the --settings help text, and the overlay holds the same keys', () => {
    const help = settingsHelpOf(REGISTER);
    const missing = CORE_SETTING_KEYS.filter((key: string) => !help.includes(key));
    expect(missing).toEqual([]);
    expect(leavesOf(POLICY_OVERLAY_SCHEMA as unknown as SchemaNode, '').sort()).toEqual([...CORE_SETTING_KEYS].sort());
  });

  it('names every core key in the settings table of the reference, and no row of a core key says it is off by default', () => {
    const rows = tableRowsOf(REFERENCE);
    const missing = CORE_SETTING_KEYS.filter((key: string) => !rows.some((row) => row.includes(`\`${key}\``)));
    const saysOff = rows.filter((row) => CORE_SETTING_KEYS.some((key: string) => row.includes(`\`${key}\``)) && /default `false`|off by default/i.test(row));
    expect(missing).toEqual([]);
    expect(saysOff).toEqual([]);
  });
});
