import { isRecord } from '@momonga/foundation';
import type { ImageTokenModel } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';
import { dimensionsOfBase64 } from './image-size.ts';

const DATA_URL_PAYLOAD = /^data:[^;,]+;base64,(.*)$/s;

const imageTokenModelMissing = () =>
  invalidRequest(
    'image_token_model_missing',
    'the target accepts image input but declares no capabilities.imageTokens, so the tokens of an image cannot be estimated',
    'input',
  );

const tokensForDimensions = (width: number, height: number, model: ImageTokenModel): number =>
  Math.max(model.minTokens, Math.min(model.maxTokens, Math.ceil((width * height) / model.pixelsPerToken)));

const tokensForBase64 = (data: string, model: ImageTokenModel): number => {
  const dimensions = dimensionsOfBase64(data);
  return dimensions === undefined ? model.maxTokens : tokensForDimensions(dimensions.width, dimensions.height, model);
};

const tokensForUrl = (url: unknown, model: ImageTokenModel): number => {
  const payload = typeof url === 'string' ? DATA_URL_PAYLOAD.exec(url)?.[1] : undefined;
  return payload === undefined ? model.maxTokens : tokensForBase64(payload, model);
};

const imageTokensOfNode = (node: Record<string, unknown>, model: ImageTokenModel | undefined): number | undefined => {
  switch (node['type']) {
    case 'input_image':
    case 'image_url':
    case 'image':
      break;
    default:
      return undefined;
  }
  if (model === undefined) throw imageTokenModelMissing();
  switch (node['type']) {
    case 'input_image':
      return tokensForUrl(node['image_url'], model);
    case 'image_url': {
      const reference = node['image_url'];
      return tokensForUrl(isRecord(reference) ? reference['url'] : undefined, model);
    }
    default: {
      const source = node['source'];
      return isRecord(source) && source['type'] === 'base64' && typeof source['data'] === 'string' ? tokensForBase64(source['data'], model) : model.maxTokens;
    }
  }
};

export type WithoutImages = { value: unknown; imageTokens: number };

export const withoutImages = (value: unknown, model: ImageTokenModel | undefined): WithoutImages => {
  let imageTokens = 0;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!isRecord(node)) return node;
    const tokens = imageTokensOfNode(node, model);
    if (tokens !== undefined) {
      imageTokens += tokens;
      return { type: node['type'] };
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, strip(child)]));
  };
  const stripped = strip(value);
  return { value: stripped, imageTokens };
};
