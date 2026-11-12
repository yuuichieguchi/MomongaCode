import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDataset, loadTranscripts, nodeEvalFiles, replayDataset, saveTranscript, transcriptFileName } from '@momonga/eval';
import { finalAnswerTranscript, goldenCase } from './fixtures.ts';
import { createTempDir } from '@momonga/testkit';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const tempDirectory = (): string => {
  const directory = createTempDir();
  directories.push(directory);
  return directory;
};

describe('transcript and dataset files', () => {
  it('saves transcripts as private JSONL files and loads them back in order', async () => {
    const directory = tempDirectory();
    const second = finalAnswerTranscript('answer', 1);
    const first = finalAnswerTranscript('answer', 0);
    const savedSecond = await saveTranscript(nodeEvalFiles, directory, second);
    await saveTranscript(nodeEvalFiles, directory, first);
    fs.writeFileSync(path.join(directory, 'ignored.txt'), 'not a transcript');
    expect(path.basename(savedSecond)).toBe(transcriptFileName(second));
    expect(fs.statSync(savedSecond).mode & 0o777).toBe(0o600);
    expect(await loadTranscripts(nodeEvalFiles, directory)).toEqual([first, second]);
  });

  it('refuses to overwrite a recorded transcript', async () => {
    const directory = tempDirectory();
    await saveTranscript(nodeEvalFiles, directory, finalAnswerTranscript('answer', 0));
    await expect(saveTranscript(nodeEvalFiles, directory, finalAnswerTranscript('answer', 0))).rejects.toThrow(/EEXIST/);
  });

  it('loads a dataset file and replays recorded transcripts against it', async () => {
    const directory = tempDirectory();
    const dataset = {
      format: 'momonga-eval/1',
      name: 'files',
      cases: [goldenCase({ id: 'answer', runs: 2, graders: [{ kind: 'finalTextEquals', text: 'hi' }] })],
    };
    const file = path.join(directory, 'dataset.json');
    fs.writeFileSync(file, JSON.stringify(dataset));
    await saveTranscript(nodeEvalFiles, directory, finalAnswerTranscript('answer', 0));
    await saveTranscript(nodeEvalFiles, directory, finalAnswerTranscript('answer', 1));
    const report = replayDataset(await loadDataset(nodeEvalFiles, file), await loadTranscripts(nodeEvalFiles, directory));
    expect(report.passed).toBe(true);
    expect(report.overall).toMatchObject({ successes: 2, trials: 2 });
  });

  it('rejects a corrupt transcript file naming the file', async () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, 'broken.transcript.jsonl'), 'not json\n');
    await expect(loadTranscripts(nodeEvalFiles, directory)).rejects.toThrow(/broken\.transcript\.jsonl:1: not valid JSON/);
  });
});
