import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

export const OPEN_RESPONSES_SPEC_URL = new URL(
  '../../protocol/vendor/open-responses/2026-04-24/openapi.json',
  import.meta.url,
);

type SchemaObject = Record<string, unknown>;

export type OpenResponsesSpec = {
  paths: Record<string, Record<string, SchemaObject>>;
  components: { schemas: Record<string, SchemaObject> };
};

export type SchemaCheck = { valid: boolean; errors: string[] };

export type OpenResponsesValidator = {
  spec: OpenResponsesSpec;
  validate(componentName: string, value: unknown): SchemaCheck;
  streamEventSchemaNames(): Map<string, string>;
};

export const loadOpenResponsesSpec = (): OpenResponsesSpec =>
  JSON.parse(fs.readFileSync(OPEN_RESPONSES_SPEC_URL, 'utf8')) as OpenResponsesSpec;

const SPEC_ID = 'https://momonga.invalid/open-responses/2026-04-24/openapi.json';
const REF_PREFIX = '#/components/schemas/';

const asRecord = (value: unknown, where: string): SchemaObject => {
  if (typeof value !== 'object' || value === null) throw new Error(`Open Responses spec: expected an object at ${where}`);
  return value as SchemaObject;
};

const deriveStreamEventSchemaNames = (spec: OpenResponsesSpec): Map<string, string> => {
  const post = asRecord(spec.paths['/responses']?.['post'], 'paths./responses.post');
  const responses = asRecord(post['responses'], 'post.responses');
  const ok = asRecord(responses['200'], 'post.responses.200');
  const content = asRecord(ok['content'], 'post.responses.200.content');
  const stream = asRecord(content['text/event-stream'], 'text/event-stream');
  const schema = asRecord(stream['schema'], 'text/event-stream.schema');
  const variants = schema['oneOf'];
  if (!Array.isArray(variants)) throw new Error('Open Responses spec: text/event-stream schema has no oneOf');
  const names = new Map<string, string>();
  for (const variant of variants) {
    const ref = asRecord(variant, 'oneOf entry')['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) throw new Error(`Open Responses spec: unexpected stream event ref ${String(ref)}`);
    const name = ref.slice(REF_PREFIX.length);
    const component = asRecord(spec.components.schemas[name], name);
    const typeProperty = asRecord(asRecord(component['properties'], `${name}.properties`)['type'], `${name}.properties.type`);
    const values = typeProperty['enum'];
    if (!Array.isArray(values) || typeof values[0] !== 'string') throw new Error(`Open Responses spec: ${name}.type has no enum`);
    names.set(values[0], name);
  }
  return names;
};

export const createOpenResponsesValidator = (): OpenResponsesValidator => {
  const spec = loadOpenResponsesSpec();
  const ajv = new Ajv2020.default({ strict: false, allErrors: true });
  ajv.addSchema({ $id: SPEC_ID, components: spec.components });
  const eventNames = deriveStreamEventSchemaNames(spec);
  return {
    spec,
    validate: (componentName, value) => {
      if (spec.components.schemas[componentName] === undefined) {
        throw new Error(`Open Responses spec has no component schema named ${componentName}`);
      }
      const validator = ajv.getSchema(`${SPEC_ID}${REF_PREFIX}${componentName}`);
      if (validator === undefined) throw new Error(`Ajv could not compile component ${componentName}`);
      const valid = validator(value) === true;
      const errors = (validator.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`);
      return { valid, errors: valid ? [] : errors };
    },
    streamEventSchemaNames: () => new Map(eventNames),
  };
};
