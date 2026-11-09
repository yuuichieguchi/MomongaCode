import type { MomongaPaths } from '@momonga/foundation';
import { currentSocketResolver } from '@momonga/foundation';
import { createGatewayClient } from '../client/gateway-client.ts';
import type { GatewayClient } from '../client/gateway-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { stderrStopNotice } from '../daemon/stop-notice.ts';
import { loopbackSignInListener } from '../plan/sign-in.ts';
import { terminalChoice } from '../plan/terminal-choice.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { authLogin, authLogout, authStatus } from './auth.ts';
import type { AuthLoginOptions } from './auth.ts';

const withGateway = async (ports: CliPorts, paths: MomongaPaths, work: (gateway: GatewayClient) => Promise<number>): Promise<number> => {
  await ensureDaemon(ports, paths, { onNotice: stderrStopNotice(ports) });
  const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
  try {
    return await work(gateway);
  } finally {
    await gateway.close();
  }
};

export const runAuthStatus = (ports: CliPorts, paths: MomongaPaths, json: boolean): Promise<number> =>
  withGateway(ports, paths, (gateway) => authStatus({ stdout: ports.stdout, plan: gateway.plan }, { json }));

export const runAuthLogin = (ports: CliPorts, paths: MomongaPaths, options: AuthLoginOptions, interrupt: AbortSignal): Promise<number> =>
  withGateway(ports, paths, (gateway) =>
    authLogin(
      {
        stdout: ports.stdout,
        stderr: ports.stderr,
        plan: gateway.plan,
        startListener: loopbackSignInListener(interrupt),
        openUrl: (url) => ports.openUrl(url, interrupt),
        sandbox: async () => {
          const runtime = connectRuntime(paths);
          try {
            return (await runtime.health()).sandbox;
          } finally {
            await runtime.close();
          }
        },
      },
      options,
    ),
  );

export const runAuthLogout = (ports: CliPorts, paths: MomongaPaths, account: string | undefined, interrupt: AbortSignal): Promise<number> =>
  withGateway(ports, paths, (gateway) => {
    const common = { stdout: ports.stdout, stderr: ports.stderr, plan: gateway.plan };
    const terminal = ports.terminal;
    return authLogout(
      terminal === undefined ? { ...common, isTerminal: false } : { ...common, isTerminal: true, choose: terminalChoice(terminal, interrupt) },
      account === undefined ? {} : { account },
    );
  });
