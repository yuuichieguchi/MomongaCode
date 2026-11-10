import { resolveStoredModelRef, resolveTypedModelRef, storedModelRef, typedModelText } from '../../src/index.ts';
import type { ModelViews } from '../../src/index.ts';

declare const views: ModelViews;
declare const plain: string;

// @ts-expect-error
resolveTypedModelRef(plain, views);
// @ts-expect-error
resolveStoredModelRef(plain, views);

// @ts-expect-error
resolveTypedModelRef(storedModelRef('ollama/x:latest'), views);

// @ts-expect-error
resolveStoredModelRef(typedModelText('x'), views);

resolveTypedModelRef(typedModelText('x'), views);
resolveStoredModelRef(storedModelRef('ollama/x:latest'), views);
