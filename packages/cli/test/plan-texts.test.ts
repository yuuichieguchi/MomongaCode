import { describe, expect, it } from 'vitest';
import * as texts from '../src/plan/texts.ts';
import * as policyMessages from '../src/policy-messages.ts';
import { CHATGPT } from './fake-plan-gateway.tsx';

const plan = { profile: 'chatgpt', account: 'work' };

describe('the one text module of plan answers, for both surfaces (P-C8)', () => {
  it('signedInLine names the label and the email when it is known', () => {
    expect(texts.signedInLine({ label: 'work' })).toBe('Signed in as work');
    expect(texts.signedInLine({ label: 'work', email: 'w@example.com' })).toBe('Signed in as work (w@example.com)');
  });

  it('tryAgainLine names the command of each surface', () => {
    expect(texts.tryAgainLine('headless', plan)).toBe('Run momonga auth login chatgpt --account work to try again.');
    expect(texts.tryAgainLine('tui', plan)).toBe('Run /login to try again.');
  });

  it('codeNotAcceptedLine names the identity and the try-again line of each surface', () => {
    expect(texts.codeNotAcceptedLine('headless', CHATGPT, 'work')).toBe(
      'ChatGPT did not accept the sign-in code (invalid_grant). Run momonga auth login chatgpt --account work to try again.',
    );
    expect(texts.codeNotAcceptedLine('tui', CHATGPT, 'work')).toBe('ChatGPT did not accept the sign-in code (invalid_grant). Run /login to try again.');
  });

  it('planDisabledLines names the reconsent command in the shell only', () => {
    expect(texts.planDisabledLines('headless', CHATGPT, 'work')).toEqual([`${CHATGPT.messages.planNotEnabledMessage} · Run momonga auth login chatgpt --account work --reconsent to enable it`]);
    expect(texts.planDisabledLines('tui', CHATGPT, 'work')).toEqual([CHATGPT.messages.planNotEnabledMessage]);
  });

  it('reconsentCommand is the one spelling of the reconsent command', () => {
    expect(policyMessages.reconsentCommand({ profile: 'chatgpt', account: 'work' })).toBe('momonga auth login chatgpt --account work --reconsent');
  });

  it('a plan that names no account gives the profile-only commands', () => {
    expect(policyMessages.signInCommandOf('headless', { profile: 'chatgpt' })).toBe('momonga auth login chatgpt');
    expect(policyMessages.signInCommandOf('tui', { profile: 'chatgpt' })).toBe('/login');
    expect(policyMessages.reconsentCommand({ profile: 'chatgpt' })).toBe('momonga auth login chatgpt --reconsent');
    expect(texts.tryAgainLine('headless', { profile: 'chatgpt' })).toBe('Run momonga auth login chatgpt to try again.');
  });

  it('signedOutLines says whether the remote revocation was confirmed', () => {
    expect(texts.signedOutLines(CHATGPT, 'work', { revocation: 'confirmed', usageUrl: 'https://chatgpt.com/settings/usage' })).toEqual(['Signed out work', 'Remote revocation confirmed.']);
    expect(texts.signedOutLines(CHATGPT, 'work', { revocation: 'unconfirmed', usageUrl: 'https://chatgpt.com/settings/usage' })).toEqual([
      'Signed out work',
      'Remote revocation was not confirmed; disconnect the app in ChatGPT Settings: https://chatgpt.com/settings/usage',
    ]);
  });

  it('signedOutLines says an account with nothing to sign out was already signed out', () => {
    expect(texts.signedOutLines(CHATGPT, 'work', { revocation: 'none', usageUrl: 'https://chatgpt.com/settings/usage' })).toEqual(['work was already signed out.']);
  });

  it('listProblemLine names the file and the cause', () => {
    expect(texts.listProblemLine({ file: 'abc123.json', cause: 'the file mode is 644' })).toBe('could not list abc123.json: the file mode is 644');
  });

  it('resumeLine honours resumed', () => {
    expect(texts.resumeLine('work', true)).toBe('Resumed plan use for work');
    expect(texts.resumeLine('work', false)).toBe('work is not paused');
  });

  it('noBrowserHintLine names the --no-browser form of the command', () => {
    expect(texts.noBrowserHintLine('chatgpt', 'work')).toBe(
      'If no browser window opens, press Ctrl-C and run momonga auth login chatgpt --account work --no-browser to get the sign-in URL.',
    );
  });

  it('sensitiveUrlLines marks the URL as sensitive on the line above it', () => {
    expect(texts.SENSITIVE_URL_LINE).toBe('Open this URL (it is sensitive: do not share it):');
    expect(texts.sensitiveUrlLines(new URL('https://auth.example.test/authorize?x=1'))).toEqual(['Open this URL (it is sensitive: do not share it):', 'https://auth.example.test/authorize?x=1']);
  });
});
