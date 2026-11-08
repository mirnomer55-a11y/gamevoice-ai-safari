import createRHVoice from './assets/rhvoice.mjs';

let engine = null;
let loading = null;
let ready = false;
const asset = name => new URL('./assets/' + name, import.meta.url);

async function bytes(name) {
  const response = await fetch(asset(name));
  if (!response.ok) throw new Error('Не удалось открыть ' + name);
  return response.arrayBuffer();
}

async function mountPack(buffer) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Для этого теста нужна современная версия Safari или Chrome.');
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const unpacked = await new Response(stream).arrayBuffer();
  const view = new DataView(unpacked);
  const data = new Uint8Array(unpacked);
  const decoder = new TextDecoder();
  if (decoder.decode(data.subarray(0, 8)) !== 'GVARH001') {
    throw new Error('Повреждён пакет голоса.');
  }
  const count = view.getUint32(8, true);
  let offset = 12;
  for (let i = 0; i < count; i++) {
    if (offset + 6 > data.length) throw new Error('Неполный пакет.');
    const pathSize = view.getUint16(offset, true);
    const fileSize = view.getUint32(offset + 2, true);
    offset += 6;
    if (offset + pathSize + fileSize > data.length) throw new Error('Неполный пакет.');
    const relative = decoder.decode(data.subarray(offset, offset + pathSize));
    offset += pathSize;
    if (!/^(languages|voices)\/[a-zA-Z0-9_.\/-]+$/.test(relative) || relative.split('/').includes('..')) {
      throw new Error('Некорректное имя файла в пакете.');
    }
    const path = '/rhvoice/' + relative;
    engine.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    engine.FS.writeFile(path, data.subarray(offset, offset + fileSize));
    offset += fileSize;
  }
  if (offset !== data.length) throw new Error('Некорректный размер пакета.');
}

async function initialize() {
  if (loading) return loading;
  loading = (async () => {
    const start = performance.now();
    const [wasm, russian, anna, aleksandr] = await Promise.all(
      ['rhvoice.wasm', 'russian.pack', 'anna.pack', 'aleksandr.pack'].map(bytes)
    );
    engine = await createRHVoice({ wasmBinary: wasm });
    engine.FS.mkdirTree('/rhvoice');
    engine.FS.mkdirTree('/config');
    for (const pack of [russian, anna, aleksandr]) await mountPack(pack);
    const code = engine.ccall('rhv_init', 'number', ['string', 'string'], ['/rhvoice', '/config']);
    if (code !== 0) throw new Error(engine.ccall('rhv_last_error', 'string', [], []));
    ready = true;
    return {
      initMs: performance.now() - start,
      voices: engine.ccall('rhv_voices', 'string', [], []),
      wasmMemory: engine.HEAP16.buffer.byteLength
    };
  })().catch(error => {
    engine = null;
    ready = false;
    loading = null;
    throw error;
  });
  return loading;
}

// Тяжёлая работа синхронна внутри Worker. Запросы обрабатываются по очереди.
self.onmessage = async event => {
  const { id, type, text, voice, rate = 1 } = event.data;
  try {
    if (type === 'init') {
      const result = await initialize();
      self.postMessage({ id, ok: true, ...result });
      return;
    }
    if (type !== 'synthesize' || !ready) throw new Error('Сначала подготовьте голоса.');
    if (!['Anna', 'Aleksandr'].includes(voice)) throw new Error('Неизвестный голос.');
    if (typeof text !== 'string' || !text.trim() || text.length > 400) {
      throw new Error('Введите от 1 до 400 символов.');
    }
    if (![0.5, 1, 1.5].includes(rate)) throw new Error('Некорректная скорость.');
    const start = performance.now();
    const count = engine.ccall('rhv_speak', 'number',
      ['string', 'string', 'number', 'number', 'number', 'number'],
      [text.trim(), voice, rate, 1, 1, 0]);
    const synthesisMs = performance.now() - start;
    if (count <= 0) throw new Error(engine.ccall('rhv_last_error', 'string', [], []));
    const pointer = engine.ccall('rhv_samples_ptr', 'number', [], []);
    const sampleRate = engine.ccall('rhv_sample_rate', 'number', [], []);
    const samples = engine.HEAP16.slice(pointer >> 1, (pointer >> 1) + count);
    self.postMessage({
      id, ok: true, pcm: samples.buffer, sampleRate, count,
      synthesisMs, readyMs: performance.now() - start,
      duration: count / sampleRate
    }, [samples.buffer]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
};
