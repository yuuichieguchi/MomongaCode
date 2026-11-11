import path from 'node:path';
import { UNMEASURED_CAPABILITY, createMarker, hostPaths, defaultProcessInspector, nodeFileSystem, groupRecordOutcome, protectedSetFor, recordMarkerGroup, uuidv7 } from '@momonga/foundation';
import type { MarkerHandle, MomongaPaths } from '@momonga/foundation';
import { askedBy, computeFileRules } from '@momonga/policy';
import type { PolicyHostPorts } from '@momonga/policy';
import type { SandboxedProcess } from '@momonga/sandbox';
import { buildSandboxPolicy, createMarkerSettle, readOnlyEnvironment, readOnlySandboxPolicy, settleFinishedCommand } from '@momonga/tools';
import type { MarkerOwners, MarkerSettle, MarkerSettleOptions } from '@momonga/tools';
import type { SandboxBindings } from '../ports.ts';
import { holdSandbox } from '../worker/held-sandbox.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import { JOB_OUTPUT_WINDOW_BYTES } from './constants.ts';
import { createJobOutput } from './job-output.ts';
import type { JobOutputWindow } from './job-output.ts';

export type EvidenceReap = Pick<MarkerSettleOptions, 'inspector' | 'killGraceMs' | 'kill' | 'groupPort' | 'timing'>;

export type EvidenceRunnerOptions = {
  paths: MomongaPaths;
  home: string;
  fs: PolicyHostPorts;
  sandboxes: SandboxBindings;
  env: Readonly<Record<string, string>>;
  reap?: EvidenceReap;
  owners?: MarkerOwners;
  onWarning?(message: string): void;
  outputWindowBytes?: number;
};

const raiseWarning = (message: string): never => {
  throw new Error(message);
};

const windowOf = async (stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<JobOutputWindow> => {
  const output = createJobOutput(maxBytes);
  for await (const chunk of stream) output.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  return output.window();
};

export const createEvidenceRunner =
  ({ paths, home, fs, sandboxes, env, reap = {}, owners, onWarning = raiseWarning, outputWindowBytes = JOB_OUTPUT_WINDOW_BYTES }: EvidenceRunnerOptions) =>
  (project: string): EvidenceRun =>
  async (command, signal) => {
    const root = await hostPaths(signal).canonicalDirectory(project);
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
        const ports = askedBy(fs, signal);
        const policy = readOnlySandboxPolicy(
          await buildSandboxPolicy(
            {
              roots: [],
              home,
              sessionsTmpRoot: paths.tmp.sessions,
              fileRules: await computeFileRules([], roots, null, held.ruleEnforcement, ports),
              protectedSet: await protectedSetFor(roots, ports),
              network: command.network,
            },
            signal,
          ),
        );
        child = await held.sandbox.spawn({ argv: command.argv, cwd: command.cwd, env: readOnlyEnvironment({ ...env, ...command.env }), markerFile: marker }, policy, signal, { markerFd: handle.fd });
      } catch (error) {
        return { exitCode: null, notStarted: error instanceof Error ? error.message : String(error) };
      }
      spawned = true;
      const [stdout, , exit, groupNotice] = await Promise.all([
        windowOf(child.stdout, outputWindowBytes),
        windowOf(child.stderr, outputWindowBytes),
        child.exited,
        groupRecordOutcome(recordMarkerGroup(marker, child.pgid), marker),
      ]);
      if (groupNotice !== undefined) onWarning(groupNotice);
      await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal });
      return { exitCode: exit.code, stdout: stdout.bytes.toString('utf8'), ...(stdout.start === 0 ? {} : { stdoutOmittedBytes: stdout.start }) };
    } finally {
      held.done();
      if (!spawned) handle?.close();
      if (handle !== undefined && !spawned) await settle?.discard();
      else await settle?.remove();
      running = false;
    }
  };
