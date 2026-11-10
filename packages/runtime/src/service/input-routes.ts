import type { McpAuthorizationView, McpServerView } from '@momonga/protocol';
import { McpElicitationAnswerError, parseElicitationAnswers } from '@momonga/mcp';
import { cleanFailureMessage } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { conflict, invalidRequest, notFound } from './errors.ts';
import type { Handler, RouteRegistrar } from './app.ts';
import { JSON_MEDIA_TYPES, readJson, validateBody } from './request.ts';
import type { ResolveElicitationBody } from './request.ts';
import { toRunView } from './views.ts';

export type McpAdminPort = {
  servers(sessionId: string, signal: AbortSignal): Promise<McpServerView[]>;
  startAuthorization(sessionId: string, name: string): Promise<McpAuthorizationView>;
  authorization(sessionId: string, name: string): McpAuthorizationView | undefined;
  cancelAuthorization(sessionId: string, name: string): boolean;
};

export type InputRoutesDeps = {
  store: Pick<RuntimeStore, 'getRun' | 'elicitationView' | 'pendingElicitationViews' | 'resolveElicitation'>;
  mcp: McpAdminPort;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
  refuseWhileRetiring(): void;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const registerInputRoutes = (route: RouteRegistrar, deps: InputRoutesDeps): void => {
  const { store, mcp } = deps;

  const runElicitations: Handler = async (context) => {
    const id = context.req.param('id') ?? '';
    if (store.getRun(id) === undefined) throw notFound(`run ${id} does not exist`);
    return json({ elicitations: await store.pendingElicitationViews(id) });
  };

  const getElicitation: Handler = async (context) => {
    const id = context.req.param('id') ?? '';
    const elicitation = await store.elicitationView(id);
    if (elicitation === undefined) throw notFound(`elicitation ${id} does not exist`);
    return json({ elicitation });
  };

  const resolveElicitation: Handler = async (context) => {
    const id = context.req.param('id') ?? '';
    const body = validateBody<ResolveElicitationBody>('ResolveElicitationRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const view = await store.elicitationView(id);
    if (view === undefined) throw notFound(`elicitation ${id} does not exist`);
    let responses;
    const notices: string[] = [];
    try {
      responses = await parseElicitationAnswers(view.requests, body.responses, {
        server: view.server,
        signal: context.req.raw.signal,
        onValidatorFailure: (request, message) =>
          notices.push(`Elicitation ${JSON.stringify(cleanFailureMessage(request.key))} of MCP server ${JSON.stringify(cleanFailureMessage(view.server))} was declined: its requestedSchema validator failed: ${message}`),
      });
    } catch (error) {
      if (error instanceof McpElicitationAnswerError) throw invalidRequest(error.message, 'responses');
      throw error;
    }
    const result = await store.resolveElicitation(id, responses, notices);
    switch (result.kind) {
      case 'not_found':
      case 'wrong_kind':
        throw notFound(`elicitation ${id} does not exist`);
      case 'approval_not_pending':
        throw conflict('approval_not_pending', `elicitation ${id} is ${result.status}, not pending`);
      case 'request_missing':
        throw conflict('approval_not_pending', `elicitation ${id} has no recorded request`);
      case 'run_cancelled':
        throw conflict('run_cancelled', `the run of elicitation ${id} was cancelled`);
      case 'ok': {
        const resolved = await store.elicitationView(id);
        if (resolved === undefined) throw new Error(`elicitation ${id} vanished after it was answered`);
        return json({ elicitation: resolved, run: toRunView(result.run) });
      }
    }
  };

  const listServers: Handler = async (context) =>
    json({ servers: await mcp.servers(context.req.param('id') ?? '', AbortSignal.any([deps.closeSignal, context.req.raw.signal])) });

  const startAuthorization: Handler = async (context) => {
    deps.refuseWhileRetiring();
    return json({ authorization: await mcp.startAuthorization(context.req.param('id') ?? '', context.req.param('name') ?? '') }, 202);
  };

  const getAuthorization: Handler = (context) => {
    const name = context.req.param('name') ?? '';
    const authorization = mcp.authorization(context.req.param('id') ?? '', name);
    if (authorization === undefined) throw notFound(`no authorization was started for MCP server ${name}`);
    return json({ authorization });
  };

  const cancelAuthorization: Handler = (context) => {
    const name = context.req.param('name') ?? '';
    if (!mcp.cancelAuthorization(context.req.param('id') ?? '', name)) throw notFound(`no authorization is waiting for MCP server ${name}`);
    return new Response(null, { status: 204 });
  };

  route('/v1/runs/:id/elicitations', { GET: runElicitations });
  route('/v1/elicitations/:id', { GET: getElicitation, POST: resolveElicitation });
  route('/v1/sessions/:id/mcp/servers', { GET: listServers });
  route('/v1/sessions/:id/mcp/servers/:name/authorization', { GET: getAuthorization, POST: startAuthorization, DELETE: cancelAuthorization });
};
