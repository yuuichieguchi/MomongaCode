import path from 'node:path';
import type { Context } from 'hono';
import { canonicalPath, isTransientErrno } from '@momonga/foundation';
import { MEMORY_SCOPES } from '@momonga/protocol';
import type { MemoryScope } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { invalidRequest, notFound } from './errors.ts';
import type { Handler, RouteRegistrar } from './app.ts';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const scopeOf = (raw: string | undefined): MemoryScope | undefined => {
  if (raw === undefined) return undefined;
  const scope = MEMORY_SCOPES.find((candidate) => candidate === raw);
  if (scope === undefined) throw invalidRequest(`scope must be one of ${MEMORY_SCOPES.join(', ')}`, 'scope');
  return scope;
};

const projectOf = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  if (!path.isAbsolute(raw)) throw invalidRequest(`project ${raw} must be an absolute path`, 'project');
  try {
    return canonicalPath(raw);
  } catch (error) {
    if (isTransientErrno(error)) throw error;
    throw invalidRequest(`project ${raw} cannot be resolved: ${(error as Error).message}`, 'project');
  }
};

export const registerMemoryRoutes = (route: RouteRegistrar, deps: { store: Pick<RuntimeStore, 'memories'> }): void => {
  const { memories } = deps.store;

  const requireMemory = (context: Context) => {
    const id = context.req.param('id') ?? '';
    const memory = memories.get(id);
    if (memory === undefined) throw notFound(`memory ${id} does not exist`);
    return memory;
  };

  const listMemories: Handler = (context) => {
    const scope = scopeOf(context.req.query('scope'));
    const project = projectOf(context.req.query('project'));
    if (project !== undefined && scope === 'user') throw invalidRequest('a project filter cannot be combined with the user scope', 'project');
    return json({ memories: memories.list({ ...(scope === undefined ? {} : { scope }), ...(project === undefined ? {} : { project }) }) }, 200);
  };

  const getMemory: Handler = (context) => json({ memory: requireMemory(context) }, 200);

  const deleteMemory: Handler = (context) => {
    const id = context.req.param('id') ?? '';
    if (!memories.delete(id)) throw notFound(`memory ${id} does not exist`);
    return new Response(null, { status: 204 });
  };

  route('/v1/memories', { GET: listMemories });
  route('/v1/memories/:id', { GET: getMemory, DELETE: deleteMemory });
};
