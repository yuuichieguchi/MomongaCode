import { describe, expect, it } from 'vitest';
import { S2 } from './model-fixtures.ts';
import { documentOf, editModels, homeWith, op, planModels, refusalOfEdit, textOf } from './models-edit.ts';
import type { Planned } from './models-edit.ts';

const OLLAMA_GEMMA = 'ollama/gemma-3-4b:latest';
const LMSTUDIO_GEMMA = 'lmstudio/gemma-3-4b';

const REVIEWED = {
  autoMode: { classifier: OLLAMA_GEMMA },
  memory: { autoReview: true, autoReviewModel: LMSTUDIO_GEMMA, forgetAfterDays: 30 },
  models: { connections: S2.models.connections },
};

const planned = (document: unknown, operations: Parameters<typeof planModels>[1]): Planned => {
  const plan = planModels(document, operations);
  if ('refused' in plan) throw new Error(`the plan was refused: ${plan.refused.message}`);
  return plan;
};

describe('the model of memory auto review in the models writers', () => {
  it('setMemoryReviewModel writes a configured model as a full reference and changes no other key', async () => {
    const home = homeWith({ autoMode: { classifier: OLLAMA_GEMMA }, memory: { forgetAfterDays: 30 }, models: { connections: S2.models.connections } });
    await editModels(home, [op('setMemoryReviewModel', { model: LMSTUDIO_GEMMA })]);
    expect(documentOf(home)).toEqual({ autoMode: { classifier: OLLAMA_GEMMA }, memory: { forgetAfterDays: 30, autoReviewModel: LMSTUDIO_GEMMA }, models: { connections: S2.models.connections } });
  });

  it('setMemoryReviewModel leaves the switch as it is', async () => {
    const home = homeWith({ memory: { autoReview: false }, models: { connections: S2.models.connections } });
    await editModels(home, [op('setMemoryReviewModel', { model: OLLAMA_GEMMA })]);
    expect(documentOf(home)['memory']).toEqual({ autoReview: false, autoReviewModel: OLLAMA_GEMMA });
  });

  it('setMemoryReviewModel refuses a model that is not configured and writes nothing', async () => {
    const home = homeWith({ memory: { autoReview: true }, models: { connections: S2.models.connections } });
    const before = textOf(home);
    const refused = await refusalOfEdit(editModels(home, [op('setMemoryReviewModel', { model: 'ollama/nope' })]));
    expect(refused.code).toBe('unresolved');
    expect(textOf(home)).toBe(before);
  });

  it('removing the model drops memory.autoReviewModel and keeps the rest of memory', () => {
    const removal = planned(REVIEWED, [op('removeModel', { model: LMSTUDIO_GEMMA })]);
    expect(removal.document['memory']).toEqual({ autoReview: true, forgetAfterDays: 30 });
    expect(removal.document['autoMode']).toEqual({ classifier: OLLAMA_GEMMA });
  });

  it('removing a model the review does not use leaves memory.autoReviewModel as it was', () => {
    const removal = planned({ ...REVIEWED, autoMode: {} }, [op('removeModel', { model: OLLAMA_GEMMA })]);
    expect(removal.document['memory']).toEqual(REVIEWED.memory);
  });

  it('renaming the provider of the model rewrites memory.autoReviewModel in the same write', async () => {
    const home = homeWith(REVIEWED);
    await editModels(home, [op('setProvider', { provider: 'lmstudio', name: 'studio' })]);
    expect(documentOf(home)['memory']).toEqual({ autoReview: true, autoReviewModel: 'studio/gemma-3-4b', forgetAfterDays: 30 });
  });

  it('renaming the model by its id rewrites memory.autoReviewModel in the same write', async () => {
    const home = homeWith(REVIEWED);
    await editModels(home, [op('setModelField', { model: LMSTUDIO_GEMMA, path: ['id'], value: 'gemma-3-12b' })]);
    expect(documentOf(home)['memory']).toEqual({ autoReview: true, autoReviewModel: 'lmstudio/gemma-3-12b', forgetAfterDays: 30 });
  });

  it('a removal counts memory.autoReviewModel among the references it changes', () => {
    const without = planned({ models: REVIEWED.models }, [op('removeModel', { model: LMSTUDIO_GEMMA })]);
    const withReview = planned({ memory: REVIEWED.memory, models: REVIEWED.models }, [op('removeModel', { model: LMSTUDIO_GEMMA })]);
    expect(withReview.references.length).toBe(without.references.length + 1);
  });
});
