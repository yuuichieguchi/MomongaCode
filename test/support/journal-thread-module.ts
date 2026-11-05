import { writeJournalThreadModule } from '../../scripts/bundle.ts';

export default async function setup(): Promise<void> {
  await writeJournalThreadModule();
}
