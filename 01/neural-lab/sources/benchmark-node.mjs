import { Worker } from 'node:worker_threads';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';

const phrases = [
  'Сейчас здесь находится сувенирный магазин.',
  'Мы должны добраться до замка до наступления темноты. Возьми карту и проверь, какой дорогой нам лучше идти.'
];
const dialogue = 'Ты слышишь меня? Нам нужно уходить, пока стража не вернулась. Подожди… Я кое-что заметил у двери. Кажется, здесь есть другой путь!';
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function startWorker() {
  const worker = new Worker(new URL('./worker-node.mjs', import.meta.url));
  let sequence = 0;
  const jobs = new Map();
  worker.on('message', data => {
    const job = jobs.get(data.id);
    if (!job) return;
    clearTimeout(job.timer); jobs.delete(data.id);
    if (data.ok) job.resolve(data); else job.reject(new Error(data.error));
  });
  worker.on('error', error => {
    for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(error); }
    jobs.clear();
  });
  return {
    async request(data) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { jobs.delete(id); reject(new Error('Worker timeout')); }, 45000);
        jobs.set(id, { resolve, reject, timer });
        worker.postMessage({ id, ...data });
      });
    },
    close: () => worker.terminate()
  };
}

async function wav(result, destination) {
  const pcm = new Float32Array(result.pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length * 2, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(result.sampleRate, 24); header.writeUInt32LE(result.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length * 2, 40);
  const samples = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) samples.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), i * 2);
  await writeFile(destination, Buffer.concat([header, samples]));
}

function measure(result, text, initReads) {
  assert.equal(result.testHarnessFileReads, initReads, 'Unexpected post-init file read');
  assert.equal(result.assetReadsDuringSynthesis, 0);
  assert.equal(result.sampleRate, 22050);
  assert(result.count > 1000);
  const pcm = new Float32Array(result.pcm);
  assert(pcm.some(value => Math.abs(value) > 0.01));
  assert(pcm.every(Number.isFinite));
  return {
    text, synthesisMs: result.synthesisMs, readyMs: result.readyMs,
    phonemeMs: result.phonemeMs, inferenceMs: result.inferenceMs,
    duration: result.duration, realTimeFactor: result.realTimeFactor,
    assetReadsDuringSynthesis: result.assetReadsDuringSynthesis
  };
}

const trials = [];
for (let trial = 0; trial < 3; trial++) {
  const bridge = startWorker();
  try {
    const start = performance.now();
    const init = await bridge.request({ type: 'init' });
    const initializationMs = performance.now() - start;
    const first = await bridge.request({ type: 'synthesize', text: phrases[0], rate: 1 });
    const firstInfo = measure(first, phrases[0], init.testHarnessFileReads);
    if (trial === 0) await wav(first, new URL('../../sample-dmitri-short.wav', import.meta.url));
    const normal = [];
    const long = [];
    for (const [group, text] of [[normal, phrases[0]], [long, phrases[1]]]) {
      for (let run = 0; run < 5; run++) {
        const result = await bridge.request({ type: 'synthesize', text, rate: 1 });
        group.push(measure(result, text, init.testHarnessFileReads));
      }
    }
    trials.push({ initializationMs, first: firstInfo, normal, long });
    console.log(JSON.stringify({ trial: trial + 1, initializationMs,
      firstMs: first.readyMs, normalMedianMs: median(normal.map(x => x.readyMs)),
      longMedianMs: median(long.map(x => x.readyMs)), fileReadsDuringSynthesis: 0 }));
    if (trial === 0) {
      const result = await bridge.request({ type: 'synthesize', text: dialogue, rate: 1 });
      measure(result, dialogue, init.testHarnessFileReads);
      await wav(result, new URL('../../sample-dmitri-dialogue.wav', import.meta.url));
      let slow;
      for (const rate of [0.5, 1.5]) {
        const speed = await bridge.request({ type: 'synthesize', text: 'Привет! Как у тебя дела?', rate });
        measure(speed, 'rate test', init.testHarnessFileReads);
        if (rate === 0.5) slow = speed.duration;
        else assert(slow > speed.duration * 2, 'Rate must affect synthesized duration');
      }
      await assert.rejects(() => bridge.request({ type: 'synthesize', text: '', rate: 1 }));
      await assert.rejects(() => bridge.request({ type: 'synthesize', text: 'Проверка.', rate: 2 }));
      await assert.rejects(() => bridge.request({ type: 'synthesize', text: 'А'.repeat(241), rate: 1 }));
      const recovery = await bridge.request({ type: 'synthesize', text: 'Проверка после ошибки.', rate: 1 });
      measure(recovery, 'recovery', init.testHarnessFileReads);
    }
  } finally { await bridge.close(); }
}
const report = {
  created: new Date().toISOString(), environment: {
    runtime: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0].model, wasmThreads: 1, nativeOnnxRuntime: false,
    cameraAndOCR: false, assetLoading: 'local files only; forbidden after init'
  }, voice: 'Dmitri', model: 'ru_RU-dmitri-medium', rate: 1, phrases, trials,
  summary: {
    initializationMedianMs: median(trials.map(x => x.initializationMs)),
    firstMedianMs: median(trials.map(x => x.first.readyMs)),
    normalMedianMs: median(trials.flatMap(x => x.normal.map(y => y.readyMs))),
    longMedianMs: median(trials.flatMap(x => x.long.map(y => y.readyMs)))
  }
};
await writeFile(new URL('../../benchmark-linux.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log('PASS', JSON.stringify(report.summary));
