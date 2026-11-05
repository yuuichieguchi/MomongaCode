import { SAMPLING_FIELDS, acceptedReasoningEfforts, clampReasoningEffort, isReasoningEffort } from '@momonga/protocol';
import type { AdapterSampling, CreateResponseBody, DeclaredSamplingCapabilities, ReasoningCapability, SamplingField } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';

const thinkingIsOn = (effort: unknown, reasoning: ReasoningCapability | undefined): boolean => {
  if (!isReasoningEffort(effort) || reasoning === undefined || reasoning.control === 'none') return false;
  return clampReasoningEffort(effort, acceptedReasoningEfforts(reasoning)) !== 'none';
};

const refusal = (field: SamplingField, targetName: string, reason: string) =>
  invalidRequest('sampling_not_accepted', `${field} is not accepted by target "${targetName}": ${reason}`, field);

export const assertSamplingAccepted = (
  body: CreateResponseBody,
  target: { name: string; kind: string },
  adapter: AdapterSampling | undefined,
  capabilities: Pick<DeclaredSamplingCapabilities, 'sampling' | 'reasoning'>,
): void => {
  const thinking = thinkingIsOn(body.reasoning?.effort, capabilities.reasoning);
  const declared = capabilities.sampling;
  for (const field of SAMPLING_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (adapter === undefined || !adapter.renders.includes(field)) {
      throw refusal(field, target.name, `the ${target.kind} adapter declares no wire field for it`);
    }
    if (adapter.bound !== undefined && !adapter.bound.accepts.includes(field)) {
      throw refusal(field, target.name, `${adapter.bound.label} accepts no ${field}`);
    }
    if (declared === undefined || declared.accepts === 'free') continue;
    if (declared.accepts === 'none') {
      throw refusal(field, target.name, 'its capabilities.sampling declares that it accepts none');
    }
    if (!thinking) continue;
    if (field !== 'top_p') {
      throw refusal(field, target.name, 'its capabilities.sampling accepts only top_p while thinking is on');
    }
    const { min, max } = declared.topP;
    if (value < min || value > max) {
      throw refusal(field, target.name, `top_p ${value} is outside ${min} to ${max}, the range its capabilities.sampling accepts while thinking is on`);
    }
  }
};

export const carriesSampling = (body: CreateResponseBody): boolean => SAMPLING_FIELDS.some((field) => body[field] !== undefined && body[field] !== null);
