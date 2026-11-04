import type { ImageTokenModel } from '@momonga/protocol';
import { solidPngDataUrl } from './solid-png.ts';

export const IMAGE_PROMPT = 'Describe this image.';
export const SEARCH_TOLERANCE = 0.01;
const IMAGE_PROBE_SMALL_SIDE = 512;
const IMAGE_PROBE_LARGE_SIDE = 2048;
const IMAGE_PROBE_MAX_SIDE = 8192;
const TINY_PNG_SIDE = 1;
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';


type ImageCost = { rejected: true } | { rejected: false; promptTokens: number | undefined };

type MeasuredImage = { side: number; tokens: number };

type Measurement = MeasuredImage | 'rejected' | 'unusable';

export type ImageCostProbe = {
  baseline: () => Promise<number | undefined>;
  cost: (imageUrl: string) => Promise<ImageCost>;
};

const measureUrl = async (probe: ImageCostProbe, baseline: number, side: number, imageUrl: string): Promise<Measurement> => {
  const cost = await probe.cost(imageUrl);
  if (cost.rejected) return 'rejected';
  if (cost.promptTokens === undefined || cost.promptTokens - baseline <= 0) return 'unusable';
  return { side, tokens: cost.promptTokens - baseline };
};

const measureSide = (probe: ImageCostProbe, baseline: number, side: number): Promise<Measurement> => measureUrl(probe, baseline, side, solidPngDataUrl(side));

const bisectLargestAccepted = async (probe: ImageCostProbe, baseline: number, accepted: MeasuredImage, rejectedFrom: number): Promise<MeasuredImage | undefined> => {
  let largest = accepted;
  let rejectedSide = rejectedFrom;
  while (rejectedSide - largest.side > Math.max(1, Math.floor(largest.side * SEARCH_TOLERANCE))) {
    const middle = Math.floor((largest.side + rejectedSide) / 2);
    const measured = await measureSide(probe, baseline, middle);
    if (measured === 'unusable') return undefined;
    if (measured === 'rejected') rejectedSide = middle;
    else largest = measured;
  }
  return largest;
};

type Ceiling = { largest: MeasuredImage; plateau: boolean };

const findCeiling = async (probe: ImageCostProbe, baseline: number, small: MeasuredImage, floorTokens: number): Promise<Ceiling | undefined> => {
  let previous = small;
  for (let side = IMAGE_PROBE_LARGE_SIDE; side <= IMAGE_PROBE_MAX_SIDE; side *= 2) {
    const measured = await measureSide(probe, baseline, side);
    if (measured === 'unusable') return undefined;
    if (measured === 'rejected') {
      const largest = await bisectLargestAccepted(probe, baseline, previous, side);
      return largest === undefined ? undefined : { largest, plateau: false };
    }
    if (measured.tokens <= previous.tokens && previous.tokens > floorTokens) return { largest: measured, plateau: true };
    previous = measured;
  }
  return { largest: previous, plateau: false };
};

const referenceBelowPlateau = async (probe: ImageCostProbe, baseline: number, start: MeasuredImage, model: Pick<ImageTokenModel, 'minTokens' | 'maxTokens'>, plateau: boolean): Promise<MeasuredImage | undefined> => {
  let candidate = start;
  for (;;) {
    if (candidate.tokens <= model.minTokens) return undefined;
    if (!plateau || candidate.tokens < model.maxTokens) return candidate;
    const side = Math.floor(candidate.side / 2);
    if (side < 1) return undefined;
    const measured = await measureSide(probe, baseline, side);
    if (measured === 'rejected' || measured === 'unusable') return undefined;
    candidate = measured;
  }
};

export const measureImageTokens = async (probe: ImageCostProbe): Promise<ImageTokenModel | undefined> => {
  const baseline = await probe.baseline();
  if (baseline === undefined) return undefined;
  const tiny = await measureUrl(probe, baseline, TINY_PNG_SIDE, TINY_PNG);
  if (tiny === 'rejected' || tiny === 'unusable') return undefined;
  const small = await measureSide(probe, baseline, IMAGE_PROBE_SMALL_SIDE);
  if (small === 'unusable') return undefined;
  const ceiling =
    small === 'rejected'
      ? { largest: await bisectLargestAccepted(probe, baseline, tiny, IMAGE_PROBE_SMALL_SIDE), plateau: false }
      : await findCeiling(probe, baseline, small, tiny.tokens);
  if (ceiling?.largest === undefined || ceiling.largest.side === tiny.side) return undefined;
  const { largest, plateau } = ceiling;
  const model = { minTokens: tiny.tokens, maxTokens: largest.tokens };
  const start = small === 'rejected' ? largest : small;
  const reference = model.minTokens === model.maxTokens ? start : await referenceBelowPlateau(probe, baseline, start, model, plateau);
  if (reference === undefined) return undefined;
  return { pixelsPerToken: reference.side ** 2 / reference.tokens, ...model };
};

