import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AnyTool } from './types.ts';
import { SchemaValidatorFailure, compileUntrustedSchema, untrustedSchemaFailure } from './untrusted-schema.ts';
import { validateUntrusted } from './validate-untrusted.ts';

const MAX_REPORTED_ERRORS = 20;

const ajv = new Ajv2020.default({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
addFormats.default(ajv);

const compiled = new WeakMap<Record<string, unknown>, ValidateFunction>();

const assertOutputSchemaUsable = (tool: AnyTool): void => {
  if (tool.outputSchema === undefined) return;
  const failure = untrustedSchemaFailure(tool.outputSchema);
  if (failure !== undefined) throw new SchemaValidatorFailure(failure);
};

export const compileInputSchema = (tool: AnyTool): ValidateFunction => {
  if (tool.schemaMode === 'lenient') {
    assertOutputSchemaUsable(tool);
    return compileUntrustedSchema(tool.inputSchema);
  }
  const cached = compiled.get(tool.inputSchema);
  if (cached !== undefined) return cached;
  const validate = ajv.compile(tool.inputSchema);
  compiled.set(tool.inputSchema, validate);
  return validate;
};

const unescapePointerSegment = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~');

const renderPath = (segments: readonly string[]): string => {
  if (segments.length === 0) return '(root)';
  return segments
    .map((segment, index) => {
      if (/^\d+$/.test(segment)) return `[${segment}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join('');
};

const pathSegments = (instancePath: string): string[] =>
  instancePath === '' ? [] : instancePath.slice(1).split('/').map(unescapePointerSegment);

const describeError = (error: ErrorObject): string => {
  const segments = pathSegments(error.instancePath);
  switch (error.keyword) {
    case 'required':
      return `${renderPath([...segments, String(error.params['missingProperty'])])}: required property is missing`;
    case 'additionalProperties':
      return `${renderPath(segments)}: unknown property ${JSON.stringify(String(error.params['additionalProperty']))}`;
    case 'enum':
      return `${renderPath(segments)}: must be one of: ${(error.params['allowedValues'] as unknown[]).map(String).join(', ')}`;
    default:
      return `${renderPath(segments)}: ${error.message ?? `failed ${error.keyword}`}`;
  }
};

const describeErrors = (toolName: string, errors: readonly ErrorObject[]): string => {
  const lines = errors.slice(0, MAX_REPORTED_ERRORS).map((error) => `- ${describeError(error)}`);
  if (errors.length > MAX_REPORTED_ERRORS) lines.push(`- … ${errors.length - MAX_REPORTED_ERRORS} more errors`);
  return [`Invalid input for ${toolName}:`, ...lines].join('\n');
};

export type ValidationResult = { ok: true; value: unknown } | { ok: false; message: string } | { ok: false; message: string; validatorFailure: string };

const unavailable = (tool: AnyTool, validatorFailure: string): ValidationResult => ({
  ok: false,
  message: `Tool ${tool.name} is unavailable for the rest of this run: its schema validator failed, so its input and output cannot be checked.`,
  validatorFailure,
});

const parseArguments = (tool: AnyTool, rawArguments: unknown): ValidationResult => {
  if (typeof rawArguments !== 'string') return { ok: true, value: rawArguments };
  try {
    return { ok: true, value: JSON.parse(rawArguments) as unknown };
  } catch (error) {
    return { ok: false, message: `Invalid JSON arguments for ${tool.name}: ${(error as Error).message}\nReceived: ${rawArguments}` };
  }
};

const validateLenient = (tool: AnyTool, parsed: { ok: true; value: unknown }): ValidationResult => {
  try {
    assertOutputSchemaUsable(tool);
    const verdict = validateUntrusted(tool.inputSchema, parsed.value);
    return verdict.valid ? parsed : { ok: false, message: describeErrors(tool.name, verdict.errors) };
  } catch (error) {
    if (error instanceof SchemaValidatorFailure) return unavailable(tool, error.message);
    throw error;
  }
};

export const validateToolInput = (tool: AnyTool, rawArguments: unknown): ValidationResult => {
  const parsed = parseArguments(tool, rawArguments);
  if (!parsed.ok) return parsed;
  if (tool.schemaMode === 'lenient') return validateLenient(tool, parsed);
  const validate = compileInputSchema(tool);
  if (validate(parsed.value)) return parsed;
  return { ok: false, message: describeErrors(tool.name, validate.errors ?? []) };
};
