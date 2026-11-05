import { SAMPLING_FIELDS, acceptedReasoningEfforts, clampReasoningEffort, isReasoningEffort } from '@momonga/protocol';
import type { AdapterSampling, Capabilities, CreateResponseBody, ReasoningCapability, SamplingField } from '@momonga/protocol';

export type SamplingRefusal = { field: SamplingField; targetName: string; message: string };

export type SamplingRequest = Pick<CreateResponseBody, SamplingField | 'reasoning'>;

const thinkingIsOn = (effort: unknown, reasoning: ReasoningCapability | undefined): boolean => {
  if (!isReasoningEffort(effort) || reasoning === undefined || reasoning.control === 'none') return false;
  return clampReasoningEffort(effort, acceptedReasoningEfforts(reasoning)) !== 'none';
};

const refusal = (field: SamplingField, targetName: string, reason: string): SamplingRefusal => ({
  field,
  targetName,
  message: `${field} is not accepted by target "${targetName}": ${reason}`,
});

export const carriesSampling = (request: SamplingRequest): boolean => SAMPLING_FIELDS.some((field) => request[field] !== undefined && request[field] !== null);

export const samplingRefusalOf = (
  request: SamplingRequest,
  target: { name: string; kind: string },
  adapter: AdapterSampling,
  capabilities: Pick<Capabilities, 'sampling' | 'reasoning'>,
): SamplingRefusal | undefined => {
  const thinking = thinkingIsOn(request.reasoning?.effort, capabilities.reasoning);
  const declared = capabilities.sampling;
  for (const field of SAMPLING_FIELDS) {
    const value = request[field];
    if (value === undefined || value === null) continue;
    if (!adapter.renders.includes(field)) return refusal(field, target.name, `the ${target.kind} adapter declares no wire field for it`);
    if (adapter.bound !== undefined && !adapter.bound.accepts.includes(field)) {
      return refusal(field, target.name, `${adapter.bound.label} accepts no ${field}`);
    }
    if (declared === undefined || declared.accepts === 'free') continue;
    if (declared.accepts === 'none') return refusal(field, target.name, 'its capabilities.sampling declares that it accepts none');
    if (!thinking) continue;
    if (field !== 'top_p') return refusal(field, target.name, 'its capabilities.sampling accepts only top_p while thinking is on');
    const { min, max } = declared.topP;
    if (value < min || value > max) {
      return refusal(field, target.name, `top_p ${value} is outside ${min} to ${max}, the range its capabilities.sampling accepts while thinking is on`);
    }
  }
  return undefined;
};
