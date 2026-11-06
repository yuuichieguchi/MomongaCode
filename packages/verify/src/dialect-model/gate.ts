import { runSeed, SEEDS } from './seeds.ts';
import { runSubject, SUBJECTS, type SubjectReport } from './subjects.ts';

const argument = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
};

const schemas = Number(argument('schemas', '10000'));
const seed = Number(argument('seed', '20261105'));
const only = argument('only', '');
const started = Date.now();

const seedOutcomes = SEEDS.map(runSeed);
for (const outcome of seedOutcomes) {
  const status = outcome.failure === null && outcome.assertion === null ? 'ok' : 'COUNTEREXAMPLE';
  process.stdout.write(`seed ${status}: ${outcome.name} -> ${outcome.summary}${outcome.failure === null ? '' : ` | ${outcome.failure.kind} ${JSON.stringify(outcome.failure.instance ?? null)}`}${outcome.assertion === null ? '' : ` | ${outcome.assertion}`}\n`);
}

const reports: SubjectReport[] = [];
for (const spec of SUBJECTS) {
  if (only !== '' && spec.name !== only) continue;
  const begun = Date.now();
  const report = runSubject(spec, schemas, seed, (line) => process.stderr.write(`${line}\n`));
  reports.push(report);
  process.stdout.write(
    `${JSON.stringify({
      subject: report.name,
      group: report.group,
      schemas: report.stats.schemas,
      checks: report.checks,
      definitions: report.definitions,
      rendered: report.stats.rendered,
      unchangedByRender: report.stats.unchanged,
      failedRenders: report.stats.failedRenders,
      instances: report.stats.instances,
      validUnderOriginal: report.stats.validOriginal,
      validUnderRendered: report.stats.validRendered,
      refusedByBoundary: report.stats.refused,
      oracleErrors: report.stats.oracleErrors,
      unverifiableUnsatisfiable: report.stats.unverifiable,
      counterexamples: report.counterexamples,
      seconds: (Date.now() - begun) / 1000,
    })}\n`,
  );
  for (const [reason, example] of Object.entries(report.stats.refusedExamples)) process.stdout.write(`  refused ${reason}: ${example}\n`);
  for (const sample of report.oracleSamples) process.stdout.write(`  oracle-error ${sample}\n`);
  for (const cluster of report.clusters) {
    process.stdout.write(`  cluster ${cluster.signature} x${cluster.count} (minimised ${cluster.minimised})\n`);
    for (const cause of cluster.causes) process.stdout.write(`    cause [${cause.tag}] x${cause.count}: ${cause.example}\n`);
  }
}

const oracleErrorTotal = reports.reduce((sum, report) => sum + report.stats.oracleErrors, 0);
const total = reports.reduce((sum, report) => sum + report.counterexamples, 0) + seedOutcomes.filter((outcome) => outcome.failure !== null || outcome.assertion !== null).length;
process.stdout.write(`total oracle errors: ${oracleErrorTotal}\n`);
process.stdout.write(`total counterexamples: ${total}; wall seconds: ${(Date.now() - started) / 1000}\n`);
process.exitCode = total === 0 && oracleErrorTotal === 0 ? 0 : 1;
