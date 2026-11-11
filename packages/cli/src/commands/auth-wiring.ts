import type { MomongaPaths } from '@momonga/foundation';
import { currentSocketResolver } from '@momonga/foundation';
import { createGatewayClient } from '../client/gateway-client.ts';
import type { GatewayClient } from '../client/gateway-client.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import { loopbackSignInListener } from '../plan/sign-in.ts';
import { terminalChoice } from '../plan/terminal-choice.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { authLogin, authLogout, authResetHost, authResume, authStatus } from './auth.ts';
import { modelsCatalog } from './models.ts';
import type { AuthLoginOptions } from './auth.ts';

const withGateway = async (ports: CliPorts, paths: MomongaPaths, work: (gateway: GatewayClient) => Promise<number>): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
  try {
    return await work(gateway);
  } finally {
    await gateway.close();
  }
};

export const runAuthStatus = (ports: CliPorts, paths: MomongaPaths, options: { json: boolean; model?: string }): Promise<number> =>
  withGateway(ports, paths, (gateway) => authStatus({ stdout: ports.stdout, plan: gateway.plan, listing: () => gateway.modelList() }, options));

const terminalPorts = (ports: CliPorts, interrupt: AbortSignal) =>
  ports.terminal === undefined ? { isTerminal: false as const } : { isTerminal: true as const, choose: terminalChoice(ports.terminal, interrupt) };

const loginTerminalPorts = (ports: CliPorts, interrupt: AbortSignal) =>
  ports.terminal === undefined ? { isTerminal: false as const } : { isTerminal: true as const, choose: terminalChoice(ports.terminal, interrupt), terminal: ports.terminal };

export const runAuthResume = (ports: CliPorts, paths: MomongaPaths, account: string): Promise<number> =>
  withGateway(ports, paths, (gateway) => authResume({ stdout: ports.stdout, stderr: ports.stderr, plan: gateway.plan }, { account }));

export const runAuthResetHost = (ports: CliPorts, paths: MomongaPaths, yes: boolean, interrupt: AbortSignal): Promise<number> =>
  withGateway(ports, paths, (gateway) => authResetHost({ stdout: ports.stdout, stderr: ports.stderr, plan: gateway.plan, ...terminalPorts(ports, interrupt) }, { yes }));

export const runModelsCatalog = (ports: CliPorts, paths: MomongaPaths, options: { json: boolean; account?: string }): Promise<number> =>
  withGateway(ports, paths, (gateway) => modelsCatalog({ stdout: ports.stdout, stderr: ports.stderr, plan: gateway.plan }, options));

export const runAuthLogin = (ports: CliPorts, paths: MomongaPaths, options: AuthLoginOptions, interrupt: AbortSignal): Promise<number> =>
  withGateway(ports, paths, (gateway) =>
    authLogin(
      {
        stdout: ports.stdout,
        stderr: ports.stderr,
        plan: gateway.plan,
        ...loginTerminalPorts(ports, interrupt),
        signal: interrupt,
        timers: ports.timers,
        startListener: loopbackSignInListener(ports.timers, interrupt),
        openUrl: ports.openUrl,
        sandbox: async () => {
          const runtime = connectRuntime(ports, paths);
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
    return authLogout({ stdout: ports.stdout, stderr: ports.stderr, plan: gateway.plan, ...terminalPorts(ports, interrupt) }, account === undefined ? {} : { account });
  });
