'use strict';
const { multipleOfOk } = require('./multiple-of');

const { compileSafe } = require('./safe-regex');
const { deferredPattern } = require('./deferred-pattern');

const PLAIN_ATOM = /(?:\\[dws\\/.^$|?*+()[\]{}-]|\[(?:[^\\\][^\ud800-\udfff]|\\[dws\\/.^$[\]-])(?:[^\\\][\ud800-\udfff]|\\[dws\\/.^$[\]-])*\]|[^\\[\](){}|*+?^$.\ud800-\udfff])(\?|[*+]|\{(\d{1,3})(?:,(\d{1,3}))?\})?/y;
function plainLinear(src) {
  const n = src.length, anchored = src[0] === '^';
  if (n > 256) return false;
  let i = anchored ? 1 : 0, choices = 1, loops = 0;
  while (i < n) {
    if (src[i] === '$' && i === n - 1) return true;
    PLAIN_ATOM.lastIndex = i;
    const m = PLAIN_ATOM.exec(src);
    if (m === null) return false;
    i = PLAIN_ATOM.lastIndex;
    const q = m[1];
    if (q === '?') choices *= 2;
    else if (q === '*' || q === '+') { if (!anchored || ++loops > 1) return false; }
    else if (q !== undefined) { const lo = +m[2], hi = m[3] === undefined ? lo : +m[3]; if (hi < lo) return false; choices *= hi - lo + 1; }
    if (choices > 64) return false;
  }
  return true;
}

const SCHEMA_KEYWORDS = {
  single: ['additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not', 'items', 'unevaluatedItems', 'unevaluatedProperties'],
  maps: ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'],
  lists: ['allOf', 'anyOf', 'oneOf', 'prefixItems'],
};

const FALLBACK_BASE = 'ata://root';

function resolveUri(base, ref) {
  try {
    return new URL(ref, base || FALLBACK_BASE).href;
  } catch {
    return ref;
  }
}

function splitFragment(uri) {
  const hash = uri.indexOf('#');
  if (hash < 0) return [uri, ''];
  return [uri.slice(0, hash), decodeURIComponent(uri.slice(hash + 1))];
}

let _collapse = null;
const collapseBranches = (args) => (_collapse || (_collapse = require('./branch-collapse').collapseBranches))(args);

function indexSchemas(rootSchema, schemaMap, flat) {
  const state = {
    resources: new Map(),
    anchors: new Map(),
    dynamicAnchors: new Map(),
    nodeBase: new Map(),
    rootBase: FALLBACK_BASE,
  };

  const rootBase =
    typeof rootSchema === 'object' && rootSchema !== null && typeof rootSchema.$id === 'string'
      ? resolveUri(FALLBACK_BASE, splitFragment(rootSchema.$id)[0])
      : FALLBACK_BASE;
  state.rootBase = rootBase;
  if (flat === true && !schemaMap && typeof rootSchema === 'object' && rootSchema !== null) {
    state.resources.set(rootBase, rootSchema);
    state.nodeBase.set(rootSchema, rootBase);
    return state;
  }
  indexResource(rootSchema, rootBase, state);

  if (schemaMap) {
    for (const [id, schema] of schemaMap) {
      const base = resolveUri(FALLBACK_BASE, splitFragment(id)[0]);
      if (!state.resources.has(base)) indexResource(schema, base, state);
      if (!state.resources.has(id)) state.resources.set(id, schema);
    }
  }
  return state;
}

function anchorMap(maps, baseUri) {
  let m = maps.get(baseUri);
  if (m === undefined) maps.set(baseUri, (m = new Map()));
  return m;
}

function indexResource(node, baseUri, state) {
  if (typeof node !== 'object' || node === null) return;
  if (!state.resources.has(baseUri)) state.resources.set(baseUri, node);
  walkSchema(node, baseUri, state, true);
}

function walkSchema(node, baseUri, state, isResourceRoot) {
  if (typeof node !== 'object' || node === null) return;
  if (state.nodeBase.has(node)) return;
  state.nodeBase.set(node, baseUri);

  if (!isResourceRoot && typeof node.$id === 'string') {
    const newBase = splitFragment(resolveUri(baseUri, node.$id))[0];
    state.nodeBase.delete(node);
    indexResource(node, newBase, state);
    return;
  }

  if (typeof node.$anchor === 'string') anchorMap(state.anchors, baseUri).set(node.$anchor, node);
  if (typeof node.$dynamicAnchor === 'string') {
    anchorMap(state.dynamicAnchors, baseUri).set(node.$dynamicAnchor, node);
    anchorMap(state.anchors, baseUri).set(node.$dynamicAnchor, node);
  }

  for (const kw of SCHEMA_KEYWORDS.single) {
    if (node[kw] !== undefined) walkSchema(node[kw], baseUri, state, false);
  }
  for (const kw of SCHEMA_KEYWORDS.maps) {
    const map = node[kw];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const key of Object.keys(map)) walkSchema(map[key], baseUri, state, false);
    }
  }
  for (const kw of SCHEMA_KEYWORDS.lists) {
    const list = node[kw];
    if (Array.isArray(list)) for (const sub of list) walkSchema(sub, baseUri, state, false);
  }
  const propDeps = node.propertyDependencies;
  if (propDeps && typeof propDeps === 'object' && !Array.isArray(propDeps)) {
    for (const choices of Object.values(propDeps)) {
      if (choices && typeof choices === 'object' && !Array.isArray(choices)) {
        for (const sub of Object.values(choices)) walkSchema(sub, baseUri, state, false);
      }
    }
  }
}

function walkPointer(root, pointer) {
  if (pointer === '' || pointer === '/') return root;
  const parts = pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = root;
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      node = node[Number(part)];
    } else if (part in node) {
      node = node[part];
    } else if (part === 'definitions' && node.$defs) {
      node = node.$defs;
    } else if (part === '$defs' && node.definitions) {
      node = node.definitions;
    } else if (part === 'items' && Array.isArray(node.prefixItems)) {
      node = node.prefixItems;
    } else {
      return undefined;
    }
  }
  return node;
}

function resolveRef(ref, fromBase, state) {
  const abs = resolveUri(fromBase, ref);
  const [uri, fragment] = splitFragment(abs);
  let resource = state.resources.get(uri);
  let resourceBase = uri;
  if (resource === undefined && (uri === FALLBACK_BASE || uri === '')) {
    resource = state.resources.get(state.rootBase);
    resourceBase = state.rootBase;
  }
  if (resource === undefined) {
    const [rawUri, rawFragment] = splitFragment(ref);
    if (state.resources.has(rawUri)) {
      resource = state.resources.get(rawUri);
      resourceBase = rawUri;
      if (rawFragment === '') return { node: resource, base: resourceBase };
      if (rawFragment.startsWith('/')) return { node: walkPointer(resource, rawFragment), base: resourceBase };
      const anchored = state.anchors.get(resourceBase);
      return { node: anchored ? anchored.get(rawFragment) : undefined, base: resourceBase };
    }
    return { node: undefined, base: resourceBase };
  }
  if (fragment === '') return { node: resource, base: resourceBase };
  if (fragment.startsWith('/')) {
    const node = walkPointer(resource, fragment);
    const base = node !== null && typeof node === 'object' && state.nodeBase.has(node) ? state.nodeBase.get(node) : resourceBase;
    return { node, base };
  }
  const anchored = state.anchors.get(resourceBase);
  return { node: anchored ? anchored.get(fragment) : undefined, base: resourceBase };
}

const { allDistinct, duplicatePair, _deq } = require('./unique-items');

function enumMember(P, data) {
  if (data === null || typeof data !== 'object') return P.enumPrims.has(data);
  const objs = P.enumObjs;
  for (let i = 0; i < objs.length; i++) if (deepEqual(objs[i], data)) return true;
  return false;
}

const deepEqual = _deq;
const propEnum = Object.prototype.propertyIsEnumerable;

function codePointLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (((s.charCodeAt(i) - 0xd800) >>> 0) < 0x400 && i + 1 < s.length) i++;
    n++;
  }
  return n;
}

function cpAtLeast(s, min) {
  if (s.length >= 2 * min) return true;
  if (s.length < min) return false;
  return codePointLength(s) >= min;
}

function cpAtMost(s, max) {
  if (s.length <= max) return true;
  if (s.length > 2 * max + 1) return false;
  return codePointLength(s) <= max;
}

