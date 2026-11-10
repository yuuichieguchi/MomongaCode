import { SECRET_NAME_PATTERN } from '@momonga/foundation';

export const PLAN_LABEL_PATTERN = SECRET_NAME_PATTERN;

const LABEL_SHAPE = new RegExp(PLAN_LABEL_PATTERN);

export const isPlanLabel = (value: unknown): value is string => typeof value === 'string' && LABEL_SHAPE.test(value);
