import { renameSync } from "node:fs";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Move a fully written temp file over its destination. On Windows a rename onto a file that
 * another process is replacing or reading at that moment fails with EPERM/EACCES/EBUSY for
 * a few milliseconds, so retry briefly (as graceful-fs does) before giving up.
 */
export function replaceFile(tmp: string, dest: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!(code === "EPERM" || code === "EACCES" || code === "EBUSY") || attempt >= 10) throw err;
      Atomics.wait(sleepCell, 0, 0, 10 * attempt);
    }
  }
}
