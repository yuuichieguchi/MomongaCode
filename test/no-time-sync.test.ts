import { describe, expect, it } from 'vitest';
import { parseSource } from './support/source-scan.ts';
import { countTimeSync, timeSyncOfTests } from './support/time-sync-scan.ts';
import type { TimeSyncKind } from './support/time-sync-scan.ts';

type Kept = { kinds: Partial<Record<TimeSyncKind, number>>; reason: string };

type BurnDown = { kinds: Partial<Record<TimeSyncKind, number>>; owner: string };

const KEPT: Readonly<Record<string, Kept>> = {
  'packages/cli/test/broken-pipe-entry.ts': { kinds: { 'timer wait': 1 }, reason: 'the flooding command gives the event loop a turn so that the broken pipe of its output is delivered while it still writes: the turn is the event the case needs' },
  'packages/eval/test/runner.test.ts': { kinds: { 'timer wait': 2 }, reason: 'node reports an unhandled rejection only after a macrotask: the turn is the event the case waits for' },
  'packages/foundation/test/outbound-trust-off-loop.test.ts': { kinds: { 'wall-clock reading': 1 }, reason: 'the fake worker spends a fixed span of CPU so the case can show it runs off the event loop' },
  'packages/foundation/test/path-asking.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the case proves the asking does not block the event loop: a turn that runs while the work is pending is the event' },
  'packages/foundation/test/path-resolver-async.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the case proves the resolution does not block the event loop: a timer that fires while the work is pending is the event' },
  'packages/foundation/test/wait-until.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the subject is the one poll of the foundation; the macrotask is the step it is driven by' },
  'packages/mcp/test/output-pattern-off-thread.test.ts': { kinds: { 'wall-clock reading': 1 }, reason: 'the limit of the pattern check is a wall-clock bound of the product; the case measures that it holds' },
  'packages/policy/test/decision-resolver.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the case proves the decision does not block the event loop: a timer that fires while the work is pending is the event' },
  'packages/runtime/test/calibration/offloop-cost.test.ts': { kinds: { 'wall-clock reading': 1 }, reason: 'a calibration measures wall time by design and runs only in the calibration project' },
  'packages/testkit/test/drive-fake-time.test.ts': { kinds: { 'wall-clock reading': 3 }, reason: 'the subject is the fake-time driver; its real-time deadline is the property under test' },
};

