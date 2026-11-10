import * as ort from '../neural-lab/assets/ort.wasm.min.mjs';
import '../neural-lab/assets/piper_phonemize.js';

const asset = name => new URL('../neural-lab/assets/' + name, import.meta.url);
const MAX_TEXT = 240;
let session = null;
let configuration = null;
let compiledPhonemizer = null;
let phonemizerData = null;
let loading = null;
let assetReads = 0;

async function bytes(name) {
  assetReads++;
  const response = await fetch(asset(name));
  if (!response.ok) throw new Error('Не найден файл: ' + name);
  return response.arrayBuffer();
}

async function json(name) {
  return JSON.parse(new TextDecoder().decode(await bytes(name)));
}

async function loadModel() {
  const info = await json('model-parts.json');
  if (info.bytes !== 63201294 || info.parts.length !== 8) {
    throw new Error('Неправильный комплект модели Dmitri.');
  }
  const joined = new Uint8Array(info.bytes);
  let offset = 0;
  // Sequential reads avoid retaining eight additional large buffers on iPhone.
  for (const item of info.parts) {
    if (!/^dmitri-\d{2}\.bin$/.test(item.path)) throw new Error('Неправильное имя части модели.');
    const part = await bytes(item.path);
    if (part.byteLength !== item.bytes || offset + part.byteLength > joined.byteLength) {
      throw new Error('Неполная часть модели: ' + item.path);
    }
    joined.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  if (offset !== info.bytes) throw new Error('Модель загружена не полностью.');
  return joined;
}

async function initialize() {
  if (loading) return loading;
  loading = (async () => {
    const started = performance.now();
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = asset('').href;
    const [runtime, phonemizerWasm, data, config, model] = await Promise.all([
      bytes('ort-wasm-simd-threaded.wasm'),
      bytes('piper_phonemize.wasm'),
      bytes('piper_phonemize.data'),
      json('dmitri.json'),
      loadModel()
    ]);
    if (config.espeak?.voice !== 'ru' || config.num_speakers !== 1) {
      throw new Error('Конфигурация не соответствует русскому голосу Dmitri.');
    }
    configuration = config;
    phonemizerData = data;
    compiledPhonemizer = await WebAssembly.compile(phonemizerWasm);
    // The runtime receives its binary here; synthesis never downloads it later.
    ort.env.wasm.wasmBinary = new Uint8Array(runtime);
    session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      enableCpuMemArena: true,
      enableMemPattern: true
    });
    if (session.inputNames.join(',') !== 'input,input_lengths,scales') {
      await session.release();
      session = null;
      throw new Error('Модель имеет неожиданный формат входных данных.');
    }
    return {
      voice: 'Dmitri', engine: 'Piper / ONNX Runtime Web 1.24.3 / WASM SIMD',
      initMs: performance.now() - started, assetReads,
      sampleRate: configuration.audio.sample_rate,
      modelBytes: model.byteLength, threads: 1
    };
  })().catch(async error => {
    if (session) { try { await session.release(); } catch {} }
    session = null;
    loading = null;
    throw error;
  });
  return loading;
}

async function phonemes(text) {
  const ids = [];
  const errors = [];
  // The command-line phonemizer is invoked once per instance. Its already
  // compiled WASM module and immutable data are reused, without I/O. This
  // avoids accumulating the CLI main() stack across successive utterances.
  const phonemizer = await globalThis.GameVoicePhonemizer({
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(compiledPhonemizer, imports);
      receive(instance, compiledPhonemizer);
      return instance.exports;
    },
    getPreloadedPackage: () => phonemizerData,
    noInitialRun: true,
    noExitRuntime: true,
    print(line) {
      const parsed = JSON.parse(line);
      if (!Array.isArray(parsed.phoneme_ids)) throw new Error('Нет фонем для произношения.');
      ids.push(...parsed.phoneme_ids);
    },
    printErr(line) { errors.push(String(line)); }
  });
  const code = phonemizer.callMain([
    '-l', 'ru', '--input', JSON.stringify([{ text }]),
    '--espeak_data', '/espeak-ng-data'
  ]);
  if (code !== 0 || !ids.length || ids.length > 2500 ||
      ids.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error('Не удалось подготовить произношение. ' + errors.slice(0, 2).join(' '));
  }
  return splitPhonemeIds(ids, configuration.phoneme_id_map['^'][0], configuration.phoneme_id_map['$'][0]);
}

