import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { GENERATION_RETIRED_CODE } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { createGatewayClient } from '../src/client/gateway-client.ts';

const RETIRED_MESSAGE = 'This gateway belongs to a replaced generation and takes no new requests. The request was not run; send it again.';

const USAGE = { run_id: 'run_1', responses: [], steps: [], total: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };

type Answer = { status: number; body: unknown };

const RETIRED: Answer = { status: 503, body: { error: { type: 'server_error', code: GENERATION_RETIRED_CODE, message: RETIRED_MESSAGE, param: null } } };

const gatewayAnswering = async (context: TestContext, name: string, answers: Answer[]): Promise<{ socketPath: string; requests: string[] }> => {
  const socketPath = path.join(withTempDir(context), name);
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const answer = answers.shift() ?? { status: 500, body: { error: 'no answer scripted' } };
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, () => {
    server.closeAllConnections();
    server.close();
  });
  return { socketPath, requests };
};

describe('the CLI gateway client and a retired generation (design-update 18.9 O-I5-2, 20.3, 20.56)', () => {
  it('resolves the socket again and sends the same call once more when the gateway answers generation_retired', async (context) => {
    const retired = await gatewayAnswering(context, 'old.sock', [RETIRED]);
    const serving = await gatewayAnswering(context, 'new.sock', [{ status: 200, body: USAGE }]);
    const dialed: string[] = [];
    const sockets = [retired.socketPath, serving.socketPath];
    const client = createGatewayClient({
      resolveSocket: async () => {
        const socket = sockets[Math.min(dialed.length, sockets.length - 1)] as string;
        dialed.push(socket);
        return socket;
      },
    });
    registerCleanup(context, () => client.close());

    expect(await client.usageOf('run_1')).toEqual(USAGE);

    expect(dialed).toEqual([retired.socketPath, serving.socketPath]);
    expect(retired.requests).toEqual(['GET /v1/momonga/usage?run_id=run_1']);
    expect(serving.requests).toEqual(['GET /v1/momonga/usage?run_id=run_1']);
  });

  it('shows the text of the refusal as the error when the call sent once more is refused again, and sends no third call', async (context) => {
    const retired = await gatewayAnswering(context, 'old.sock', [RETIRED, RETIRED, { status: 200, body: USAGE }]);
    const client = createGatewayClient({ resolveSocket: async () => retired.socketPath });
    registerCleanup(context, () => client.close());

    await expect(client.usageOf('run_1')).rejects.toThrow(RETIRED_MESSAGE);

    expect(retired.requests).toHaveLength(2);
  });
});
