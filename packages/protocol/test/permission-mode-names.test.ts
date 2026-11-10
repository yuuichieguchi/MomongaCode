import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, PERMISSION_MODE_DESCRIPTIONS, RUN_API_SCHEMAS } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
for (const schema of Object.values(RUN_API_SCHEMAS as Record<string, Record<string, unknown>>)) if (typeof schema['$id'] === 'string') ajv.addSchema(schema);

const accepts = (name: string, value: unknown): boolean => {
  const schema = (RUN_API_SCHEMAS as Record<string, Record<string, unknown>>)[name];
  if (schema === undefined) throw new Error(`RUN_API_SCHEMAS has no ${name}`);
  const validate = typeof schema['$id'] === 'string' ? ajv.getSchema(schema['$id']) : ajv.compile(schema);
  if (validate === undefined) throw new Error(`no validator for ${name}`);
  return validate(value) === true;
};

describe('the mode names (design 8.1)', () => {
  it('are manual, acceptEdits, plan, auto and bypassPermissions; default is no mode name', () => {
    expect(PERMISSION_MODES).toEqual(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  });

  it('says what each mode does once, in one table next to the names', () => {
    expect(PERMISSION_MODE_DESCRIPTIONS).toEqual({
      manual: 'asks before every file change and command',
      acceptEdits: 'accepts file edits inside the workspace, asks before commands',
      plan: 'read-only tools, the agent proposes a plan',
      auto: 'an automatic classifier decides which calls are allowed',
      bypassPermissions: 'runs every tool without asking',
    });
  });

  it('are the only words the wire accepts for a session mode', () => {
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, permissionMode: 'manual' })).toBe(true);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, permissionMode: 'default' })).toBe(false);
    expect(accepts('PatchSessionRequest', { permissionMode: 'manual' })).toBe(true);
    expect(accepts('PatchSessionRequest', { permissionMode: 'default' })).toBe(false);
  });
});
