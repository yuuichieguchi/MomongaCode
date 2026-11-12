import { EXIT_FAILURE, EXIT_OK } from '@momonga/foundation';

export const exitOfMeasurement = (passed: boolean): number => (passed ? EXIT_OK : EXIT_FAILURE);
