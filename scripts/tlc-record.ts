import fs from 'node:fs';
import path from 'node:path';
import { recordProblems, measurementOf, recordedRow, writeManifestRows } from '../test/formal/record.ts';
import { readManifest } from '../test/formal/manifest-reader.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(repoRoot, 'specs', 'tla', 'manifest.json');

const usage = 'usage: node scripts/tlc-record.ts <config> <log> <1-minute load at start>\n  <log>: the stdout and stderr of /usr/bin/time -l scripts/tlc.sh <config> -workers 5';

const [config, logFile, load] = process.argv.slice(2);
if (config === undefined || logFile === undefined || load === undefined) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const manifest = readManifest(manifestPath);
const row = manifest.entries.find((entry) => entry.config === config);
if (row === undefined) {
  process.stderr.write(`${config} has no row in specs/tla/manifest.json\n`);
  process.exit(2);
}

const log = fs.readFileSync(logFile, 'utf8');
const measurement = measurementOf(log);
const problems = recordProblems(row, log, measurement);
if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\nthe row is not written\n`);
  process.exit(1);
}

const next = await recordedRow(repoRoot, row, log, manifest.startupCpuSeconds, load);
writeManifestRows(manifestPath, [next]);
process.stdout.write(`${config}: ${measurement.distinctStates} distinct states, ${measurement.measuredSeconds} s wall, ${measurement.measuredCpuSeconds} CPU s, budget ${next['budgetCpuSeconds']} CPU s, identity recorded\n`);