function typeMatches(type, d) {
  switch (type) {
    case 'string': return typeof d === 'string';
    case 'number': return Number.isFinite(d);
    case 'integer': return typeof d === 'number' && Number.isInteger(d);
    case 'boolean': return typeof d === 'boolean';
    case 'null': return d === null;
    case 'array': return Array.isArray(d);
    case 'object': return typeof d === 'object' && d !== null && !Array.isArray(d);
    default: return true;
  }
}

const DISCARD = { props: null, items: null };

const NOERRORS = Object.freeze([]);

function mergeAnnotations(target, from) {
  if (from.props && from.props.size) {
    if (!target.props) target.props = new Set();
    for (const p of from.props) target.props.add(p);
  }
  if (from.items && from.items.size) {
    if (!target.items) target.items = new Set();
    for (const i of from.items) target.items.add(i);
  }
}

const T_STRING = 1;
const T_NUMBER = 2;
const T_INTEGER = 4;
const T_BOOLEAN = 8;
const T_NULL = 16;
const T_OBJECT = 32;
const T_ARRAY = 64;
const T_ANY = 127;

function typeBit(name) {
  switch (name) {
    case 'string': return T_STRING;
    case 'number': return T_NUMBER;
    case 'integer': return T_INTEGER;
    case 'boolean': return T_BOOLEAN;
    case 'null': return T_NULL;
    case 'object': return T_OBJECT;
    case 'array': return T_ARRAY;
    default: return T_ANY;
  }
}

function dataBits(d) {
  switch (typeof d) {
    case 'string': return T_STRING;
    case 'number':
      if (!isFinite(d)) return 0;
      return Number.isInteger(d) ? T_NUMBER | T_INTEGER : T_NUMBER;
    case 'boolean': return T_BOOLEAN;
    case 'object':
      if (d === null) return T_NULL;
      return Array.isArray(d) ? T_ARRAY : T_OBJECT;
    default: return 0;
  }
}

