import path from 'node:path';
import { UNMEASURED_CAPABILITY, canonicalDirectory, createMarker, defaultProcessInspector, nodeFileSystem, groupRecordOutcome, protectedSetFor, recordMarkerGroup, uuidv7 } from '@momonga/foundation';
import type { MarkerHandle, MomongaPaths } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import type { PolicyPorts } from '@momonga/policy';
import type { SandboxedProcess } from '@momonga/sandbox';
import { buildSandboxPolicy, createMarkerSettle, readOnlyEnvironment, readOnlySandboxPolicy, settleFinishedCommand } from '@momonga/tools';
import type { MarkerOwners, MarkerSettle, MarkerSettleOptions } from '@momonga/tools';
import type { SandboxBindings } from '../ports.ts';
import { holdSandbox } from '../worker/held-sandbox.ts';
import type { EvidenceRun } from '../memory/evidence.ts';

export type EvidenceReap = Pick<MarkerSettleOptions, 'inspector' | 'killGraceMs' | 'kill' | 'groupPort' | 'timing'>;

export type EvidenceRunnerOptions = {
  paths: MomongaPaths;
  home: string;
  fs: PolicyPorts;
  sandboxes: SandboxBindings;
  env: Readonly<Record<string, string>>;
  reap?: EvidenceReap;
  owners?: MarkerOwners;
  onWarning?(message: string): void;
};

const raiseWarning = (message: string): never => {
  throw new Error(message);
};

const textOf = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

export const createEvidenceRunner =
  ({ paths, home, fs, sandboxes, env, reap = {}, owners, onWarning = raiseWarning }: EvidenceRunnerOptions) =>
  (project: string): EvidenceRun =>
  async (command, signal) => {
    const root = canonicalDirectory(project);
    if (!root.ok) return { exitCode: null, notStarted: `${project} is not a folder` };
    const roots = [root.path];
    const inspector = reap.inspector ?? defaultProcessInspector();
    const marker = path.join(paths.markers.tools, `evidence-${uuidv7()}`);
    const name = path.basename(marker);
    let running = true;
    owners?.register(name, { alive: () => running });
    let handle: MarkerHandle | undefined;
    let settle: MarkerSettle | undefined;
    let spawned = false;
    const held = await holdSandbox(sandboxes, signal);
    try {
      let child: SandboxedProcess;
      try {
        await nodeFileSystem.mkdirPrivate(paths.markers.tools);
        handle = await createMarker(marker, { capability: inspector.capability ?? UNMEASURED_CAPABILITY });
        owners?.remember(name, handle.mode);
        settle = createMarkerSettle({ ...reap, marker, mode: handle.mode, inspector, onWarning });
        const policy = readOnlySandboxPolicy(
          buildSandboxPolicy({
            roots: [],
            home,
            sessionsTmpRoot: paths.tmp.sessions,
            fileRules: computeFileRules([], roots, null, held.ruleEnforcement),
            protectedSet: protectedSetFor(roots, fs),
            network: command.network,
          }),
        );
        child = held.sandbox.spawn({ argv: command.argv, cwd: command.cwd, env: readOnlyEnvironment({ ...env, ...command.env }), markerFile: marker }, policy, signal, { markerFd: handle.fd });
      } catch (error) {
        return { exitCode: null, notStarted: error instanceof Error ? error.message : String(error) };
      }
      spawned = true;
      const [stdout, , exit, groupNotice] = await Promise.all([textOf(child.stdout), textOf(child.stderr), child.exited, groupRecordOutcome(recordMarkerGroup(marker, child.pgid), marker)]);
      if (groupNotice !== undefined) onWarning(groupNotice);
      await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal });
      return { exitCode: exit.code, stdout };
    } finally {
      held.done();
      if (!spawned) handle?.close();
      if (handle !== undefined && !spawned) await settle?.discard();
      else await settle?.remove();
      running = false;
    }
  };
