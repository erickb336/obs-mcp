// What a test opens and must close: fake OBS servers, server processes and in-process servers. When the tests of a
// file end, the root after hook closes what is still open, newest first. So a test that fails before its own close
// cannot keep the process of its file alive, and the test run ends without --test-force-exit.
import { after } from 'node:test';

const open = new Set();
// Only in the process of a test file: a script that imports the helpers (a probe, or the timing loop that a test
// starts) gets no test report.
if (process.env.NODE_TEST_CONTEXT && process.argv[1]?.endsWith('.test.mjs')) {
  after(async () => {
    for (const close of [...open].reverse()) await close().catch(() => {});
  });
}

/** Registers a close function. Returns it, wrapped so that it runs once and leaves the list. */
export function tracked(close) {
  let done;
  const once = () => {
    open.delete(once);
    return (done ??= Promise.resolve().then(close));
  };
  open.add(once);
  return once;
}
