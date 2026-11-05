import Module from 'node:module';

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;

const loaderHost = Module as unknown as { _load: Loader };
const requested: string[] = [];
const originalLoad = loaderHost._load;
loaderHost._load = function load(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
  requested.push(request);
  return originalLoad.call(this, request, parent, isMain);
};

const dlopened: string[] = [];
const originalDlopen = process.dlopen.bind(process);
process.dlopen = ((module: { exports: unknown }, filename: string, flags?: number) => {
  dlopened.push(filename);
  return flags === undefined ? originalDlopen(module, filename) : originalDlopen(module, filename, flags);
}) as typeof process.dlopen;

const { validateUntrusted } = await import('../../src/validate-untrusted.ts');

const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false };
const accepted = validateUntrusted('child', schema, { n: 1 }).valid;
const rejected = validateUntrusted('child', schema, { n: 'one' }).valid;

const nativeModules = [...requested, ...dlopened, ...Object.keys(Module['_cache' as keyof typeof Module] ?? {})].filter(
  (entry) => entry.includes('@ata-validator/native') || entry.endsWith('.node'),
);

process.stdout.write(`${JSON.stringify({ accepted, rejected, nativeModules })}\n`);
