const TERMINAL_ESCAPES =
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$)|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[ -/]*[0-~]/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const INVISIBLE_CHARACTERS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export const sanitizeServerText = (text: string): string =>
  text.toWellFormed().replace(TERMINAL_ESCAPES, '').replace(CONTROL_CHARACTERS, '').replace(INVISIBLE_CHARACTERS, '');

export const capText = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
