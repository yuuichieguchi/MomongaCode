import { spawn } from "node:child_process";
import { constants } from "node:os";

const SIGNAL_EXIT_BASE = 128;
const STOPPING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const [secondsText, command, ...args] = process.argv.slice(2);
const seconds = Number(secondsText);
if (command === undefined || !Number.isFinite(seconds) || seconds <= 0) {
  process.stderr.write(
    "usage: node scripts/site/bounded.ts <seconds> <command> [<argument> ...]\n",
  );
  process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit", detached: true });
const group = child.pid;
let running = group !== undefined;

const stopGroup = (): "stopped" | "gone" => {
  if (!running || group === undefined) return "gone";
  try {
    process.kill(-group, "SIGKILL");
    return "stopped";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return "gone";
    throw error;
  }
};

child.on("error", (error) => {
  process.stderr.write(
    `site-deploy.sh: ${command} could not be started: ${error.message}\n`,
  );
  process.exit(1);
});

const bound = setTimeout(() => {
  if (stopGroup() === "gone") return;
  process.stderr.write(
    `site-deploy.sh: ${command} did not finish within ${secondsText} seconds and was stopped\n`,
  );
  process.exit(1);
}, seconds * 1000);

for (const signal of STOPPING_SIGNALS) {
  process.on(signal, () => {
    stopGroup();
    process.exit(SIGNAL_EXIT_BASE + constants.signals[signal]);
  });
}

child.on("exit", (code, signal) => {
  running = false;
  clearTimeout(bound);
  if (signal !== null) {
    process.stderr.write(
      `site-deploy.sh: ${command} was stopped by ${signal}\n`,
    );
    process.exit(1);
  }
  process.exit(code);
});
