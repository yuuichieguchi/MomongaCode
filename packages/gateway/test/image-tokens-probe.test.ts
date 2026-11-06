import { describe, expect, it } from 'vitest';
import { measureImageTokens } from '../src/probe/image-tokens.ts';
import type { ImageCostProbe } from '../src/probe/image-tokens.ts';

const sideOf = (url: string): number => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').readUInt32BE(16);

const probeOf = (tokensForSide: (side: number) => number, baseline = 10): ImageCostProbe => ({
  baseline: async () => baseline,
  cost: async (url) => ({ rejected: false, promptTokens: baseline + tokensForSide(sideOf(url)) }),
});

const tiles = (side: number): number => Math.ceil(Math.min(side, 768) / 512) ** 2;

describe('measureImageTokens', () => {
  it('measures a server that charges by tile after scaling to a maximum side', async () => {
    const model = await measureImageTokens(probeOf((side) => 85 + 170 * tiles(side)));
    expect(model).toMatchObject({ minTokens: 255, maxTokens: 765 });
    expect(model?.pixelsPerToken).toBeGreaterThan(0);
  });

  it('measures a server that charges by pixel area up to a cap', async () => {
    const model = await measureImageTokens(probeOf((side) => Math.min(1600, Math.max(4, Math.ceil((side * side) / 750)))));
    expect(model).toMatchObject({ minTokens: 4, maxTokens: 1600 });
    expect(model?.pixelsPerToken).toBeCloseTo(750, -1);
  });

  it('measures a server that charges a fixed cost for every size', async () => {
    const model = await measureImageTokens(probeOf(() => 300));
    expect(model).toMatchObject({ minTokens: 300, maxTokens: 300 });
  });
});
