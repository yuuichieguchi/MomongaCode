export const preconditionText = (message: string, detail: string | undefined, remediation: string | undefined): string =>
  [message, ...(detail === undefined ? [] : [detail]), ...(remediation === undefined ? [] : [`remedy: ${remediation}`])].join('\n');
