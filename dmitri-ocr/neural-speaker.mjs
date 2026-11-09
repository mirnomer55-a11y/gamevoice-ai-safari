const LAB = new URL('../neural-lab/', import.meta.url);
const VOICE_CACHE = 'gamevoice-neural-lab-v1';
const now = () => performance.now();
const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();

export async function prepareVoiceFiles(progress = () => {}) {
  if (!globalThis.isSecureContext || !globalThis.caches) {
    throw new Error('Для Dmitri откройте страницу по HTTPS в Safari.');
  }
  const cache = await caches.open(VOICE_CACHE);
  const manifestURL = new URL('manifest.json', LAB).href;
  const saved = await cache.match(manifestURL);
  const response = saved || await fetch(manifestURL);
  if (!response.ok) throw new Error('Не найдена папка neural-lab рядом с dmitri-ocr.');
  const manifest = await response.json();
  if (manifest.model !== 'ru_RU-dmitri-medium' || manifest.version !== '1.0.0') {
    throw new Error('Для теста нужен прежний комплект Dmitri версии 1.0.0.');
  }
  const digest = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  let complete = 0;
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..')) {
      throw new Error('Неправильный список файлов голоса.');
    }
    const url = new URL(file.path, LAB).href;
    const existing = await cache.match(url);
    let data = existing ? await existing.arrayBuffer() : null;
    if (!data || data.byteLength !== file.bytes || await digest(data) !== file.sha256) {
      const downloaded = await fetch(url, { cache: 'reload' });
      if (!downloaded.ok) throw new Error('Не найден файл голоса: ' + file.path);
      data = await downloaded.arrayBuffer();
      if (data.byteLength !== file.bytes || await digest(data) !== file.sha256) {
        throw new Error('Повреждён файл голоса: ' + file.path);
      }
      await cache.put(url, new Response(data, { headers: { 'Content-Type': file.type } }));
    }
    complete += file.bytes;
    progress(complete, manifest.bytes);
  }
  await cache.put(manifestURL, new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// Keep natural sentence boundaries; split unusually long sentences at a pause
// or word boundary. Worker input is limited to 240 characters per request.
export function speechChunks(text) {
  const input = normalize(text);
  if (!input) return [];
  const sentences = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(input)].map(x => x.segment.trim())
    : (input.match(/[^.!?…]+(?:[.!?…]+[»”"']*|$)|[.!?…]+/gu) || [input]);
  const chunks = [];
  let collected = '';
  for (let sentence of sentences) {
    sentence = normalize(sentence);
    while (sentence) {
      const limit = chunks.length ? 96 : 64;
      if (collected && (collected + ' ' + sentence).length <= limit) {
        collected += ' ' + sentence; sentence = ''; continue;
      }
      if (collected) { chunks.push(collected); collected = ''; continue; }
      if (sentence.length <= limit) { collected = sentence; sentence = ''; continue; }
      let end = -1;
      for (const punctuation of [',', ';', ':']) {
        const index = sentence.lastIndexOf(punctuation, limit - 1);
        if (index >= limit / 2) end = Math.max(end, index + 1);
      }
      if (end < 0) end = sentence.lastIndexOf(' ', limit);
      if (end < 1) {
        // Keep an unusually long word intact when it still fits the engine.
        const nextSpace = sentence.indexOf(' ');
        end = nextSpace > 0 && nextSpace <= 240 ? nextSpace : Math.min(sentence.length, 240);
        if (/^[\uDC00-\uDFFF]$/.test(sentence[end])) end--;
      }
      chunks.push(sentence.slice(0, end).trim());
      sentence = sentence.slice(end).trim();
    }
  }
  if (collected) chunks.push(collected);
  return chunks.filter(Boolean);
}

class Bridge {
  constructor() {
    this.worker = new Worker(new URL('worker.mjs', LAB), { type: 'module' });
    this.jobs = new Map(); this.sequence = 0; this.closed = false;
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id);
      if (!job) return;
      clearTimeout(job.timer); this.jobs.delete(data.id);
      if (data.ok) job.resolve(data);
      else {
        const error = new Error(data.error);
        job.reject(error); this.close(error);
      }
    };
    this.worker.onerror = event => {
      event.preventDefault();
      this.close(new Error('Не удалось выполнить локальный синтез. Повторите подготовку Dmitri.'));
    };
  }
  request(message) {
    if (this.closed) return Promise.reject(new Error('Движок голоса остановлен.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Dmitri не ответил за 20 секунд. Повторите подготовку голоса.')), 20000);
      this.jobs.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, ...message });
    });
  }
  close(error = new Error('Движок голоса закрыт.')) {
    if (this.closed) return;
    this.closed = true; this.worker.terminate();
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(error); }
    this.jobs.clear();
  }
}

