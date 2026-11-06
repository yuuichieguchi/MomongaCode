import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { CrossCheck } from '../src/dialect-model/harness.ts';
import type { Json } from '../src/dialect-model/json.ts';
import { runSubject, SUBJECTS } from '../src/dialect-model/subjects.ts';

const SCHEMAS_PER_SUBJECT = Number(process.env['DIALECT_MODEL_SCHEMAS'] ?? '300');
const GATE_TIMEOUT_MS = 60 * 60 * 1000;
const RECYCLE_EVERY = 2500;

class AjvCrossCheck implements CrossCheck {
  private ajv = new Ajv2020.default({ strict: false, validateFormats: false });
  private compiled = 0;

  compile(schema: Json | undefined): ((value: Json) => boolean | null) | null {
    this.compiled += 1;
    if (this.compiled % RECYCLE_EVERY === 0) this.ajv = new Ajv2020.default({ strict: false, validateFormats: false });
    try {
      const validate = this.ajv.compile((schema === undefined ? true : schema) as never);
      return (value) => {
        try {
          return validate(value) === true;
        } catch {
          return null;
        }
      };
    } catch {
      return null;
    }
  }
}

describe('dialect model: the reference model agrees with Ajv, an engine the product does not use', () => {
  const crossCheck = new AjvCrossCheck();
  it.each(SUBJECTS.map((spec) => [spec.name, spec] as const))(
    '%s has no disagreement and no crash',
    (name, spec) => {
      const report = runSubject(spec, SCHEMAS_PER_SUBJECT, 20261105, () => undefined, undefined, crossCheck);
      const counts = { disagreements: report.stats.crossCheckDisagreements, crashes: report.stats.crossCheckCrashes };
      process.stdout.write(`ajvCrossCheck ${name} ${JSON.stringify(counts)}\n`);
      expect({ ...counts, samples: report.stats.crossCheckSamples }).toEqual({ disagreements: 0, crashes: 0, samples: [] });
    },
    GATE_TIMEOUT_MS,
  );
});