function isObjectMap(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const KEYWORD_RECORD = () => ({ '$ref': undefined, '$dynamicRef': undefined, type: undefined, enum: undefined, const: undefined, minimum: undefined, maximum: undefined, exclusiveMinimum: undefined, exclusiveMaximum: undefined, multipleOf: undefined, minLength: undefined, maxLength: undefined, pattern: undefined, format: undefined, minItems: undefined, maxItems: undefined, uniqueItems: undefined, prefixItems: undefined, items: undefined, contains: undefined, minContains: undefined, maxContains: undefined, required: undefined, minProperties: undefined, maxProperties: undefined, dependentRequired: undefined, propertyNames: undefined, properties: undefined, patternProperties: undefined, additionalProperties: undefined, dependentSchemas: undefined, propertyDependencies: undefined, allOf: undefined, anyOf: undefined, oneOf: undefined, not: undefined, if: undefined, then: undefined, else: undefined, unevaluatedProperties: undefined, unevaluatedItems: undefined });
function readKeywords (schema) {
  const S = KEYWORD_RECORD();
  for (const k in schema) {
    const v = schema[k];
    switch (k) {
      case '$ref': S['$ref'] = v; break;
      case '$dynamicRef': S['$dynamicRef'] = v; break;
      case 'type': S.type = v; break;
      case 'enum': S.enum = v; break;
      case 'const': S.const = v; break;
      case 'minimum': S.minimum = v; break;
      case 'maximum': S.maximum = v; break;
      case 'exclusiveMinimum': S.exclusiveMinimum = v; break;
      case 'exclusiveMaximum': S.exclusiveMaximum = v; break;
      case 'multipleOf': S.multipleOf = v; break;
      case 'minLength': S.minLength = v; break;
      case 'maxLength': S.maxLength = v; break;
      case 'pattern': S.pattern = v; break;
      case 'format': S.format = v; break;
      case 'minItems': S.minItems = v; break;
      case 'maxItems': S.maxItems = v; break;
      case 'uniqueItems': S.uniqueItems = v; break;
      case 'prefixItems': S.prefixItems = v; break;
      case 'items': S.items = v; break;
      case 'contains': S.contains = v; break;
      case 'minContains': S.minContains = v; break;
      case 'maxContains': S.maxContains = v; break;
      case 'required': S.required = v; break;
      case 'minProperties': S.minProperties = v; break;
      case 'maxProperties': S.maxProperties = v; break;
      case 'dependentRequired': S.dependentRequired = v; break;
      case 'propertyNames': S.propertyNames = v; break;
      case 'properties': S.properties = v; break;
      case 'patternProperties': S.patternProperties = v; break;
      case 'additionalProperties': S.additionalProperties = v; break;
      case 'dependentSchemas': S.dependentSchemas = v; break;
      case 'propertyDependencies': S.propertyDependencies = v; break;
      case 'allOf': S.allOf = v; break;
      case 'anyOf': S.anyOf = v; break;
      case 'oneOf': S.oneOf = v; break;
      case 'not': S.not = v; break;
      case 'if': S.if = v; break;
      case 'then': S.then = v; break;
      case 'else': S.else = v; break;
      case 'unevaluatedProperties': S.unevaluatedProperties = v; break;
      case 'unevaluatedItems': S.unevaluatedItems = v; break;
    }
  }
  return S;
}

class Plan {
  constructor(schema) {
    this.schema = schema;
  }

  link(interp) {
    const schema = this.schema;
    const S = readKeywords(schema);
    const child = (sub) => interp.node(sub);
    this.refCache = null;
    this.refBase0 = undefined;
    this.refRes0 = null;
    this.dynCache = null;
    this.ref = typeof S.$ref === 'string' ? S.$ref : null;
    this.dynamicRef = typeof S.$dynamicRef === 'string' ? S.$dynamicRef : null;
    this.tracked = this.ref !== null || this.dynamicRef !== null;

    this.typeMask = 0;
    this.typeNames = null;
    if (S.type !== undefined) {
      const types = Array.isArray(S.type) ? S.type : [S.type];
      let mask = 0;
      for (const t of types) mask |= typeBit(t);
      this.typeMask = mask;
      this.typeNames = types;
    }
    this.hasType = S.type !== undefined;
    this.enum = S.enum !== undefined ? S.enum : null;
    this.enumPrims = null;
    this.enumObjs = null;
    if (Array.isArray(this.enum)) {
      this.enumPrims = new Set();
      this.enumObjs = [];
      for (const v of this.enum) {
        if (v !== null && typeof v === 'object') this.enumObjs.push(v);
        else if (!(typeof v === 'number' && v !== v)) this.enumPrims.add(v);
      }
    }
    this.hasConst = S.const !== undefined;
    this.const = S.const;

    this.minimum = typeof S.minimum === 'number' ? S.minimum : undefined;
    this.maximum = typeof S.maximum === 'number' ? S.maximum : undefined;
    this.exclusiveMinimum = typeof S.exclusiveMinimum === 'number' ? S.exclusiveMinimum : undefined;
    this.exclusiveMaximum = typeof S.exclusiveMaximum === 'number' ? S.exclusiveMaximum : undefined;
    this.multipleOf = typeof S.multipleOf === 'number' ? S.multipleOf : undefined;
    this.hasNumber = this.minimum !== undefined || this.maximum !== undefined || this.exclusiveMinimum !== undefined || this.exclusiveMaximum !== undefined || this.multipleOf !== undefined;

    this.minLength = S.minLength;
    this.maxLength = S.maxLength;
    this.pattern = S.pattern !== undefined ? interp.pattern(S.pattern) : null;
    this.patternSource = S.pattern;
    this.format = S.format;
    this.formatFn = null;
    if (S.format !== undefined) {
      const own = Object.prototype.hasOwnProperty;
      const uf = interp.userFormats;
      const f = S.format;
      const table = require('./formats').formatChecks();
      const fc = (uf && typeof f === 'string' && own.call(uf, f) && typeof uf[f] === 'function') ? uf[f]
        : (typeof f === 'string' && own.call(table, f) && typeof table[f] === 'function' ? table[f] : null);
      this.formatFn = fc;
    }
    this.hasString = this.minLength !== undefined || this.maxLength !== undefined || this.pattern !== null || this.formatFn !== null;
    const nf = interp.numberFormats;
    this.numFormatFn = S.format !== undefined && nf !== null && typeof nf[S.format] === 'function' ? nf[S.format] : null;
    if (this.numFormatFn !== null) this.hasNumber = true;

    this.minItems = S.minItems;
    this.maxItems = S.maxItems;
    this.uniqueItems = S.uniqueItems === true;
    this.prefixItems = Array.isArray(S.prefixItems) ? S.prefixItems.map(child) : null;
    this.items = S.items !== undefined ? child(S.items) : undefined;
    this.contains = S.contains !== undefined ? child(S.contains) : undefined;
    this.minContains = S.minContains;
    this.maxContains = S.maxContains;
    this.hasArray = this.minItems !== undefined || this.maxItems !== undefined || this.uniqueItems || this.prefixItems !== null || this.items !== undefined || this.contains !== undefined;

    this.required = Array.isArray(S.required) ? S.required : null;
    this.minProperties = S.minProperties;
    this.maxProperties = S.maxProperties;
    this.dependentRequired = isObjectMap(S.dependentRequired) ? Object.entries(S.dependentRequired) : null;
    this.propertyNames = S.propertyNames !== undefined ? child(S.propertyNames) : undefined;
    this.properties = null;
    if (isObjectMap(S.properties)) {
      this.properties = new Map();
      for (const key of Object.keys(S.properties)) {
        const ek = escapePointer(key);
        this.properties.set(key, { node: child(S.properties[key]), seg: '/' + ek, schemaSeg: '/properties/' + ek });
      }
    }
    this.requiredInProps = null;
    this.requiredUndef = null;
    if (this.required !== null) {
      const undef = this.required.map((k) => this.properties === null || !this.properties.has(k));
      if (undef.includes(true)) this.requiredUndef = undef;
      if (this.properties !== null) {
        const inProps = this.required.filter((k) => this.properties.has(k));
        if (inProps.length > 0) this.requiredInProps = new Set(inProps);
      }
    }
    this.patternProperties = null;
    if (isObjectMap(S.patternProperties)) {
      this.patternProperties = Object.keys(S.patternProperties).map((src) => ({ src, re: interp.pattern(src), node: child(S.patternProperties[src]) }));
    }
    this.additionalProperties = S.additionalProperties !== undefined ? child(S.additionalProperties) : undefined;
    this.dependentSchemas = isObjectMap(S.dependentSchemas) ? Object.entries(S.dependentSchemas).map(([k, v]) => [k, child(v)]) : null;
    this.propertyDependencies = null;
    if (isObjectMap(S.propertyDependencies)) {
      this.propertyDependencies = Object.entries(S.propertyDependencies)
        .filter(([, choices]) => isObjectMap(choices))
        .map(([k, choices]) => [k, new Map(Object.keys(choices).map((v) => [v, child(choices[v])]))]);
    }
    this.hasObject = this.required !== null || this.minProperties !== undefined || this.maxProperties !== undefined || this.dependentRequired !== null || this.propertyNames !== undefined || this.properties !== null || this.patternProperties !== null || this.additionalProperties !== undefined || this.dependentSchemas !== null || this.propertyDependencies !== null;

    this.allOf = Array.isArray(S.allOf) ? S.allOf.map(child) : null;
    this.anyOf = Array.isArray(S.anyOf) ? S.anyOf.map(child) : null;
    this.oneOf = Array.isArray(S.oneOf) ? S.oneOf.map(child) : null;
    this.not = S.not !== undefined ? child(S.not) : undefined;
    this.if = S.if !== undefined ? child(S.if) : undefined;
    this.then = S.then !== undefined ? child(S.then) : undefined;
    this.else = S.else !== undefined ? child(S.else) : undefined;
    this.macros = null;
    if (interp.keywords !== null) {
      for (const key of Object.keys(schema)) {
        const def = interp.keywords[key];
        if (def === undefined || def.macro === null) continue;
        const expanded = def.macro(schema[key], schema);
        if (expanded === undefined) continue;
        if (this.macros === null) this.macros = [];
        this.macros.push({ keyword: key, node: child(expanded) });
      }
    }
    this.hasApplicators = this.allOf !== null || this.anyOf !== null || this.oneOf !== null || this.not !== undefined || this.if !== undefined || this.macros !== null;

    this.unevaluatedProperties = S.unevaluatedProperties !== undefined ? child(S.unevaluatedProperties) : undefined;
    this.unevaluatedItems = S.unevaluatedItems !== undefined ? child(S.unevaluatedItems) : undefined;
    this.unevaluatedPropertiesFalse = S.unevaluatedProperties === false;
    this.unevaluatedItemsFalse = S.unevaluatedItems === false;
    this.hasUnevaluated = this.unevaluatedProperties !== undefined || this.unevaluatedItems !== undefined;

    this.custom = null;
    if (interp.keywords !== null) {
      for (const key of Object.keys(schema)) {
        const def = interp.keywords[key];
        if (def === undefined || def.macro !== null) continue;
        const value = schema[key];
        let mask = T_ANY;
        if (def.types !== null) {
          mask = 0;
          for (const t of def.types) mask |= typeBit(t);
        }
        let fn;
        if (def.compile !== null) {
          fn = def.compile(value, schema);
          if (typeof fn !== 'function') throw new Error(`keyword "${key}": compile must return a function`);
        } else {
          const validate = def.validate;
          fn = def.dataContext ? (data, ctx) => validate(value, data, schema, ctx) : (data) => validate(value, data, schema);
          fn.source = validate;
        }
        if (this.custom === null) this.custom = [];
        this.custom.push({ keyword: key, fn, mask, ctx: def.dataContext === true, before: def.before || null, post: def.post === true });
      }
      if (this.custom !== null && this.custom.length > 1) this.custom = orderCustom(this.custom);
    }
    this.hasCustom = this.custom !== null;
    this.hasPost = this.custom !== null && this.custom.some((op) => op.post);

    const nodeBase = interp.state.nodeBase.get(schema);
    this.isResourceRoot = nodeBase !== undefined && interp.state.resources.get(nodeBase) === schema;
    this.nodeBase = this.isResourceRoot ? nodeBase : null;

    this.leaf = !this.tracked && !this.hasApplicators && !this.hasUnevaluated &&
      this.properties === null && this.patternProperties === null &&
      this.additionalProperties === undefined && this.propertyNames === undefined &&
      this.dependentSchemas === null && this.propertyDependencies === null &&
      this.prefixItems === null && this.items === undefined && this.contains === undefined &&
      this.nodeBase === null &&
      !(this.custom !== null && this.custom.some((op) => op.ctx));
  }
}

function evalLeafV(P, data) {
  const bits = dataBits(data);
  if (P.hasType && (bits & P.typeMask) === 0) return false;
  if (P.enum !== null) {
    if (!enumMember(P, data)) return false;
  }
  if (P.hasConst && !deepEqual(P.const, data)) return false;
  if (P.hasNumber && Number.isFinite(data)) {
    if (P.minimum !== undefined && !(data >= P.minimum)) return false;
    if (P.maximum !== undefined && !(data <= P.maximum)) return false;
    if (P.exclusiveMinimum !== undefined && !(data > P.exclusiveMinimum)) return false;
    if (P.exclusiveMaximum !== undefined && !(data < P.exclusiveMaximum)) return false;
    if (P.multipleOf !== undefined && !multipleOfOk(data, P.multipleOf)) return false;
    if (P.numFormatFn !== null && !P.numFormatFn(data)) return false;
  }
  if (P.hasString && bits === T_STRING) {
    if (P.minLength !== undefined && !cpAtLeast(data, P.minLength)) return false;
    if (P.maxLength !== undefined && !cpAtMost(data, P.maxLength)) return false;
    if (P.pattern !== null && !P.pattern.test(data)) return false;
    if (P.formatFn !== null && !P.formatFn(data)) return false;
  }
  if (P.hasArray && bits === T_ARRAY) {
    if (P.minItems !== undefined && data.length < P.minItems) return false;
    if (P.maxItems !== undefined && data.length > P.maxItems) return false;
    if (P.uniqueItems && !allDistinct(data)) return false;
  }
  if (P.hasObject && bits === T_OBJECT) {
    if (P.required !== null) {
      const req = P.required;
      for (let i = 0; i < req.length; i++) {
        if (!Object.hasOwn(data, req[i]) || (P.requiredUndef !== null && P.requiredUndef[i] && data[req[i]] === undefined)) return false;
      }
    }
    if (P.minProperties !== undefined && Object.keys(data).length < P.minProperties) return false;
    if (P.maxProperties !== undefined && Object.keys(data).length > P.maxProperties) return false;
    if (P.dependentRequired !== null) {
      for (const [key, deps] of P.dependentRequired) {
        if (Object.hasOwn(data, key)) {
          for (const dep of deps) if (!Object.hasOwn(data, dep)) return false;
        }
      }
    }
  }
  if (P.hasCustom && !runCustomV(P, data, bits)) return false;
  return true;
}

function orderCustom(ops) {
  const out = ops.filter((op) => !op.post);
  for (const op of ops.slice()) {
    if (op.before === null) continue;
    const at = out.indexOf(op);
    const target = out.findIndex((o) => o.keyword === op.before);
    if (at < 0 || target < 0 || at < target) continue;
    out.splice(at, 1);
    out.splice(target, 0, op);
  }
  for (const op of ops) if (op.post) out.push(op);
  return out;
}

let ctxInterp = null;
function dataCtx(instancePath, schemaPath, keyword) {
  const root = ctxInterp !== null ? ctxInterp._ctxRoot : undefined;
  if (instancePath === '') return { instancePath, parentData: undefined, parentDataProperty: undefined, rootData: root, schemaPath: schemaPath + '/' + keyword };
  const cut = instancePath.lastIndexOf('/');
  let parent = root;
  if (cut > 0) {
    const segs = instancePath.slice(1, cut).split('/');
    for (let i = 0; i < segs.length && parent !== null && typeof parent === 'object'; i++) parent = parent[segs[i].replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  let key = instancePath.slice(cut + 1).replace(/~1/g, '/').replace(/~0/g, '~');
  if (Array.isArray(parent) && /^(0|[1-9][0-9]*)$/.test(key)) key = +key;
  return { instancePath, parentData: parent, parentDataProperty: key, rootData: root, schemaPath: schemaPath + '/' + keyword };
}

function reread(ctx, data) {
  const p = ctx.parentData;
  return p !== null && typeof p === 'object' && ctx.parentDataProperty !== undefined ? p[ctx.parentDataProperty] : data;
}

function keepBranches(error, branches) {
  Object.defineProperty(error, '_branches', { value: branches });
}

function runCustomV(P, data, bits, instancePath, schemaPath) {
  const ops = P.custom;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if ((bits & op.mask) === 0) continue;
    const fn = op.fn;
    let ok;
    if (op.ctx) {
      const ctx = dataCtx(instancePath || '', schemaPath || '#', op.keyword);
      ok = fn(data, ctx);
      const now = reread(ctx, data);
      if (now !== data) { data = now; bits = dataBits(data); }
    } else ok = fn(data);
    const holder = fn.source || fn;
    if (holder.errors) holder.errors = null;
    if (!ok) return false;
  }
  return true;
}

function runCustom(P, data, bits, errors, instancePath, schemaPath, post) {
  const ops = P.custom;
  let valid = true;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if ((bits & op.mask) === 0) continue;
    if (post !== undefined && op.post !== post) continue;
    const fn = op.fn;
    let ok;
    if (op.ctx) {
      const ctx = dataCtx(instancePath, schemaPath, op.keyword);
      ok = fn(data, ctx);
      const now = reread(ctx, data);
      if (now !== data) { data = now; bits = dataBits(data); }
    } else ok = fn(data);
    const holder = fn.source || fn;
    const own = holder.errors;
    if (own) holder.errors = null;
    if (ok) continue;
    valid = false;
    if (errors === NOERRORS) return false;
    const kwPath = schemaPath + '/' + op.keyword;
    if (Array.isArray(own) && own.length > 0) {
      for (let j = 0; j < own.length; j++) {
        const e = own[j];
        errors.push(err(op.keyword, e.keyword || op.keyword,
          e.instancePath !== undefined ? (op.ctx ? e.instancePath : instancePath + e.instancePath) : instancePath,
          e.schemaPath !== undefined ? e.schemaPath : kwPath,
          e.params !== undefined ? e.params : {},
          e.message !== undefined ? e.message : `must pass "${op.keyword}" keyword validation`));
      }
    } else {
      errors.push(err(op.keyword, op.keyword, instancePath, kwPath, { keyword: op.keyword }, `must pass "${op.keyword}" keyword validation`));
    }
  }
  return valid;
}

function evalLeaf(P, data, errors, instancePath, schemaPath) {
  let valid = true;
  const schema = P.schema;
  const bits = dataBits(data);
  if (P.hasType && (bits & P.typeMask) === 0) {
    if (errors !== NOERRORS) errors.push(err('type', 'type', instancePath, schemaPath + '/type', { type: schema.type }, `must be ${P.typeNames.join(', ')}`));
    valid = false;
  }
  if (P.enum !== null) {
    if (!enumMember(P, data)) {
      if (errors !== NOERRORS) errors.push(err('enum', 'enum', instancePath, schemaPath + '/enum', { allowedValues: P.enum }, 'must be equal to one of the allowed values'));
      valid = false;
    }
  }
  if (P.hasConst && !deepEqual(P.const, data)) {
    if (errors !== NOERRORS) errors.push(err('const', 'const', instancePath, schemaPath + '/const', { allowedValue: P.const }, 'must be equal to constant'));
    valid = false;
  }
  if (P.hasNumber && Number.isFinite(data)) {
    if (P.minimum !== undefined && !(data >= P.minimum)) { errors === NOERRORS || errors.push(err('minimum', 'minimum', instancePath, schemaPath + '/minimum', { comparison: '>=', limit: P.minimum }, `must be >= ${P.minimum}`)); valid = false; }
    if (P.maximum !== undefined && !(data <= P.maximum)) { errors === NOERRORS || errors.push(err('maximum', 'maximum', instancePath, schemaPath + '/maximum', { comparison: '<=', limit: P.maximum }, `must be <= ${P.maximum}`)); valid = false; }
    if (P.exclusiveMinimum !== undefined && !(data > P.exclusiveMinimum)) { errors === NOERRORS || errors.push(err('exclusiveMinimum', 'exclusiveMinimum', instancePath, schemaPath + '/exclusiveMinimum', { comparison: '>', limit: P.exclusiveMinimum }, `must be > ${P.exclusiveMinimum}`)); valid = false; }
    if (P.exclusiveMaximum !== undefined && !(data < P.exclusiveMaximum)) { errors === NOERRORS || errors.push(err('exclusiveMaximum', 'exclusiveMaximum', instancePath, schemaPath + '/exclusiveMaximum', { comparison: '<', limit: P.exclusiveMaximum }, `must be < ${P.exclusiveMaximum}`)); valid = false; }
    if (P.multipleOf !== undefined && !multipleOfOk(data, P.multipleOf)) { errors === NOERRORS || errors.push(err('multipleOf', 'multipleOf', instancePath, schemaPath + '/multipleOf', { multipleOf: P.multipleOf }, `must be multiple of ${P.multipleOf}`)); valid = false; }
    if (P.numFormatFn !== null && !P.numFormatFn(data)) { errors === NOERRORS || errors.push(err('format', 'format', instancePath, schemaPath + '/format', { format: P.format }, `must match format "${P.format}"`)); valid = false; }
  }
  if (P.hasString && bits === T_STRING) {
    if (P.minLength !== undefined && !cpAtLeast(data, P.minLength)) { errors === NOERRORS || errors.push(err('minLength', 'minLength', instancePath, schemaPath + '/minLength', { limit: P.minLength }, `must NOT have fewer than ${P.minLength} characters`)); valid = false; }
    if (P.maxLength !== undefined && !cpAtMost(data, P.maxLength)) { errors === NOERRORS || errors.push(err('maxLength', 'maxLength', instancePath, schemaPath + '/maxLength', { limit: P.maxLength }, `must NOT have more than ${P.maxLength} characters`)); valid = false; }
    if (P.pattern !== null && !P.pattern.test(data)) { errors === NOERRORS || errors.push(err('pattern', 'pattern', instancePath, schemaPath + '/pattern', { pattern: P.patternSource }, `must match pattern "${P.patternSource}"`)); valid = false; }
    if (P.formatFn !== null && !P.formatFn(data)) { errors === NOERRORS || errors.push(err('format', 'format', instancePath, schemaPath + '/format', { format: P.format }, `must match format "${P.format}"`)); valid = false; }
  }
  if (P.hasArray && bits === T_ARRAY) {
    if (P.minItems !== undefined && data.length < P.minItems) { errors === NOERRORS || errors.push(err('minItems', 'minItems', instancePath, schemaPath + '/minItems', { limit: P.minItems }, `must NOT have fewer than ${P.minItems} items`)); valid = false; }
    if (P.maxItems !== undefined && data.length > P.maxItems) { errors === NOERRORS || errors.push(err('maxItems', 'maxItems', instancePath, schemaPath + '/maxItems', { limit: P.maxItems }, `must NOT have more than ${P.maxItems} items`)); valid = false; }
    if (P.uniqueItems) {
      const pair = duplicatePair(data);
      if (pair !== null) {
        const i = pair[0], j = pair[1];
        if (errors !== NOERRORS) errors.push(err('uniqueItems', 'uniqueItems', instancePath, schemaPath + '/uniqueItems', { i, j }, `must NOT have duplicate items (items ## ${j} and ${i} are identical)`));
        valid = false;
      }
    }
  }
  if (P.hasObject && bits === T_OBJECT) {
    const keys = Object.keys(data);
    if (P.required !== null) {
      const req = P.required;
      for (let i = 0; i < req.length; i++) {
        const key = req[i];
        if (!Object.hasOwn(data, key) || (P.requiredUndef !== null && P.requiredUndef[i] && data[key] === undefined)) { errors === NOERRORS || errors.push(err('required', 'required', instancePath, schemaPath + '/required', { missingProperty: key }, `must have required property '${key}'`)); valid = false; }
      }
    }
    if (P.minProperties !== undefined && keys.length < P.minProperties) { errors === NOERRORS || errors.push(err('minProperties', 'minProperties', instancePath, schemaPath + '/minProperties', { limit: P.minProperties }, `must NOT have fewer than ${P.minProperties} properties`)); valid = false; }
    if (P.maxProperties !== undefined && keys.length > P.maxProperties) { errors === NOERRORS || errors.push(err('maxProperties', 'maxProperties', instancePath, schemaPath + '/maxProperties', { limit: P.maxProperties }, `must NOT have more than ${P.maxProperties} properties`)); valid = false; }
    if (P.dependentRequired !== null) {
      for (const [key, deps] of P.dependentRequired) {
        if (Object.hasOwn(data, key)) {
          for (const dep of deps) {
            if (!Object.hasOwn(data, dep)) { errors === NOERRORS || errors.push(err('required', 'required', instancePath, schemaPath + '/dependentRequired', { missingProperty: dep }, `must have required property '${dep}'`)); valid = false; }
          }
        }
      }
    }
  }
  if (P.hasCustom && !runCustom(P, data, bits, errors, instancePath, schemaPath)) valid = false;
  return valid;
}

class Interpreter {
  constructor(rootSchema, options) {
    const opts = options || {};
    this.root = rootSchema;
    this.state = indexSchemas(rootSchema, opts.schemaMap, opts.flat === true);
    this.userFormats = opts.formats || null;
    this.numberFormats = opts.numberFormats && Object.keys(opts.numberFormats).length > 0 ? opts.numberFormats : null;
    this.keywords = opts.keywords || null;
    this.bookending = !opts.v1;
    this.patternCache = null;
    this.plans = new Map();
    this.rootNode = this.node(rootSchema);
    this._fast = undefined;
    this._calls = 0;
    this._tier = typeof opts.tier === 'number' ? opts.tier : TIER;
    this.dataContext = false;
    if (this.keywords !== null) for (const k of Object.keys(this.keywords)) if (this.keywords[k].dataContext) { this.dataContext = true; break; }
    this.coerce = opts.coerce === 'array' ? 'array' : opts.coerce === true;
    if (this.coerce !== false) this.dataContext = true;
    this.discriminator = opts.discriminator === true;
    this._discr = null;
    this.ext = this.coerce !== false || this.discriminator ? compatExt() : null;
    if (this.dataContext || this.discriminator || this.numberFormats !== null) this._fast = null;
    this._ctxRoot = undefined;
  }

  _fastRoot() {
    if (this._fast === undefined) {
      const compile = planCompiler();
      if (compile === null) { if (planPending) return null; this._fast = null; }
      else {
        try { this._fast = compile(this); } catch (e) {
          if (typeof process === 'object' && process !== null && process.env && process.env.ATA_DEBUG) console.error('ata: plan compiler failed, plain walk used:', e && e.message);
          this._fast = null;
        }
      }
    }
    return this._fast;
  }
  _tiered() {
    if (this._fast !== undefined) return this._fast;
    return ++this._calls > this._tier ? this._fastRoot() : null;
  }
  _deep(e) {
    if (!(e instanceof RangeError) || this._fast !== undefined) throw e;
    const fast = this._fastRoot();
    if (fast === null) throw e;
    return fast;
  }

  pattern(src) {
    if (this.patternCache === null) this.patternCache = new Map();
    let re = this.patternCache.get(src);
    if (!re) {
      if (plainLinear(src)) {
        re = new RegExp(src);
      } else {
        try {
          re = compileSafe(src);
        } catch {
          re = deferredPattern(src);
        }
      }
      this.patternCache.set(src, re);
    }
    return re;
  }

  plan(schema) {
    let p = this.plans.get(schema);
    if (p === undefined) {
      p = new Plan(schema);
      this.plans.set(schema, p);
      p.link(this);
    }
    return p;
  }

  resolveRefCached(P, base) {
    if (P.refBase0 === base) return P.refRes0;
    let cache = P.refCache;
    let r = cache !== null ? cache.get(base) : undefined;
    if (r === undefined) {
      const raw = resolveRef(P.ref, base, this.state);
      r = { child: raw.node === undefined ? undefined : this.node(raw.node), base: raw.base };
      if (P.refBase0 === undefined) { P.refBase0 = base; P.refRes0 = r; }
      else { if (cache === null) cache = P.refCache = new Map(); cache.set(base, r); }
    }
    return r;
  }

  resolveDynamicRefCached(P, base) {
    let cache = P.dynCache;
    if (cache === null) cache = P.dynCache = new Map();
    let r = cache.get(base);
    if (r === undefined) {
      const { node, base: refBase } = resolveRef(P.dynamicRef, base, this.state);
      const [, fragment] = splitFragment(resolveUri(base, P.dynamicRef));
      r = { node, base: refBase, fragment, byAnchor: Boolean(fragment) && !fragment.startsWith('/') };
      cache.set(base, r);
    }
    return r;
  }

  node(schema) {
    if (schema === true || schema === false) return schema;
    if (typeof schema !== 'object' || schema === null) return true;
    return this.plan(schema);
  }

  isValid(data) {
    if (this.dataContext) return this.validate(data).valid;
    const fast = this._fast !== undefined ? this._fast : this._tiered();
    if (fast !== null) return fast.v(data, fast.cyclic ? [] : null);
    const dynScope = [this.state.rootBase];
    try {
      return this.eval(this.rootNode, data, this.state.rootBase, dynScope, NOERRORS, '', '#', [], DISCARD);
    } catch (e) {
      const deep = this._deep(e);
      return deep.v(data, deep.cyclic ? [] : null);
    }
  }

  here(instancePath, data) {
    if (instancePath === '') return this._ctxRoot;
    const ctx = dataCtx(instancePath, '', '');
    return ctx.parentData !== null && typeof ctx.parentData === 'object' ? ctx.parentData[ctx.parentDataProperty] : data;
  }

  validate(data) {
    const fast = this._fast !== undefined ? this._fast : this._tiered();
    if (fast !== null) {
      const errors = [];
      const valid = fast.c(data, errors, '', '#', fast.cyclic ? [] : null);
      return valid ? { valid: true, data, errors: [] } : { valid: false, errors };
    }
    let errors = [];
    const dynScope = [this.state.rootBase];
    let valid;
    const outerRoot = this._ctxRoot;
    if (this.dataContext) { this._ctxRoot = data; ctxInterp = this; }
    try {
      valid = this.eval(this.rootNode, data, this.state.rootBase, dynScope, errors, '', '#', [], DISCARD);
    } catch (e) {
      if (this.dataContext) throw e;
      const deep = this._deep(e);
      errors = [];
      valid = deep.c(data, errors, '', '#', deep.cyclic ? [] : null);
    } finally {
      if (this.dataContext) this._ctxRoot = outerRoot;
    }
    return valid ? { valid: true, data, errors: [] } : { valid: false, errors };
  }

  eval(P, data, base, dynScope, errors, instancePath, schemaPath, stack, sink) {
    const E = errors !== NOERRORS || this.dataContext;
    if (P === true) return true;
    if (P === false) {
      if (errors !== NOERRORS) errors.push(err('false schema', 'not', instancePath, schemaPath, {}, 'boolean schema is false'));
      return false;
    }
    if (P.leaf && this.coerce === false) return evalLeaf(P, data, errors, instancePath, schemaPath);
    const schema = P.schema;

    const tracked = P.tracked;
    if (tracked) {
      for (let i = stack.length - 2; i >= 0; i -= 2) {
        if (stack[i] === schema && stack[i + 1] === data) return true;
      }
      stack.push(schema, data);
    }

    if (P.nodeBase !== null && P.nodeBase !== base) base = P.nodeBase;
    let scopePushed = false;
    if (dynScope[dynScope.length - 1] !== base) {
      dynScope.push(base);
      scopePushed = true;
    }

    let valid = true;
    const collect = sink !== DISCARD || P.hasUnevaluated;
    const local = collect ? { props: null, items: null } : DISCARD;

    if (this.coerce !== false && P.hasType && (dataBits(data) & P.typeMask) === 0) data = this.ext.coerceAt(this, P, data, instancePath);

    if (P.ref !== null) {
      const { child, base: refBase } = this.resolveRefCached(P, base);
      if (child === undefined) {
        if (errors !== NOERRORS) errors.push(err('$ref', '$ref', instancePath, schemaPath + '/$ref', { ref: P.ref }, `cannot resolve $ref ${P.ref}`));
        valid = false;
      } else {
        const sub = collect ? { props: null, items: null } : DISCARD;
        if (!this.eval(child, data, refBase, dynScope, errors, instancePath, schemaPath, stack, sub)) valid = false;
        else if (collect) mergeAnnotations(local, sub);
      }
    }

    if (P.dynamicRef !== null) {
      const ref = P.dynamicRef;
      const initial = this.resolveDynamicRefCached(P, base);
      let node = initial.node;
      let refBase = initial.base;
      const fragment = initial.fragment;
      if (initial.byAnchor) {
        const initialDyn = this.state.dynamicAnchors.get(refBase);
        const bookended = node !== undefined && initialDyn && initialDyn.get(fragment) === node;
        if (bookended || !this.bookending) {
          for (const scopeBase of dynScope) {
            const dyn = this.state.dynamicAnchors.get(scopeBase);
            if (dyn && dyn.has(fragment)) {
              node = dyn.get(fragment);
              refBase = scopeBase;
              break;
            }
          }
        }
      }
      if (node === undefined) {
        if (errors !== NOERRORS) errors.push(err('$dynamicRef', '$dynamicRef', instancePath, schemaPath + '/$dynamicRef', { ref }, `cannot resolve $dynamicRef ${ref}`));
        valid = false;
      } else {
        const sub = collect ? { props: null, items: null } : DISCARD;
        if (!this.eval(this.node(node), data, refBase, dynScope, errors, instancePath, schemaPath, stack, sub)) valid = false;
        else if (collect) mergeAnnotations(local, sub);
      }
    }
    if (this.coerce !== false) data = this.here(instancePath, data);

    const bits = dataBits(data);

    if (P.hasType && (bits & P.typeMask) === 0) {
      if (errors !== NOERRORS) errors.push(err('type', 'type', instancePath, schemaPath + '/type', { type: schema.type }, `must be ${P.typeNames.join(', ')}`));
      valid = false;
    }
    if (P.enum !== null) {
      if (!enumMember(P, data)) {
        if (errors !== NOERRORS) errors.push(err('enum', 'enum', instancePath, schemaPath + '/enum', { allowedValues: P.enum }, 'must be equal to one of the allowed values'));
        valid = false;
      }
    }
    if (P.hasConst && !deepEqual(P.const, data)) {
      if (errors !== NOERRORS) errors.push(err('const', 'const', instancePath, schemaPath + '/const', { allowedValue: P.const }, 'must be equal to constant'));
      valid = false;
    }

    if (P.hasNumber && Number.isFinite(data)) {
      if (P.minimum !== undefined && !(data >= P.minimum)) { errors === NOERRORS || errors.push(err('minimum', 'minimum', instancePath, schemaPath + '/minimum', { comparison: '>=', limit: P.minimum }, `must be >= ${P.minimum}`)); valid = false; }
      if (P.maximum !== undefined && !(data <= P.maximum)) { errors === NOERRORS || errors.push(err('maximum', 'maximum', instancePath, schemaPath + '/maximum', { comparison: '<=', limit: P.maximum }, `must be <= ${P.maximum}`)); valid = false; }
      if (P.exclusiveMinimum !== undefined && !(data > P.exclusiveMinimum)) { errors === NOERRORS || errors.push(err('exclusiveMinimum', 'exclusiveMinimum', instancePath, schemaPath + '/exclusiveMinimum', { comparison: '>', limit: P.exclusiveMinimum }, `must be > ${P.exclusiveMinimum}`)); valid = false; }
      if (P.exclusiveMaximum !== undefined && !(data < P.exclusiveMaximum)) { errors === NOERRORS || errors.push(err('exclusiveMaximum', 'exclusiveMaximum', instancePath, schemaPath + '/exclusiveMaximum', { comparison: '<', limit: P.exclusiveMaximum }, `must be < ${P.exclusiveMaximum}`)); valid = false; }
      if (P.multipleOf !== undefined && !multipleOfOk(data, P.multipleOf)) { errors === NOERRORS || errors.push(err('multipleOf', 'multipleOf', instancePath, schemaPath + '/multipleOf', { multipleOf: P.multipleOf }, `must be multiple of ${P.multipleOf}`)); valid = false; }
      if (P.numFormatFn !== null && !P.numFormatFn(data)) { errors === NOERRORS || errors.push(err('format', 'format', instancePath, schemaPath + '/format', { format: P.format }, `must match format "${P.format}"`)); valid = false; }
    }

    if (P.hasString && bits === T_STRING) {
      if (P.minLength !== undefined && !cpAtLeast(data, P.minLength)) { errors === NOERRORS || errors.push(err('minLength', 'minLength', instancePath, schemaPath + '/minLength', { limit: P.minLength }, `must NOT have fewer than ${P.minLength} characters`)); valid = false; }
      if (P.maxLength !== undefined && !cpAtMost(data, P.maxLength)) { errors === NOERRORS || errors.push(err('maxLength', 'maxLength', instancePath, schemaPath + '/maxLength', { limit: P.maxLength }, `must NOT have more than ${P.maxLength} characters`)); valid = false; }
      if (P.pattern !== null && !P.pattern.test(data)) { errors === NOERRORS || errors.push(err('pattern', 'pattern', instancePath, schemaPath + '/pattern', { pattern: P.patternSource }, `must match pattern "${P.patternSource}"`)); valid = false; }
      if (P.formatFn !== null && !P.formatFn(data)) { errors === NOERRORS || errors.push(err('format', 'format', instancePath, schemaPath + '/format', { format: P.format }, `must match format "${P.format}"`)); valid = false; }
    }

    if (P.hasCustom && !runCustom(P, data, bits, errors, instancePath, schemaPath, P.hasPost ? false : undefined)) valid = false;

    if (P.hasArray && bits === T_ARRAY) {
      if (P.minItems !== undefined && data.length < P.minItems) { errors === NOERRORS || errors.push(err('minItems', 'minItems', instancePath, schemaPath + '/minItems', { limit: P.minItems }, `must NOT have fewer than ${P.minItems} items`)); valid = false; }
      if (P.maxItems !== undefined && data.length > P.maxItems) { errors === NOERRORS || errors.push(err('maxItems', 'maxItems', instancePath, schemaPath + '/maxItems', { limit: P.maxItems }, `must NOT have more than ${P.maxItems} items`)); valid = false; }
      if (P.uniqueItems) {
        const pair = duplicatePair(data);
        if (pair !== null) {
          const i = pair[0], j = pair[1];
          if (errors !== NOERRORS) errors.push(err('uniqueItems', 'uniqueItems', instancePath, schemaPath + '/uniqueItems', { i, j }, `must NOT have duplicate items (items ## ${j} and ${i} are identical)`));
          valid = false;
        }
      }
      const prefix = P.prefixItems;
      if (prefix !== null) {
        const n = Math.min(prefix.length, data.length);
        for (let i = 0; i < n; i++) {
          if (!this.eval(prefix[i], data[i], base, dynScope, errors, E ? instancePath + '/' + i : '', E ? schemaPath + '/prefixItems/' + i : '', stack, DISCARD)) valid = false;
          if (collect) { if (!local.items) local.items = new Set(); local.items.add(i); }
        }
      }
      if (P.items !== undefined) {
        const start = prefix !== null ? prefix.length : 0;
        for (let i = start; i < data.length; i++) {
          if (!this.eval(P.items, data[i], base, dynScope, errors, E ? instancePath + '/' + i : '', E ? schemaPath + '/items' : '', stack, DISCARD)) valid = false;
          if (collect) { if (!local.items) local.items = new Set(); local.items.add(i); }
        }
      }
      if (P.contains !== undefined) {
        const matched = [];
        for (let i = 0; i < data.length; i++) {
          const scratch = errors === NOERRORS ? NOERRORS : [];
          if (this.eval(P.contains, data[i], base, dynScope, scratch, E ? instancePath + '/' + i : '', E ? schemaPath + '/contains' : '', stack, DISCARD)) matched.push(i);
        }
        const minC = P.minContains !== undefined ? P.minContains : 1;
        if (matched.length < minC) { errors === NOERRORS || errors.push(err('contains', 'contains', instancePath, schemaPath + '/contains', { minContains: minC }, `must contain at least ${minC} valid item(s)`)); valid = false; }
        if (P.maxContains !== undefined && matched.length > P.maxContains) { errors === NOERRORS || errors.push(err('contains', 'contains', instancePath, schemaPath + '/contains', { minContains: minC, maxContains: P.maxContains }, `must NOT contain more than ${P.maxContains} valid item(s)`)); valid = false; }
        if (collect && matched.length) {
          if (!local.items) local.items = new Set();
          for (const i of matched) local.items.add(i);
        }
      }
    }

    if (P.hasObject && bits === T_OBJECT) {
      const keys = Object.getOwnPropertyNames(data);
      let hidden = 0;
      if (P.minProperties !== undefined || P.maxProperties !== undefined) for (let k = 0; k < keys.length; k++) if (!propEnum.call(data, keys[k])) hidden++;
      if (P.required !== null) {
        const req = P.required;
        for (let i = 0; i < req.length; i++) {
          const key = req[i];
          if (!Object.hasOwn(data, key) || (P.requiredUndef !== null && P.requiredUndef[i] && data[key] === undefined)) { errors === NOERRORS || errors.push(err('required', 'required', instancePath, schemaPath + '/required', { missingProperty: key }, `must have required property '${key}'`)); valid = false; }
        }
      }
      if (P.minProperties !== undefined && keys.length - hidden < P.minProperties) { errors === NOERRORS || errors.push(err('minProperties', 'minProperties', instancePath, schemaPath + '/minProperties', { limit: P.minProperties }, `must NOT have fewer than ${P.minProperties} properties`)); valid = false; }
      if (P.maxProperties !== undefined && keys.length - hidden > P.maxProperties) { errors === NOERRORS || errors.push(err('maxProperties', 'maxProperties', instancePath, schemaPath + '/maxProperties', { limit: P.maxProperties }, `must NOT have more than ${P.maxProperties} properties`)); valid = false; }
      if (P.dependentRequired !== null) {
        for (const [key, deps] of P.dependentRequired) {
          if (Object.hasOwn(data, key)) {
            for (const dep of deps) {
              if (!Object.hasOwn(data, dep)) { errors === NOERRORS || errors.push(err('required', 'required', instancePath, schemaPath + '/dependentRequired', { missingProperty: dep }, `must have required property '${dep}'`)); valid = false; }
            }
          }
        }
      }
      if (P.propertyNames !== undefined) {
        for (const key of keys) {
          if (!propEnum.call(data, key)) continue;
          if (!this.eval(P.propertyNames, key, base, dynScope, errors, instancePath, E ? schemaPath + '/propertyNames' : '', stack, DISCARD)) valid = false;
        }
      }
      const props = P.properties;
      const patterns = P.patternProperties;
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        let evaluated = false;
        const prop = props !== null ? props.get(key) : undefined;
        const seen = prop !== undefined && patterns === null && P.additionalProperties === undefined || propEnum.call(data, key);
        if (prop !== undefined) {
          const value = data[key];
          if (value !== undefined) {
            if (!this.eval(prop.node, value, base, dynScope, errors, E ? instancePath + prop.seg : '', E ? schemaPath + prop.schemaSeg : '', stack, DISCARD)) valid = false;
          } else if (P.requiredInProps !== null && P.requiredInProps.has(key)) { errors === NOERRORS || errors.push(err('required', 'required', instancePath, schemaPath + '/required', { missingProperty: key }, `must have required property '${key}'`)); valid = false; }
          evaluated = true;
        }
        if (patterns !== null && seen) {
          for (let pi = 0; pi < patterns.length; pi++) {
            const pp = patterns[pi];
            if (pp.re.test(key)) {
              if (!this.eval(pp.node, data[key], base, dynScope, errors, E ? instancePath + '/' + escapePointer(key) : '', E ? schemaPath + '/patternProperties/' + escapePointer(pp.src) : '', stack, DISCARD)) valid = false;
              evaluated = true;
            }
          }
        }
        if (!evaluated && seen && P.additionalProperties !== undefined) {
          if (P.additionalProperties === false) {
            valid = false;
            if (errors !== NOERRORS) errors.push(err('additionalProperties', 'additionalProperties', instancePath, schemaPath + '/additionalProperties', { additionalProperty: key }, 'must NOT have additional properties'));
          } else if (!this.eval(P.additionalProperties, data[key], base, dynScope, errors, E ? instancePath + '/' + escapePointer(key) : '', E ? schemaPath + '/additionalProperties' : '', stack, DISCARD)) valid = false;
          evaluated = true;
        }
        if (evaluated && collect) {
          if (!local.props) local.props = new Set();
          local.props.add(key);
        }
      }
      if (P.dependentSchemas !== null) {
        for (const [key, dep] of P.dependentSchemas) {
          if (Object.hasOwn(data, key)) {
            const sub = collect ? { props: null, items: null } : DISCARD;
            if (!this.eval(dep, data, base, dynScope, errors, instancePath, E ? schemaPath + '/dependentSchemas/' + escapePointer(key) : '', stack, sub)) valid = false;
            else if (collect) mergeAnnotations(local, sub);
          }
        }
      }
      if (P.propertyDependencies !== null) {
        for (const [key, choices] of P.propertyDependencies) {
          if (!Object.hasOwn(data, key)) continue;
          const value = data[key];
          if (typeof value !== 'string') continue;
          const choice = choices.get(value);
          if (choice === undefined) continue;
          const sub = collect ? { props: null, items: null } : DISCARD;
          const branchPath = schemaPath + '/propertyDependencies/' + escapePointer(key) + '/' + escapePointer(value);
          if (!this.eval(choice, data, base, dynScope, errors, instancePath, branchPath, stack, sub)) valid = false;
          else if (collect) mergeAnnotations(local, sub);
        }
      }
    }

    if (P.hasApplicators) {
      if (P.allOf !== null) {
        for (let i = 0; i < P.allOf.length; i++) {
          const sub = collect ? { props: null, items: null } : DISCARD;
          if (!this.eval(P.allOf[i], data, base, dynScope, errors, instancePath, E ? schemaPath + '/allOf/' + i : '', stack, sub)) valid = false;
          else if (collect) mergeAnnotations(local, sub);
          if (this.coerce !== false) data = this.here(instancePath, data);
        }
      }
      if (P.macros !== null) {
        for (let i = 0; i < P.macros.length; i++) {
          const m = P.macros[i];
          const sp = schemaPath + '/' + m.keyword;
          const sub = collect ? { props: null, items: null } : DISCARD;
          if (!this.eval(m.node, data, base, dynScope, errors, instancePath, sp, stack, sub)) {
            valid = false;
            if (errors !== NOERRORS) errors.push(err(m.keyword, m.keyword, instancePath, sp, { keyword: m.keyword }, `must pass "${m.keyword}" keyword validation`));
          } else if (collect) mergeAnnotations(local, sub);
        }
      }
      if (P.anyOf !== null) {
        let any = false;
        const scratch = errors === NOERRORS ? NOERRORS : [];
        const branches = errors === NOERRORS ? null : [];
        for (let i = 0; i < P.anyOf.length; i++) {
          const sub = collect ? { props: null, items: null } : DISCARD;
          const mark = branches === null ? 0 : scratch.length;
          const ok = this.eval(P.anyOf[i], data, base, dynScope, scratch, instancePath, E ? schemaPath + '/anyOf/' + i : '', stack, sub);
          if (branches !== null) branches.push({ valid: ok, errors: scratch.slice(mark), title: branchTitle(P.anyOf[i]) });
          if (ok) {
            any = true;
            if (collect) mergeAnnotations(local, sub);
          }
          if (this.coerce !== false) {
            data = this.here(instancePath, data);
            if (ok && !collect) break;
          }
        }
        if (!any) {
          if (branches !== null) {
            const collapsed = collapseBranches({ keyword: 'anyOf', branchResults: branches, parentPath: instancePath, parentSchemaPath: schemaPath + '/anyOf' });
            if (collapsed !== null && this.dataContext) keepBranches(collapsed, branches);
            if (collapsed !== null) errors.push(collapsed);
          }
          valid = false;
        }
      }
      if (P.oneOf !== null && this.discriminator && this.ext.isDiscriminated(schema)) {
        if (bits === T_OBJECT && !this.ext.discriminate(this, P, data, base, dynScope, errors, instancePath, schemaPath, stack, collect ? local : DISCARD)) valid = false;
      } else if (P.oneOf !== null) {
        let count = 0;
        let winner = null;
        const scratch = errors === NOERRORS ? NOERRORS : [];
        const branches = errors === NOERRORS ? null : [];
        for (let i = 0; i < P.oneOf.length; i++) {
          const sub = collect ? { props: null, items: null } : DISCARD;
          const mark = branches === null ? 0 : scratch.length;
          const ok = this.eval(P.oneOf[i], data, base, dynScope, scratch, instancePath, E ? schemaPath + '/oneOf/' + i : '', stack, sub);
          if (this.coerce !== false) data = this.here(instancePath, data);
          if (branches !== null) branches.push({ valid: ok, errors: scratch.slice(mark), title: branchTitle(P.oneOf[i]) });
          if (ok) {
            count++;
            winner = sub;
          }
        }
        if (count === 1) { if (collect) mergeAnnotations(local, winner); }
        else {
          if (branches !== null) {
            const collapsed = collapseBranches({ keyword: 'oneOf', branchResults: branches, parentPath: instancePath, parentSchemaPath: schemaPath + '/oneOf' });
            if (collapsed !== null && this.dataContext) keepBranches(collapsed, branches);
            if (collapsed !== null) errors.push(collapsed);
          }
          valid = false;
        }
      }
      if (P.not !== undefined) {
        const scratch = errors === NOERRORS ? NOERRORS : [];
        if (this.eval(P.not, data, base, dynScope, scratch, instancePath, E ? schemaPath + '/not' : '', stack, DISCARD)) {
          if (errors !== NOERRORS) errors.push(err('not', 'not', instancePath, schemaPath + '/not', {}, 'must NOT be valid'));
          valid = false;
        }
        if (this.coerce !== false) data = this.here(instancePath, data);
      }
      if (P.if !== undefined) {
        const ifSub = collect ? { props: null, items: null } : DISCARD;
        const ifScratch = errors === NOERRORS ? NOERRORS : [];
        const ifOk = this.eval(P.if, data, base, dynScope, ifScratch, instancePath, E ? schemaPath + '/if' : '', stack, ifSub);
        if (this.coerce !== false) data = this.here(instancePath, data);
        if (ifOk) {
          if (collect) mergeAnnotations(local, ifSub);
          if (P.then !== undefined) {
            const sub = collect ? { props: null, items: null } : DISCARD;
            if (!this.eval(P.then, data, base, dynScope, errors, instancePath, E ? schemaPath + '/then' : '', stack, sub)) valid = false;
            else if (collect) mergeAnnotations(local, sub);
          }
        } else if (P.else !== undefined) {
          const sub = collect ? { props: null, items: null } : DISCARD;
          if (!this.eval(P.else, data, base, dynScope, errors, instancePath, E ? schemaPath + '/else' : '', stack, sub)) valid = false;
          else if (collect) mergeAnnotations(local, sub);
        }
      }
    }

    if (P.hasUnevaluated) {
      if (P.unevaluatedProperties !== undefined && bits === T_OBJECT) {
        for (const key of Object.keys(data)) {
          if (local.props && local.props.has(key)) continue;
          if (P.unevaluatedPropertiesFalse) {
            valid = false;
            if (errors !== NOERRORS) errors.push(err('unevaluatedProperties', 'unevaluatedProperties', instancePath, schemaPath + '/unevaluatedProperties', { unevaluatedProperty: key }, 'must NOT have unevaluated properties'));
          } else if (!this.eval(P.unevaluatedProperties, data[key], base, dynScope, errors, E ? instancePath + '/' + escapePointer(key) : '', E ? schemaPath + '/unevaluatedProperties' : '', stack, DISCARD)) valid = false;
          if (!local.props) local.props = new Set();
          local.props.add(key);
        }
      }
      if (P.unevaluatedItems !== undefined && bits === T_ARRAY) {
        for (let i = 0; i < data.length; i++) {
          if (local.items && local.items.has(i)) continue;
          if (P.unevaluatedItemsFalse) {
            valid = false;
            if (errors !== NOERRORS) errors.push(err('unevaluatedItems', 'unevaluatedItems', instancePath, schemaPath + '/unevaluatedItems', { limit: i }, 'must NOT have more than ' + i + ' items'));
            break;
          }
          if (!this.eval(P.unevaluatedItems, data[i], base, dynScope, errors, E ? instancePath + '/' + i : '', E ? schemaPath + '/unevaluatedItems' : '', stack, DISCARD)) valid = false;
          if (!local.items) local.items = new Set();
          local.items.add(i);
        }
      }
    }

    if (P.hasPost) {
      if (this.dataContext) data = this.here(instancePath, data);
      if (!runCustom(P, data, dataBits(data), errors, instancePath, schemaPath, true)) valid = false;
    }

    if (scopePushed) dynScope.pop();
    if (tracked) stack.length -= 2;
    if (valid && collect && sink !== DISCARD) mergeAnnotations(sink, local);
    return valid;
  }
}

