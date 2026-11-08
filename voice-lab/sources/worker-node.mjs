import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
let fileReads = 0;
let networkAttempts = 0;
globalThis.self = globalThis;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.protocol !== 'file:') { networkAttempts++; throw new Error('Сеть запрещена в автономном тесте: ' + url); }
  fileReads++;
  return new Response(await fs.readFile(url));
};
globalThis.postMessage = (message, transfer) => parentPort.postMessage({ ...message, fileReads, networkAttempts }, transfer);
await import(workerData.moduleURL);
parentPort.on('message', message => globalThis.onmessage({ data: message }));
parentPort.postMessage({ type: 'boot' });
