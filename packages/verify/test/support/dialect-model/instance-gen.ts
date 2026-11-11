import { clone, isObject, parsePointer, resolvePointer, type Json, type JsonObject, type Schema } from './json.ts';
import type { Rng } from './prng.ts';
import { NAMES, PATTERNS } from './schema-gen.ts';

export const UNIVERSAL_INSTANCES: readonly Json[] = [
  null, true, false, 0, 1, -1, 1.5, '', 'a', [], {}, [1], ['a'], { a: 1 }, { a: null }, { a: 'x', b: 1 }, { a: {} }, [null], [[]], 'ab', 'x',
];

interface Vocabulary {
  names: string[];
  atoms: Json[];
}

const collectVocabulary = (documents: readonly Schema[]): Vocabulary => {
  const names = new Set<string>(NAMES);
  const atoms: Json[] = [...UNIVERSAL_INSTANCES.filter((value) => typeof value !== 'object' || value === null)];
  const seen = new Set<string>(atoms.map((atom) => JSON.stringify(atom)));
  const addAtom = (value: Json): void => {
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      atoms.push(value);
    }
  };
  const visit = (value: Json | undefined, key: string | undefined): void => {
    if (typeof value === 'number') {
      addAtom(value);
      addAtom(value + 1);
      addAtom(value - 1);
      addAtom(value + 0.5);
      if (key === 'multipleOf') addAtom(value * 3);
    } else if (typeof value === 'string') {
      addAtom(value);
      if (key === 'required' || key === undefined) names.add(value);
    } else if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, key));
    } else if (isObject(value)) {
      for (const entry of Object.keys(value)) {
        if (key === 'properties' || key === 'dependentRequired' || key === 'dependentSchemas') names.add(entry);
        visit(value[entry], entry);
      }
    }
  };
  documents.forEach((document) => visit(document, undefined));
  return { names: [...names].slice(0, 40), atoms };
};

const sampleFor = (pattern: string): { matching: string[]; other: string[] } => {
  const known = PATTERNS.find((entry) => entry.pattern === pattern);
  return known ?? { matching: ['a', 'x', '1'], other: ['', 'zz'] };
};

