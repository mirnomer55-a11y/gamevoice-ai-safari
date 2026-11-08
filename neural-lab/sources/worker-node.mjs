// Executes the exact browser Worker with file-only asset reads. No native ORT.
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
let loaded = false;
let reads = 0;
globalThis.self = globalThis;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.protocol !== 'file:') throw new Error('Network forbidden: ' + url.href);
  if (loaded) throw new Error('Unexpected asset read after initialization: ' + url.href);
  reads++;
  return new Response(await readFile(fileURLToPath(url)));
};
self.postMessage = (result, transfer) => {
  if (result.ok && result.voice === 'Dmitri') loaded = true;
  parentPort.postMessage({ ...result, testHarnessFileReads: reads }, transfer);
};
await import('../worker.mjs');
parentPort.on('message', data => self.onmessage({ data }));