const BURN_DOWN: Readonly<Record<string, BurnDown>> = {
  'e2e/c-cancel.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W7: C-e2e-bodies (wall-clock asserts) and C-waits (the e2e bounds list)' },
  'e2e/supervisor.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W7: C-e2e-bodies (wall-clock asserts) and C-waits (the e2e bounds list)' },
  'e2e/support/stack.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W7: C-e2e-bodies (wall-clock asserts) and C-waits (the e2e bounds list)' },
  'e2e/support/wait.ts': { kinds: { 'timer wait': 2, 'wall-clock reading': 1 }, owner: 'tests-W7: C-e2e-bodies (wall-clock asserts) and C-waits (the e2e bounds list)' },
  'packages/cli/test/acp-harness.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/auto-mode-check.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/auto-notice.test.tsx': { kinds: { 'wall-clock reading': 1, 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/context-effects.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/daemon-stop-generations.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/daemon-stop-values.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/ensure-daemon-current.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/ensure-daemon-generations.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/fake-plan-gateway.tsx': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/fake-supervisor.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/handover/stream-resume.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/ink-helpers.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/secret-set-limit.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/tui/handover-app.test.tsx': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/tui/keys-app.test.tsx': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/tui/screen-a11y-app.test.tsx': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/tui/screen-status.test.tsx': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/tui/select-app.test.tsx': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/unanswered-host-exec.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/cli/test/update-body-closed.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/config/test/append-rule.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/config/test/edit-models-settings.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/context/test/review-resolutions.test.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/atomic-file.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/daemon-entry-epipe.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/daemon-entry-stop-values.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/encrypted-credential-store.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/lifeline.test.ts': { kinds: { 'wall-clock reading': 2, 'timer wait': 3 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/marker-kill-window.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/open-url.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/outbound-trust-worker-abort.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/platform/linux-real-processes.test.ts': { kinds: { 'wall-clock reading': 2, 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/process-markers.test.ts': { kinds: { 'wall-clock reading': 1, 'timer wait': 3 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/reap-marked-processes.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/support/credential-key-fakes.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/support/probe-fakes.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/foundation/test/support/secret-store-fakes.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/auto-probe.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/entry.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/fm-serve.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/gateway-backpressure.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/gateway-process-fake-timer-drive.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/gateway-process-helpers.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/gateway-process-plan-wiring.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/gateway-process-secrets.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/gateway-unary-resilience.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/managed/managed-server.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/plan-close-loads.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/plan-support.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/settings-live-gateway.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/gateway/test/upstream-content-idle.test.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 6 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/mcp/test/authorize.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/mcp/test/oauth-store-signal.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/mcp/test/raw-transport.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/mcp/test/review-resolutions.test.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/mcp/test/source-executor.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/mcp/test/stdio-transport.test.ts': { kinds: { 'wall-clock reading': 1, 'timer wait': 4 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/memory/test/contribution-scripts.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/observability/test/robustness.test.ts': { kinds: { 'timer wait': 2, 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/gateway-client/real-gateway-liveness.test.ts': { kinds: { 'timer wait': 3 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/memory/deadline-signal.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/memory/journal-thread-serve.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/memory/journal-thread.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/process/cancel-recovery.test.ts': { kinds: { 'holder that ends by itself': 2 }, owner: 'tests-W4 continuation: the holder runs through the product sandbox, where tail is not established to be reachable' },
  'packages/runtime/test/process/mcp-credential-encryption.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/process/run-helpers.ts': { kinds: { 'wall-clock reading': 1, 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/process/settings-port-asker-signal.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/process/wrap-up-run.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/service/integration.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/worker/gateway-cancel.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/worker/keep-alive-gateway.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/runtime/test/worker/search-index-cost.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/sandbox/test/bubblewrap-launch.test.ts': { kinds: { 'wall-clock reading': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/sandbox/test/bubblewrap-probe.test.ts': { kinds: { 'wall-clock reading': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/sandbox/test/bubblewrap-real.test.ts': { kinds: { 'wall-clock reading': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/sandbox/test/marker-lock-launch.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/sandbox/test/seatbelt.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/store/test/on-commit.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/store/test/search-incremental.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/supervisor/test/child-manager-real.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/supervisor/test/child-manager.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/supervisor/test/entry-slow-fs.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/supervisor/test/markers.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/supervisor/test/p3-harness-pump.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/testkit/test/fake-chat-completions-hold.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/testkit/test/fake-chat-completions-routes.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/testkit/test/fake-chat-completions.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/testkit/test/fake-fm.test.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 3 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/testkit/test/fake-secrets.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/testkit/test/mcp-fixtures.test.ts': { kinds: { 'wall-clock reading': 2, 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/testkit/test/register-cleanup-concurrent.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/testkit/test/temp-dir-creator.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/builtins/markers-route-sandbox.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/builtins/review.test.ts': { kinds: { 'timer wait': 2, 'wall-clock reading': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-abandon.test.ts': { kinds: { 'timer wait': 2, 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-abort.test.ts': { kinds: { 'wall-clock reading': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-call-lock.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-marker-ownership.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-progress-bounds.test.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-review-2.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-review-2c.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-review.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/executor-stalled-filesystem.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/hooks-group-record-failure.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/hooks-owner.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/hooks-run.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/policy-glob-spawn.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'packages/tools/test/sandboxed-command.test.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'scripts/journal-thread.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'scripts/run-lock.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'scripts/tlc.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'scripts/windows-keeper-host.test.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'test/formal/reuse.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'test/formal/runner.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'test/formal/tlc.test.ts': { kinds: { 'wall-clock reading': 2, 'timer wait': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'test/lock-proof-sweeps.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'test/no-time-sync.test.ts': { kinds: { 'holder that ends by itself': 2 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
  'test/support/run-lock.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W4 continuation: the event of each site is read in place (a later event in the same stream for a negative, the exit or the poll of the product for real work)' },
};

const FOUND = timeSyncOfTests();

const counted = (text: string, file = 'fixture.test.ts') => countTimeSync(parseSource(file, text));

const allowedOf = (file: string): Partial<Record<string, number>> => ({ ...KEPT[file]?.kinds, ...BURN_DOWN[file]?.kinds });

describe('no test synchronises on time: it waits on the event, the journal entry or the exit the product exposes', () => {
  it.each([
    ['a sleep on a real timer', 'await new Promise((resolve) => setTimeout(resolve, 20));', 'timer wait'],
    ['an event-loop turn', 'await new Promise<void>((resolve) => setImmediate(resolve));', 'timer wait'],
    ['a fixed number of turns', 'for (let turn = 0; turn < 10; turn += 1) await new Promise((r) => setImmediate(r));', 'timer wait'],
    ['a race against a real timer', "await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve('late'), 2000))]);", 'timer wait'],
    ['a timer through globalThis', 'await new Promise((resolve) => globalThis.setTimeout(resolve, 5));', 'timer wait'],
    ['the promise timers of node', "import { setTimeout as delay } from 'node:timers/promises';\nawait delay(5);", 'timer wait'],
    ['the turn of node:timers/promises', "import { setImmediate as nextTurn } from 'node:timers/promises';\nawait nextTurn();", 'timer wait'],
    ['a wall-clock difference', 'const t0 = Date.now();\nawait work;\nexpect(Date.now() - t0).toBeLessThan(100);', 'wall-clock reading'],
    ['a wall-clock deadline', 'while (!done() && Date.now() < deadline) await step();', 'wall-clock reading'],
    ['a monotonic difference', 'expect(performance.now() - started).toBeLessThan(10);', 'wall-clock reading'],
    ['a holder that ends by itself beside a fake clock', "const clock = createFakeClock(0);\nspawn('/bin/sh', ['-c', 'exec /bin/sleep 30']);", 'holder that ends by itself'],
  ])('refuses %s', (_form, text, kind) => {
    expect(counted(text)).toEqual({ [kind]: 1 });
  });

  it.each([
    ['a fake timer resolving a promise', 'await new Promise((resolve) => timers.setTimeout(resolve, 20));'],
    ['an asynchronous emit of a fake', "setImmediate(() => child.emit('error', failure));"],
    ['a timer of a destructured fake', 'const { setTimeout } = createFakeTimers(clock);\nawait new Promise((resolve) => setTimeout(resolve, 5));'],
    ['a reading of the wall clock that is not compared', 'const clock = createFakeClock(Date.now());'],
    ['a holder that waits for its signal', "spawn('/bin/sh', ['-c', 'exec /usr/bin/tail -f /dev/null']);"],
    ['a sleep in a script beside no fake clock', "spawn('/bin/sh', ['-c', 'exec /bin/sleep 30']);"],
    ['a timer of the faked host timers of vitest', 'vi.useFakeTimers();\nawait new Promise((resolve) => setTimeout(resolve, 5));'],
    ['the forbidden forms in a string', "const fixture = 'await new Promise((resolve) => setTimeout(resolve, 5)); Date.now() - t0';"],
  ])('accepts %s', (_form, text) => {
    expect(counted(text)).toEqual({});
  });

  it('finds no form beyond the kept sites and the burn-down', () => {
    const found = FOUND;
    const over = Object.entries(found).flatMap(([file, counts]) =>
      Object.entries(counts)
        .filter(([kind, count]) => count > (allowedOf(file)[kind] ?? 0))
        .map(([kind, count]) => `${file}: ${count} ${kind}, ${allowedOf(file)[kind] ?? 0} allowed`),
    );
    expect(over).toEqual([]);
  });

  it('keeps no allowance for a site that is gone, so the lists only shrink', () => {
    const found = FOUND;
    const stale = [...new Set([...Object.keys(KEPT), ...Object.keys(BURN_DOWN)])].flatMap((file) =>
      Object.entries(allowedOf(file))
        .filter(([kind, count]) => (count ?? 0) > (found[file]?.[kind] ?? 0))
        .map(([kind, count]) => `${file}: ${count} ${kind} allowed, ${found[file]?.[kind] ?? 0} found`),
    );
    expect(stale).toEqual([]);
  });

  it('lists a file in one table only', () => {
    expect(Object.keys(KEPT).filter((file) => file in BURN_DOWN)).toEqual([]);
  });
});