export function splitPhonemeIds(ids, bos = 1, eos = 2) {
  const groups = [];
  let sentence = null;
  for (const id of ids) {
    if (id === bos) {
      if (sentence) throw new Error('Неполная последовательность фонем.');
      sentence = [id];
    } else {
      if (!sentence) throw new Error('Нет начала предложения в фонемах.');
      sentence.push(id);
      if (id === eos) { groups.push(sentence); sentence = null; }
    }
  }
  if (sentence || !groups.length) throw new Error('Нет окончания предложения в фонемах.');
  return groups;
}

async function synthesize(text, rate) {
  if (!session) throw new Error('Сначала подготовьте голос.');
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
    throw new Error('Введите от 1 до ' + MAX_TEXT + ' символов.');
  }
  if (![0.5, 1, 1.5].includes(rate)) throw new Error('Недопустимая скорость речи.');
  const beforeReads = assetReads;
  const started = performance.now();
  const groups = await phonemes(text.trim());
  const phonemeMs = performance.now() - started;
  const parts = [];
  let inferenceMs = 0;
  // Piper's BOS/EOS delimit complete sentences. Each pair needs its own run;
  // concatenating multiple BOS/EOS sequences into one tensor corrupts the input.
  for (const ids of groups) {
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([ids.length], BigInt), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([
        configuration.inference.noise_scale,
        configuration.inference.length_scale / rate,
        configuration.inference.noise_w
      ]), [3])
    };
    let outputs;
    try {
      const inferenceStart = performance.now();
      outputs = await session.run(feeds);
      inferenceMs += performance.now() - inferenceStart;
      const raw = outputs.output?.data;
      if (!(raw instanceof Float32Array) || raw.length < 100) throw new Error('Движок не вернул звук.');
      const pcm = new Float32Array(raw);
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) {
        if (!Number.isFinite(pcm[i])) throw new Error('Повреждён результат синтеза.');
        peak = Math.max(peak, Math.abs(pcm[i]));
        pcm[i] = Math.max(-1, Math.min(1, pcm[i]));
      }
      if (peak < 0.00001) throw new Error('Движок вернул тишину.');
      parts.push(pcm);
    } finally {
      for (const tensor of Object.values(feeds)) tensor.dispose();
      if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
    }
  }
  // Copy the COMPLETE waveforms, including final consonants and natural pauses.
  const pcm = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { pcm.set(part, offset); offset += part.length; }
  const readyMs = performance.now() - started;
  return {
    pcm: pcm.buffer, sampleRate: configuration.audio.sample_rate,
    count: pcm.length, duration: pcm.length / configuration.audio.sample_rate,
    synthesisMs: readyMs, readyMs, phonemeMs, inferenceMs, phonemeGroups: groups.length,
    realTimeFactor: readyMs / 1000 / (pcm.length / configuration.audio.sample_rate),
    assetReadsDuringSynthesis: assetReads - beforeReads
  };
}

// A single queue also serializes asynchronous session.run() calls.
let queue = Promise.resolve();
if (typeof self !== 'undefined') self.onmessage = event => {
  const message = event.data;
  queue = queue.then(async () => {
    const { id, type } = message;
    try {
      if (type === 'init') {
        self.postMessage({ id, ok: true, ...await initialize() });
      } else if (type === 'synthesize') {
        const result = await synthesize(message.text, message.rate ?? 1);
        self.postMessage({ id, ok: true, ...result }, [result.pcm]);
      } else {
        throw new Error('Неизвестная команда движка.');
      }
    } catch (error) {
      self.postMessage({ id, ok: false, error: error.message || String(error) });
    }
  });
};