function branchTitle (node) {
  return node && node.schema && typeof node.schema.title === 'string' ? node.schema.title : '';
}

function escapePointer(s) {
  if (typeof s !== 'string') s = String(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7e || c === 0x2f) return s.replace(/~/g, '~0').replace(/\//g, '~1');
  }
  return s;
}

function err(code, keyword, instancePath, schemaPath, params, message) {
  return { keyword, instancePath, schemaPath, params, message };
}

const TIER = 1000;
let loadPlanCompiler = null;
let compileInterpreter = null;
let planPending = false;
function setPlanCompiler(load, pending) {
  loadPlanCompiler = load;
  compileInterpreter = null;
  planPending = load === null && pending === true;
}
function planCompiler() {
  if (compileInterpreter === null && loadPlanCompiler !== null) {
    compileInterpreter = loadPlanCompiler()({
      Plan, NOERRORS, err, evalLeaf, evalLeafV, runCustomV, dataBits, escapePointer,
      deepEqual, enumMember, allDistinct, multipleOfOk, cpAtLeast, cpAtMost,
      T_STRING, T_NUMBER, T_INTEGER, T_BOOLEAN, T_NULL, T_ARRAY, T_OBJECT, resolveRef, splitFragment, resolveUri,
    }).compileInterpreter;
  }
  return compileInterpreter;
}

