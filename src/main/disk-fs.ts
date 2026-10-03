import { promises as nodeFs } from 'node:fs';

// User files need real inode/directory metadata, not Electron's virtual ASAR view.
// Keep the normal ASAR support for loading WWG's own bundled UI and modules.
export const diskFs: typeof nodeFs = process.versions.electron
  ? (require('original-fs') as typeof import('node:fs')).promises
  : nodeFs;