export const createInstanceGenerator = (documents: readonly Schema[], rng: Rng) => {
  const vocabulary = collectVocabulary(documents);
  let currentDocument: Schema;

  const atom = (): Json => rng.pick(vocabulary.atoms);
  const anyValue = (depth: number): Json => {
    const roll = rng.next();
    if (roll < 0.6 || depth > 3) return atom();
    if (roll < 0.8) {
      const result: JsonObject = {};
      for (let index = rng.range(0, 3); index > 0; index -= 1) result[rng.pick(vocabulary.names)] = anyValue(depth + 1);
      return result;
    }
    return Array.from({ length: rng.range(0, 3) }, () => anyValue(depth + 1));
  };

  const resolveRef = (schema: JsonObject): Json | undefined => {
    const reference = schema['$ref'];
    if (typeof reference !== 'string') return undefined;
    const segments = parsePointer(reference);
    return segments === undefined ? undefined : resolvePointer(currentDocument, segments);
  };

  const merge = (left: Json, right: Json): Json => (isObject(left) && isObject(right) ? { ...right, ...left } : rng.chance(0.5) ? left : right);

  const generateNumber = (schema: JsonObject, integer: boolean): Json => {
    const candidates: number[] = [0, 1, -1, 2, 10];
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
      const bound = schema[key];
      if (typeof bound === 'number') candidates.push(bound, bound + 1, bound - 1, bound + 0.5, bound - 0.5);
    }
    const step = schema['multipleOf'];
    if (typeof step === 'number') for (let index = -2; index <= 4; index += 1) candidates.push(step * index, step * index + step / 2);
    const picked = rng.pick(candidates);
    return integer ? Math.round(picked) : picked;
  };

  const generateString = (schema: JsonObject): string => {
    const pattern = schema['pattern'];
    let text: string;
    if (typeof pattern === 'string') {
      const sample = sampleFor(pattern);
      text = rng.chance(0.75) ? rng.pick(sample.matching) : rng.pick(sample.other);
    } else {
      text = rng.pick(['', 'a', 'ab', 'abc', 'x', '1', 'foo', ...vocabulary.atoms.filter((value): value is string => typeof value === 'string')]);
    }
    const minimum = schema['minLength'];
    const maximum = schema['maxLength'];
    if (typeof minimum === 'number' && text.length < minimum && rng.chance(0.8)) text = text.padEnd(minimum, 'a');
    if (typeof maximum === 'number' && text.length > maximum && rng.chance(0.8)) text = text.slice(0, maximum);
    if (rng.chance(0.1)) text += 'a';
    return text;
  };

  const generateObject = (schema: JsonObject, depth: number): Json => {
    const result: JsonObject = {};
    const required = Array.isArray(schema['required']) ? schema['required'].filter((entry): entry is string => typeof entry === 'string') : [];
    const properties = isObject(schema['properties']) ? schema['properties'] : {};
    for (const name of Object.keys(properties)) {
      if (required.includes(name) ? rng.chance(0.92) : rng.chance(0.7)) result[name] = generate(properties[name], depth + 1);
    }
    for (const name of required) if (!(name in result) && rng.chance(0.9)) result[name] = anyValue(depth + 1);
    const patternProperties = schema['patternProperties'];
    if (isObject(patternProperties)) {
      for (const pattern of Object.keys(patternProperties)) {
        if (rng.chance(0.7)) {
          const sample = sampleFor(pattern);
          const key = rng.chance(0.85) ? rng.pick(sample.matching) : rng.pick(sample.other);
          result[key] = generate(patternProperties[pattern], depth + 1);
        }
      }
    }
    const additional = schema['additionalProperties'];
    const unevaluated = schema['unevaluatedProperties'];
    const extraSchema = additional !== undefined ? additional : unevaluated;
    if (extraSchema !== undefined && rng.chance(0.45)) {
      const key = rng.pick(['zz', 'extra', 'k', ...vocabulary.names]);
      if (!(key in properties)) result[key] = extraSchema === false ? anyValue(depth + 1) : generate(extraSchema, depth + 1);
    }
    const dependentRequired = schema['dependentRequired'];
    if (isObject(dependentRequired)) {
      for (const trigger of Object.keys(dependentRequired)) {
        if (rng.chance(0.5)) {
          result[trigger] = result[trigger] ?? anyValue(depth + 1);
          const targets = dependentRequired[trigger];
          if (Array.isArray(targets) && rng.chance(0.7)) for (const target of targets) if (typeof target === 'string') result[target] = result[target] ?? anyValue(depth + 1);
        }
      }
    }
    const dependentSchemas = schema['dependentSchemas'];
    if (isObject(dependentSchemas)) {
      for (const trigger of Object.keys(dependentSchemas)) {
        if (rng.chance(0.5)) {
          result[trigger] = result[trigger] ?? anyValue(depth + 1);
          const extra = generate(dependentSchemas[trigger], depth + 1);
          if (isObject(extra)) Object.assign(result, { ...extra, ...result });
        }
      }
    }
    const minimum = schema['minProperties'];
    if (typeof minimum === 'number') for (let index = 0; Object.keys(result).length < minimum && rng.chance(0.85); index += 1) result[`k${index}`] = atom();
    const maximum = schema['maxProperties'];
    if (typeof maximum === 'number') for (const key of Object.keys(result).slice(maximum)) if (rng.chance(0.8)) delete result[key];
    return result;
  };

  const generateArray = (schema: JsonObject, depth: number): Json => {
    const result: Json[] = [];
    const prefix = Array.isArray(schema['prefixItems']) ? schema['prefixItems'] : [];
    for (const entry of prefix) if (rng.chance(0.85)) result.push(generate(entry, depth + 1));
    const items = schema['items'];
    const unevaluated = schema['unevaluatedItems'];
    const rest = items !== undefined ? items : unevaluated;
    const extra = rng.range(0, 3);
    for (let index = 0; index < extra; index += 1) result.push(rest !== undefined && rest !== false ? generate(rest, depth + 1) : anyValue(depth + 1));
    const contains = schema['contains'];
    if (contains !== undefined && rng.chance(0.75)) {
      const count = rng.range(1, 3);
      for (let index = 0; index < count; index += 1) result.splice(rng.range(0, result.length), 0, generate(contains, depth + 1));
    }
    if (schema['uniqueItems'] === true && result.length > 0 && rng.chance(0.4)) result.push(clone(result[0] as Json));
    const minimum = schema['minItems'];
    if (typeof minimum === 'number') while (result.length < minimum && rng.chance(0.85)) result.push(rest !== undefined && rest !== false ? generate(rest, depth + 1) : atom());
    const maximum = schema['maxItems'];
    if (typeof maximum === 'number' && result.length > maximum && rng.chance(0.8)) result.length = maximum;
    return result;
  };

  const inferType = (schema: JsonObject): string => {
    const type = schema['type'];
    if (typeof type === 'string') return type;
    if (Array.isArray(type) && type.length > 0) return String(rng.pick(type));
    for (const key of Object.keys(schema)) {
      if (['properties', 'required', 'patternProperties', 'additionalProperties', 'propertyNames', 'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties'].includes(key)) return 'object';
      if (['items', 'prefixItems', 'contains', 'minItems', 'maxItems', 'uniqueItems', 'unevaluatedItems', 'minContains', 'maxContains'].includes(key)) return 'array';
      if (['pattern', 'minLength', 'maxLength'].includes(key)) return 'string';
      if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(key)) return 'number';
    }
    return rng.pick(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  };

  const generateOwn = (schema: JsonObject, depth: number): Json => {
    if (rng.chance(0.07)) return anyValue(depth);
    const type = inferType(schema);
    switch (type) {
      case 'object':
        return generateObject(schema, depth);
      case 'array':
        return generateArray(schema, depth);
      case 'string':
        return generateString(schema);
      case 'number':
        return generateNumber(schema, false);
      case 'integer':
        return generateNumber(schema, true);
      case 'boolean':
        return rng.chance(0.5);
      default:
        return null;
    }
  };

  const branchOf = (value: Json, depth: number): Json => {
    if (Array.isArray(value) && value.length > 0) return generate(rng.pick(value), depth + 1);
    return anyValue(depth);
  };

  const generate = (schema: Json | undefined, depth: number): Json => {
    if (depth > 6) return atom();
    if (schema === undefined || typeof schema === 'boolean') return anyValue(depth);
    if (!isObject(schema)) return atom();
    const reference = resolveRef(schema);
    if (reference !== undefined && rng.chance(0.85)) {
      const target = generate(reference, depth + 1);
      const { $ref: _reference, ...siblings } = schema;
      const own = Object.keys(siblings).length > 0 ? generateOwn(siblings, depth) : target;
      return rng.chance(0.5) ? target : merge(target, own);
    }
    if ('const' in schema && rng.chance(0.8)) return clone(schema['const'] as Json);
    if (Array.isArray(schema['enum']) && schema['enum'].length > 0 && rng.chance(0.8)) return clone(rng.pick(schema['enum']));
    let value = generateOwn(schema, depth);
    if (Array.isArray(schema['allOf']) && rng.chance(0.9)) {
      for (const entry of schema['allOf']) value = merge(value, generate(entry, depth + 1));
    }
    if (Array.isArray(schema['anyOf']) && rng.chance(0.9)) value = merge(value, branchOf(schema['anyOf'], depth));
    if (Array.isArray(schema['oneOf']) && rng.chance(0.9)) value = merge(value, branchOf(schema['oneOf'], depth));
    if ('if' in schema) {
      const condition = schema['if'] as Json;
      if (rng.chance(0.5)) {
        value = merge(generate(condition, depth + 1), value);
        if ('then' in schema && rng.chance(0.8)) value = merge(value, generate(schema['then'] as Json, depth + 1));
      } else if ('else' in schema && rng.chance(0.8)) {
        value = merge(value, generate(schema['else'] as Json, depth + 1));
      }
    }
    if ('not' in schema && rng.chance(0.5)) value = anyValue(depth);
    return value;
  };

  const mutate = (value: Json, depth: number): Json => {
    const roll = rng.next();
    if (roll < 0.15) return atom();
    if (roll < 0.22) return null;
    if (typeof value === 'number') return rng.pick([value + 1, value - 1, value + 0.5, 0, -value, value * 2]);
    if (typeof value === 'string') return rng.pick([`${value}a`, '', value.slice(1), 'x', 'ab']);
    if (typeof value === 'boolean') return !value;
    if (value === null) return atom();
    if (Array.isArray(value)) {
      const copy = value.map((entry) => clone(entry));
      const op = rng.int(5);
      if (op === 0) copy.push(copy.length > 0 ? clone(rng.pick(copy)) : atom());
      else if (op === 1) copy.pop();
      else if (op === 2 && copy.length > 0) copy[rng.int(copy.length)] = mutate(copy[rng.int(copy.length)] as Json, depth + 1);
      else if (op === 3) copy.unshift(atom());
      else copy.length = 0;
      return copy;
    }
    const copy: JsonObject = { ...(clone(value) as JsonObject) };
    const keys = Object.keys(copy);
    const op = rng.int(5);
    if (op === 0 && keys.length > 0) delete copy[rng.pick(keys)];
    else if (op === 1) copy[rng.pick(vocabulary.names)] = atom();
    else if (op === 2 && keys.length > 0) {
      const key = rng.pick(keys);
      copy[key] = mutate(copy[key] as Json, depth + 1);
    } else if (op === 3) copy[rng.pick(['zz', 'extra', 'ab', '1'])] = anyValue(depth + 1);
    else return {};
    return copy;
  };

  return {
    generate: (schema: Json | undefined): Json => {
      currentDocument = schema;
      return generate(schema, 0);
    },
    mutate: (value: Json): Json => mutate(value, 0),
    random: (): Json => anyValue(0),
  };
};

export const instancesFor = (original: Schema, rendered: Schema, rng: Rng, perDocument: number): Json[] => {
  const generator = createInstanceGenerator([original, rendered], rng);
  const instances: Json[] = UNIVERSAL_INSTANCES.map((value) => clone(value));
  for (const document of [original, rendered]) {
    for (let index = 0; index < perDocument; index += 1) {
      const base = generator.generate(document === undefined ? true : document);
      instances.push(base);
      if (rng.chance(0.7)) instances.push(generator.mutate(base));
    }
  }
  for (let index = 0; index < Math.ceil(perDocument / 2); index += 1) instances.push(generator.random());
  return instances;
};
