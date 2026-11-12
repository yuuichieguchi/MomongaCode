export const NO_SERVER_ANSWERED_TEXT = 'No model server answered on this computer.';

export const noServerAnsweredAtText = (address: string): string => `No model server answered at ${address}. Add it anyway?`;

export const noServerAnsweredStatementOf = (address: string): string => `No model server answered at ${address}. To add a model there anyway: momonga models add --address ${address} --api <api> --model <id>`;

export const RUN_AGAIN_WITH_YES_TEXT = 'Run again with --yes to write it.';

export const NOT_LISTED_BY_SERVER_MARK = 'not listed by the server';

export const notListedByServerText = (display: string, ownName: string): string => `The server of ${display} does not list "${ownName}". Remove the model, or check that the server serves it.`;