export class NeuralSpeaker {
  constructor(options) {
    this.options = options;
    this.ready = false; this.loading = null; this.bridge = null;
    this.current = null; this.pending = null; this.generation = 0;
    this.context = null; this.source = null; this.wake = null;
    this.unlocked = Promise.resolve(); this.serial = Promise.resolve();
    this.metrics = { droppedBeforePlayback: 0, replacedPending: 0, played: 0 };
    this.blankAt = null;
  }
  async prepare() {
    if (this.ready && !this.bridge?.closed) return;
    if (this.loading) return this.loading;
    const token = this.generation;
    this.loading = (async () => {
      await this.options.beforePrepare();
      await prepareVoiceFiles(this.options.onProgress);
      if (token !== this.generation) throw new Error('Подготовка отменена.');
      this.bridge?.close(); this.bridge = new Bridge();
      await this.bridge.request({ type: 'init' });
      // Warm up before OCR is enabled. This PCM is deliberately not played.
      await this.bridge.request({ type: 'synthesize', text: 'Проверка.', rate: 1 });
      if (token !== this.generation) throw new Error('Подготовка отменена.');
      this.ready = true;
      this.options.onReady?.();
    })().catch(error => {
      this.ready = false; this.bridge?.close(); this.bridge = null;
      throw error;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  unlock() {
    if (!this.context || this.context.state === 'closed') {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Audio) throw new Error('Браузер не предоставляет Web Audio.');
      this.context = new Audio({ latencyHint: 'interactive' });
    }
    // This function must be called synchronously from a click handler.
    this.unlocked = this.context.resume();
    this.unlocked.catch(() => {});
    return this.unlocked;
  }
  stop() {
    this.generation++; this.current = null; this.pending = null; this.blankAt = null;
    if (this.source) {
      const source = this.source; this.source = null;
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.wake?.(); this.wake = null;
  }
  destroy() {
    this.stop(); this.bridge?.close(); this.bridge = null; this.ready = false;
    this.context?.close().catch(() => {}); this.context = null;
  }
  observe(text) {
    if (text) { this.blankAt = null; return; }
    if (this.blankAt === null) this.blankAt = now();
    if (now() - this.blankAt > 1000 && this.current && !this.current.manual) {
      this.current.abandon = true;
      this.pending = null;
    }
  }
  enqueue(text, metadata = {}) {
    if (!this.options.isReading()) return;
    text = normalize(text);
    if (!text) return;
    const key = this.options.key(text);
    if (this.options.similar(key, this.current?.key)) return;
    if (this.current) {
      if (this.pending && !this.options.similar(key, this.options.key(this.pending.text))) this.metrics.replacedPending++;
      this.pending = { text, time: now(), metadata };
      return;
    }
    this.begin(text, false, false, metadata);
  }
  say(text, announcement = false) {
    this.stop();
    this.begin(text, announcement, true, {});
  }
  valid(job) {
    return this.current === job && this.generation === job.generation &&
      (job.manual || this.options.isReading());
  }
  begin(text, announcement, manual, metadata) {
    if (!this.ready || this.bridge?.closed) {
      this.ready = false;
      this.options.onError('Сначала нажмите «Подготовить Dmitri».'); return;
    }
    const chunks = speechChunks(text);
    if (!chunks.length) return;
    const job = {
      text, key: announcement ? '' : this.options.key(text), chunks,
      generation: this.generation, rate: this.options.getRate(),
      manual, announcement, metadata, acceptedAt: now(), started: false, abandon: false
    };
    this.current = job;
    this.run(job).catch(error => {
      if (!this.valid(job)) return;
      if (this.bridge?.closed) this.ready = false;
      this.stop();
      this.options.onError(error.message);
    });
  }
  generate(job, text) {
    // No new job is sent while a cancelled synthesis is still running.
    const promise = this.serial.then(async () => {
      if (!this.valid(job) || job.abandon || this.freshPending(job)) return null;
      return this.bridge.request({ type: 'synthesize', text, rate: job.rate });
    });
    this.serial = promise.then(() => undefined, () => undefined);
    return promise;
  }
  freshPending(job) {
    return !job.manual && this.pending && now() - this.pending.time < 3000;
  }
  async play(job, result, first) {
    await this.unlocked;
    if (!this.valid(job) || job.abandon || this.freshPending(job)) return false;
    if (!job.started && !job.manual && now() - job.acceptedAt > 3500) {
      return false;
    }
    if (this.context?.state !== 'running') {
      throw new Error('Звук Safari приостановлен. Нажмите «Проверить голос» и начните озвучку снова.');
    }
    const pcm = new Float32Array(result.pcm);
    const buffer = this.context.createBuffer(1, pcm.length, result.sampleRate);
    buffer.copyToChannel(pcm, 0);
    const node = this.context.createBufferSource(); node.buffer = buffer;
    node.connect(this.context.destination); this.source = node;
    let finish;
    const ended = new Promise(resolve => { finish = resolve; });
    const watchdog = setTimeout(() => {
      if (!this.valid(job)) { finish(); return; }
      this.stop();
      this.options.onError('Воспроизведение было прервано. Проверьте голос и повторите запуск.');
      finish();
    }, Math.max(15000, result.duration * 1000 + 5000));
    this.wake = finish;
    node.onended = () => finish();
    node.start(this.context.currentTime + 0.015);
    if (first) {
      job.started = true; this.metrics.played++;
      this.options.onStart(job.text, job.announcement, {
        ...job.metadata, voice: 'Dmitri', rate: job.rate,
        textLength: job.text.length, firstChunkLength: job.chunks[0].length,
        chunkCount: job.chunks.length, synthesisMs: result.readyMs,
        afterRecognitionMs: now() - job.acceptedAt + 15,
        assetReadsDuringSynthesis: result.assetReadsDuringSynthesis,
        manual: job.manual
      });
    }
    await ended;
    clearTimeout(watchdog);
    node.onended = null; node.disconnect();
    if (this.source === node) this.source = null;
    if (this.wake === finish) this.wake = null;
    return this.valid(job);
  }
  async run(job) {
    this.options.onStatus('Dmitri готовит реплику…');
    let prepared = this.generate(job, job.chunks[0]);
    for (let i = 0; i < job.chunks.length; i++) {
      const result = await prepared;
      if (!result || !this.valid(job) || job.abandon || this.freshPending(job)) break;
      const playback = this.play(job, result, i === 0);
      // At most one future sentence is synthesized while this one plays.
      prepared = i + 1 < job.chunks.length ? this.generate(job, job.chunks[i + 1]) : null;
      if (prepared) prepared.catch(() => {});
      if (!await playback) break;
      if (!this.valid(job) || job.abandon || this.freshPending(job)) break;
    }
    if (!this.valid(job)) return;
    if (!job.started) this.metrics.droppedBeforePlayback++;
    this.current = null;
    const next = this.pending; this.pending = null;
    if (next && this.options.isReading() && now() - next.time < 3000) {
      this.begin(next.text, false, false, next.metadata);
    } else this.options.onStatus('Dmitri готов');
  }
}
