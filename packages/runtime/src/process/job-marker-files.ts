import fs from 'node:fs';

export type JobMarkerFiles = {
  create(marker: string): void;
  remove(marker: string): void;
};

const MARKER_MODE = 0o600;

export const createNodeJobMarkerFiles = (): JobMarkerFiles => ({
  create: (marker) => {
    fs.rmSync(marker, { force: true });
    fs.closeSync(fs.openSync(marker, 'wx', MARKER_MODE));
  },
  remove: (marker) => {
    fs.rmSync(marker, { force: true });
  },
});
