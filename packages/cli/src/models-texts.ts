export const noModelsText = (): string => 'The gateway lists no models. Run momonga models add to add one.';

export const NO_SERVER_ANSWERED_TEXT = 'No model server answered on this computer.';

export const noServerAnsweredAtText = (address: string): string => `No model server answered at ${address}. Add it anyway?`;

export const RUN_AGAIN_WITH_YES_TEXT = 'Run again with --yes to write it.';

export const NOT_LISTED_BY_SERVER_MARK = 'not listed by the server';

export const notListedByServerText = (display: string, ownName: string): string => `The server of ${display} does not list "${ownName}". Remove the model, or check that the server serves it.`;

export const configureHintText = (settingsFile: string): string =>
  `declare a server in ${settingsFile} under models.connections (see README, Models), or run \`momonga models detect\` to find a local model server`;
