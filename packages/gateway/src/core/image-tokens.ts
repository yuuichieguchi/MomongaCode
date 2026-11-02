import { dimensionsOfBase64 } from './image-size.ts';

const PIXELS_PER_TOKEN = 750;
const IMAGE_TOKEN_CEILING = 1600;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const DATA_URL_PAYLOAD = /^data:[^;,]+;base64,(.*)$/s;

const tokensForDimensions = (width: number, height: number): number => Math.min(IMAGE_TOKEN_CEILING, Math.ceil((width * height) / PIXELS_PER_TOKEN));

const tokensForBase64 = (data: string): number => {
  const dimensions = dimensionsOfBase64(data);
  return dimensions === undefined ? IMAGE_TOKEN_CEILING : tokensForDimensions(dimensions.width, dimensions.height);
};

const tokensForUrl = (url: unknown): number => {
  const payload = typeof url === 'string' ? DATA_URL_PAYLOAD.exec(url)?.[1] : undefined;
  return payload === undefined ? IMAGE_TOKEN_CEILING : tokensForBase64(payload);
};

const imageTokensOfNode = (node: Record<string, unknown>): number | undefined => {
  switch (node['type']) {
    case 'input_image':
      return tokensForUrl(node['image_url']);
    case 'image_url': {
      const reference = node['image_url'];
      return tokensForUrl(isRecord(reference) ? reference['url'] : undefined);
    }
    case 'image': {
      const source = node['source'];
      return isRecord(source) && source['type'] === 'base64' && typeof source['data'] === 'string' ? tokensForBase64(source['data']) : IMAGE_TOKEN_CEILING;
    }
    default:
      return undefined;
  }
};

export type WithoutImages = { value: unknown; imageTokens: number };

export const withoutImages = (value: unknown): WithoutImages => {
  let imageTokens = 0;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!isRecord(node)) return node;
    const tokens = imageTokensOfNode(node);
    if (tokens !== undefined) {
      imageTokens += tokens;
      return { type: node['type'] };
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, strip(child)]));
  };
  const stripped = strip(value);
  return { value: stripped, imageTokens };
};