let installCompat = null;
let compatInstalled = null;
function setCompat(install) {
  installCompat = typeof install === 'function' ? install : install && install.default;
  compatInstalled = null;
}
function compatExt() {
  if (compatInstalled === null) {
    if (installCompat === null) throw new Error('coercion where each type is checked and the discriminator are installed by ata-validator/compat');
    compatInstalled = installCompat({ NOERRORS, DISCARD, err, mergeAnnotations, dataCtx });
  }
  return compatInstalled;
}

function createInterpreter(schema, options) {
  return new Interpreter(schema, options);
}

module.exports = { createInterpreter };
Object.defineProperty(module.exports, '_plainLinear', { value: plainLinear, enumerable: false });
Object.defineProperty(module.exports, '_setPlanCompiler', { value: setPlanCompiler, enumerable: false });
Object.defineProperty(module.exports, '_setCompat', { value: setCompat, enumerable: false });
Object.defineProperty(module.exports, '_refInternals', {
  value: { indexSchemas, resolveRef, splitFragment, resolveUri, FALLBACK_BASE },
  enumerable: false,
});
Object.defineProperty(module.exports, '_planInternals', {
  value: { Plan, deepEqual, cpAtLeast, cpAtMost, multipleOfOk, dataBits, typeBit, T_STRING, T_NUMBER, T_INTEGER, T_BOOLEAN, T_NULL, T_OBJECT, T_ARRAY, T_ANY },
  enumerable: false,
});
