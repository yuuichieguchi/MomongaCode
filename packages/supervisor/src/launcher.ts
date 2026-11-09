import path from 'node:path';
import { LIFELINE_FD } from '@momonga/foundation';
import type { SpawnPortOptions } from './child-manager.ts';
import { omitUndefined } from './omit-undefined.ts';

export type ChildRole = 'gateway' | 'runtime';

export type LaunchSpec = { command: string; args: readonly string[]; env?: Readonly<Record<string, string>> };

export type Launcher = (role: ChildRole) => LaunchSpec;

export type RuntimeTuning = { leaseMs?: number; drainTimeoutMs?: number; workerCount?: number; sandboxExecPath?: string };

export type GatewayTuning = { args?: readonly string[] };

export type ResolvedLaunch = { command: string; args: readonly string[]; env: Readonly<Record<string, string>> };

export const CHILD_ROLES: readonly ChildRole[] = ['gateway', 'runtime'];

const tuningFlags = (role: ChildRole, runtime: RuntimeTuning | undefined, gateway: GatewayTuning | undefined): string[] => {
  if (role === 'gateway') {
    return [...(gateway?.args ?? [])];
  }
  return [
    ...(runtime?.leaseMs === undefined ? [] : [`--lease-ms=${runtime.leaseMs}`]),
    ...(runtime?.drainTimeoutMs === undefined ? [] : [`--drain-timeout-ms=${runtime.drainTimeoutMs}`]),
    ...(runtime?.workerCount === undefined ? [] : [`--worker-count=${runtime.workerCount}`]),
    ...(runtime?.sandboxExecPath === undefined ? [] : [`--sandbox-exec-path=${runtime.sandboxExecPath}`]),
  ];
};

export const contractArgs = (input: { role: ChildRole; home: string; generation: number; runtime?: RuntimeTuning; gateway?: GatewayTuning }): string[] => [
  `--home=${input.home}`,
  `--generation=${input.generation}`,
  `--lifeline-fd=${LIFELINE_FD}`,
  '--log-target=file',
  ...tuningFlags(input.role, input.runtime, input.gateway),
];

export const childStdio = (markerFd: number, lockFd?: number): SpawnPortOptions['stdio'] =>
  lockFd === undefined ? ['ignore', 'pipe', 'pipe', 'pipe', markerFd] : ['ignore', 'pipe', 'pipe', 'pipe', markerFd, lockFd];

export const resolveLaunch = (input: {
  role: ChildRole;
  launcher: Launcher;
  home: string;
  generation: number;
  runtime?: RuntimeTuning;
  gateway?: GatewayTuning;
  baseEnv: Readonly<Record<string, string>>;
  separateEnv(merged: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
}): ResolvedLaunch => {
  const spec = input.launcher(input.role);
  if (!path.isAbsolute(spec.command)) throw new TypeError(`launcher command must be an absolute path, got ${JSON.stringify(spec.command)}`);
  const merged = { ...input.baseEnv, ...spec.env };
  const tuning = omitUndefined({ runtime: input.runtime, gateway: input.gateway });
  return {
    command: spec.command,
    args: [...spec.args, ...contractArgs({ role: input.role, home: input.home, generation: input.generation, ...tuning })],
    env: input.separateEnv(merged),
  };
};
