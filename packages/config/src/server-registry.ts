import path from 'node:path';
import { MANAGED_READY_LIMIT_MS, MANAGED_RESTART_POLICY, MANAGED_SERVERS, SOCKET_PLACEHOLDER } from '@momonga/protocol';
import type { ManagedEndpointForm, ManagedServerDescription } from '@momonga/protocol';
import type { DeclaredServer } from './settings.ts';

export type ServerRegistry = Readonly<Record<string, ManagedServerDescription>>;

const DEFAULT_DECLARED_ENDPOINT_FORMS: readonly ManagedEndpointForm[] = ['unix'];

const bracketed = (forms: readonly string[]): string => `[${forms.join(', ')}]`;

export const firstOfferedEndpointForm = (description: ManagedServerDescription, hostForms: readonly ManagedEndpointForm[]): ManagedEndpointForm | undefined =>
  description.endpoint.forms.find((form) => hostForms.includes(form));

export const requireOfferedEndpointForm = (description: ManagedServerDescription, hostForms: readonly ManagedEndpointForm[], where: string): ManagedEndpointForm => {
  const form = firstOfferedEndpointForm(description, hostForms);
  if (form === undefined) {
    throw new Error(
      `${where}: server ${JSON.stringify(description.id)} accepts only the endpoint forms ${bracketed(description.endpoint.forms)}, and this host offers ${bracketed(hostForms)}; the target cannot be used on this platform`,
    );
  }
  return form;
};

const declaredDescriptionOf = (id: string, declared: DeclaredServer): ManagedServerDescription => ({
  id,
  provider: id,
  wire: 'chat-completions',
  binary: { defaultPath: declared.command },
  launch: { argv: [...declared.args] },
  endpoint: { forms: declared.endpoint?.forms ?? DEFAULT_DECLARED_ENDPOINT_FORMS },
  ready: { method: 'GET', path: declared.readyPath, status: 200, limitMs: MANAGED_READY_LIMIT_MS },
  preconditions: [],
  identity: ['binarySha256', 'hostOsBuild'],
  restart: MANAGED_RESTART_POLICY,
  models: { listPath: '/v1/models', idPath: ['data', '0', 'id'] },
  toolForms: ['native', 'envelope'],
  tokenCount: 'estimated',
  errors: [],
  declarable: ['contextWindow', 'maxOutputTokens'],
  recordedDefaults: { stopSequences: false, imageInput: false, tokenCounting: 'estimated', usageReported: false, maxConcurrency: 1 },
  sampling: 'none',
});

const checkDeclaration = (id: string, declared: DeclaredServer, where: string): void => {
  if (MANAGED_SERVERS.some((server) => server.id === id)) throw new Error(`${where}: ${JSON.stringify(id)} is a built-in managed server and cannot be declared; choose another id`);
  if (!path.isAbsolute(declared.command)) throw new Error(`${where}.command must be an absolute path; got ${JSON.stringify(declared.command)}`);
  declared.args.forEach((arg, index) => {
    if (arg !== SOCKET_PLACEHOLDER && arg.includes(SOCKET_PLACEHOLDER)) {
      throw new Error(`${where}.args[${index}] contains ${JSON.stringify(SOCKET_PLACEHOLDER)} inside a longer argument; the placeholder must be a whole argument`);
    }
  });
  const placeholders = declared.args.filter((arg) => arg === SOCKET_PLACEHOLDER).length;
  if (placeholders !== 1) throw new Error(`${where}.args must contain ${JSON.stringify(SOCKET_PLACEHOLDER)} exactly once; found ${placeholders}`);
};

export const serverRegistryOf = (declared: Readonly<Record<string, DeclaredServer>> | undefined, source: string): ServerRegistry => {
  const registry: Record<string, ManagedServerDescription> = Object.fromEntries(MANAGED_SERVERS.map((server) => [server.id, server]));
  for (const [id, declaration] of Object.entries(declared ?? {})) {
    checkDeclaration(id, declaration, `${source}: models.servers.${id}`);
    registry[id] = declaredDescriptionOf(id, declaration);
  }
  return registry;
};

export const registeredServer = (registry: ServerRegistry | undefined, id: string): ManagedServerDescription | undefined =>
  registry !== undefined && Object.hasOwn(registry, id) ? registry[id] : undefined;

export const registeredIds = (registry: ServerRegistry | undefined): string[] => Object.keys(registry ?? {}).sort();
