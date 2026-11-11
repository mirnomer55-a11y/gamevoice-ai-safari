import { captionTail } from './ocr-text.mjs?v=0.6.4';
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

// Start with a small complete group of words; prepare the rest during playback.
// Never combine separate sentences into a single model input.
export function speechChunks(text) {
  const input = normalize(text);
  if (!input) return [];
  const sentences = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(input)].map(x => x.segment.trim())
    : (input.match(/[^.!?…]+(?:[.!?…]+[»”"']*|$)|[.!?…]+/gu) || [input]);
  const chunks = [];
  for (let sentence of sentences) {
    sentence = normalize(sentence);
    while (sentence) {
      // Preserve the intonation of short standalone sentences. A long caption
      // gets a shorter opening, then a modest second chunk that can be ready
      // before the short opening finishes playing.
      const limit = chunks.length === 0 ? (sentence.length <= 48 ? 48 : 36)
        : chunks.length === 1 ? 64 : 100;
      if (sentence.length <= limit) { chunks.push(sentence); break; }
      let end = -1;
      for (const punctuation of [',', ';', ':']) {
        const index = sentence.lastIndexOf(punctuation, limit - 1);
        if (index >= limit / 2 && /\s/.test(sentence[index + 1] || '')) end = Math.max(end, index + 1);
      }
      if (end < 0) end = sentence.lastIndexOf(' ', limit);
      if (end < 1) {
        // An oversized OCR token is rejected, never sliced into fake words.
        const nextSpace = sentence.indexOf(' ');
        end = nextSpace > 0 ? nextSpace : sentence.length;
        if (end > 238) throw new Error('В тексте найдено слишком длинное слово. Проверьте распознавание.');
      } else {
        // Keep a preposition/conjunction with the following word when possible.
        const lastWord = sentence.slice(0, end).match(/(?:^|\s)([^\s]+)$/u)?.[1];
        if (/^(?:и|а|но|в|во|на|к|ко|с|со|из|от|у|о|об|по|за|для|до|не|ни|без)$/iu.test(lastWord || '')) {
          const previous = sentence.lastIndexOf(' ', end - lastWord.length - 1);
          if (previous >= limit / 2) end = previous;
        }
      }
      chunks.push(sentence.slice(0, end).trim());
      sentence = sentence.slice(end).trim();
    }
  }
  return chunks.filter(Boolean);
}

export function synthesisText(chunk, last) {
  // Give the last word a proper phonetic ending even at an artificial boundary.
  return /[.!?…,;:][»”"')\]]*$/u.test(chunk) ? chunk : chunk + (last ? '.' : ',');
}

export class Bridge {
  constructor() {
    this.worker = new Worker(new URL('./synthesis-worker.mjs?v=0.6.5', import.meta.url), { type: 'module' });
    this.jobs = new Map(); this.sequence = 0; this.closed = false;
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id);
      if (!job) return;
      clearTimeout(job.timer); this.jobs.delete(data.id);
      if (data.ok) job.resolve(data);
      else {
        const error = Object.assign(new Error(data.error), { scope: data.scope || 'engine', code: data.code || 'worker-error' });
        job.reject(error);
        if (error.scope !== 'utterance') this.close(error);
      }
    };
    this.worker.onerror = event => {
      event.preventDefault();
      this.close(Object.assign(new Error('Не удалось выполнить локальный синтез.'), { scope:'engine',code:'worker-crash' }));
    };
  }
  request(message) {
    if (this.closed) return Promise.reject(new Error('Движок голоса остановлен.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(Object.assign(new Error('Dmitri не ответил за 20 секунд.'), { scope:'engine',code:'worker-timeout' })), 20000);
      this.jobs.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, ...message }); } catch (error) { this.close(error); }
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
    this.context = null; this.sources = new Map();
    this.unlocked = Promise.resolve(); this.serial = Promise.resolve(); this.resuming = null;
    this.sequence = 0; this.restarts = []; this.rejectedCaptionKey = ''; this.restarting = false;
    this.metrics = { droppedBeforePlayback: 0, replacedPending: 0, played: 0,
      completed: 0, scheduledChunks: 0, preloadedPending: 0, extendedCaptions: 0, appendedChunks: 0,
      audioResumes: 0, chunkRetries: 0, engineRestarts: 0, failedCaptions: 0, recoveredEndEvents: 0, playbackGapsMs: [] };
    this.blankAt = null;
  }
  time() { return this.options.clock?.() ?? now(); }
  makeBridge() { return this.options.createBridge?.() ?? new Bridge(); }
  emit(type, details = {}) {
    this.options.onEvent?.({ type, ...details, audioState: this.context?.state || 'none', atMs: this.time() });
  }
  snapshot() {
    const job=this.current;
    return { ready:this.ready,engineClosed:this.bridge?.closed??true,audioState:this.context?.state||'none',sources:this.sources.size,
      current:job?{id:job.id,started:job.started,chunkCount:job.chunks.length,scheduledChunks:job.playedChunks,
        generatingChunk:job.generatingChunk??null,ageMs:this.time()-job.acceptedAt,manual:job.manual}:null,
      pending:this.pending?{textLength:this.pending.text.length,ageMs:this.time()-this.pending.time}:null };
  }
  async prepare() {
    if (this.ready && !this.bridge?.closed) return;
    if (this.loading) return this.loading;
    const token = this.generation;
    this.loading = (async () => {
      await this.options.beforePrepare();
      await prepareVoiceFiles(this.options.onProgress);
      if (token !== this.generation) throw new Error('Подготовка отменена.');
      this.bridge?.close(); this.bridge = this.makeBridge();
      await this.bridge.request({ type: 'init' });
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
      const context=this.context;
      context.addEventListener?.('statechange', () => {
        this.emit('audio.state', { state:context.state });
        const job=this.current;
        if(context!==this.context || !job || !this.valid(job) || !this.options.isReading() ||
          !['suspended','interrupted'].includes(context.state))return;
        this.resumeAudio().catch(error=>{
          if(this.valid(job))this.emit('audio.resume.failed',{jobId:job.id,message:error.message});
        });
      });
    }
    // Call synchronously from the original click to preserve Safari activation.
    this.unlocked = this.resumeAudio();
    this.unlocked.catch(() => {});
    return this.unlocked;
  }
  resumeAudio() {
    if (this.context?.state === 'running') return Promise.resolve();
    if (this.resuming) return this.resuming;
    const message = 'Safari приостановил звук. Нажмите «Проверить голос» и начните озвучку снова.';
    if (!this.context || this.context.state === 'closed') return Promise.reject(new Error(message));
    let timer, request;
    try { request = this.context.resume(); } catch { return Promise.reject(new Error(message)); }
    const context = this.context;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 1500); });
    const attempt = Promise.race([request, deadline]).then(() => {
      if (this.context !== context || context.state !== 'running') throw new Error(message);
      this.metrics.audioResumes++;
      this.emit('audio.resumed');
    }).finally(() => { clearTimeout(timer); if (this.resuming === attempt) this.resuming = null; });
    this.resuming = attempt;
    return attempt;
  }
  stop(reason = 'requested') {
    if(this.current)this.options.onIncomplete?.({jobId:this.current.id,reason,chunkCount:this.current.chunks.length,
      scheduledChunks:this.current.playedChunks,started:this.current.started,manual:this.current.manual});
    this.emit('voice.stop',{reason,snapshot:this.snapshot()});
    this.generation++; this.current = null; this.pending = null; this.blankAt = null;
    this.rejectedCaptionKey='';
    for (const [source, finish] of [...this.sources]) {
      source.onended = null;
      try { source.stop(); } catch {}
      finish();
    }
  }
  destroy() {
    this.stop(); this.bridge?.close(); this.bridge = null; this.ready = false;
    this.context?.close().catch(() => {}); this.context = null;
  }
  observe(text) {
    if (text) { this.blankAt = null; return; }
    if (this.blankAt === null) this.blankAt = this.time();
    if (this.time() - this.blankAt <= 1000) return;
    this.pending = null;
    this.rejectedCaptionKey='';
    // A vanished caption may be discarded only before its first sound.
    if (this.current && !this.current.started && !this.current.manual) this.current.abandon = true;
  }
  enqueue(text, metadata = {}) {
    if (!this.options.isReading()) return;
    text = normalize(text);
    if (!text) return;
    if (this.extendCaption(text)) return;
    if (this.options.canStart && !this.options.canStart(text)) return;
    const key = this.options.key(text);
    if(this.options.similar(key,this.rejectedCaptionKey))return;
    if (this.options.similar(key, this.current?.key)) return;
    if (this.current) {
      if (this.pending && this.options.similar(key, this.options.key(this.pending.text))) {
        this.pending.time = this.time();
        return;
      }
      if (this.pending) this.metrics.replacedPending++;
      this.pending = { text, time: this.time(), acceptedAt: this.time(), metadata,
        generation: this.generation, rate: this.options.getRate(), prepared: null };
      this.prefetchPending();
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
  outdated(job) {
    // Once audible, finish ALL of this caption, not just its current fragment.
    return !job.started && !job.manual && (job.abandon || this.freshPending());
  }
  freshPending() { return this.pending && this.time() - this.pending.time < 3000; }
  canExtend(text) {
    const job = this.current;
    return !!job && !job.manual && this.valid(job) && !!captionTail(job.text, text);
  }
  extendCaption(text) {
    if (!this.canExtend(text)) return false;
    const job = this.current, tail = captionTail(job.text, text);
    let chunks;
    try { chunks = speechChunks(tail); } catch { return false; }
    if (!chunks.length) return false;
    job.text = text; job.key = this.options.key(text);
    job.chunks.push(...chunks); job.finishing = false;
    if (!job.extensions) this.metrics.extendedCaptions++;
    job.extensions = (job.extensions || 0) + 1;
    this.metrics.appendedChunks += chunks.length;
    if (job.started) this.options.onUpdateText?.(text);
    return true;
  }
  begin(text, announcement, manual, metadata, queued = null) {
    if (!manual && this.options.canStart && !this.options.canStart(text)) {
      this.options.onStatus('Dmitri готов'); return;
    }
    if ((!this.ready && !this.restarting) || !this.bridge) {
      this.ready = false;
      this.options.onError('Сначала нажмите «Подготовить Dmitri».'); return;
    }
    let chunks;
    try { chunks = speechChunks(text); }
    catch (error) { this.options.onError(error.message); return; }
    if (!chunks.length) return;
    const job = {
      id:++this.sequence,
      text, key: announcement ? '' : this.options.key(text), chunks,
      generation: this.generation, rate: queued?.rate ?? this.options.getRate(),
      manual, announcement, metadata, acceptedAt: queued?.acceptedAt ?? this.time(),
      started: false, abandon: false, finishing: false, nextAudioTime: 0, launchedAt: this.time(),
      queued, playedChunks: 0, queueWaitMs: queued ? this.time() - queued.acceptedAt : 0
    };
    this.current = job;
    // After minutes of silence Safari may suspend an otherwise prepared audio
    // context. Resume alongside synthesis, without reloading or warming a model.
    job.audioReady = this.resumeAudio(); job.audioReady.catch(() => {});
    this.run(job).catch(async error => {
      if (!this.valid(job)) return;
      this.emit('caption.error',{jobId:job.id,scope:error.scope||'engine',code:error.code||'unknown',message:error.message,
        chunkCount:job.chunks.length,scheduledChunks:job.playedChunks,generatingChunk:job.generatingChunk});
      if(error.scope==='utterance' && !this.bridge?.closed){
        this.metrics.failedCaptions++;this.rejectedCaptionKey=job.key;
        if(job.lastEnded)await job.lastEnded;
        if(!this.valid(job))return;
        this.options.onIncomplete?.({jobId:job.id,reason:'utterance-error',chunkCount:job.chunks.length,scheduledChunks:job.playedChunks,started:job.started,manual:job.manual});
        this.current=null;
        this.options.onWarning?.('Не удалось озвучить фрагмент. Продолжаю следующие реплики.');
        this.advance();return;
      }
      if (this.bridge?.closed) this.ready = false;
      this.stop(error.code||'voice-error');
      this.options.onError(error.message);
    });
  }
  async restartEngine(guard,error) {
    if(!guard())return false;
    const now=this.time();this.restarts=this.restarts.filter(t=>now-t<60000);
    if(this.restarts.length>=2)throw Object.assign(new Error('Повторный сбой движка голоса. Нажмите «Подготовить Dmitri».'),{code:'restart-limit',scope:'engine'});
    this.restarts.push(now);this.metrics.engineRestarts++;
    this.emit('engine.restart',{code:error.code||'unknown',message:error.message});
    this.options.onStatus('Восстанавливаю голос…');
    this.bridge?.close();this.ready=false;this.restarting=true;
    const generation=this.generation;
    const bridge=this.makeBridge();this.bridge=bridge;
    try{
      await bridge.request({type:'init'});
      if(this.generation!==generation || this.bridge!==bridge){bridge.close();return false;}
      this.ready=true;this.emit('engine.ready');this.options.onReady?.();return guard();
    }catch(error){bridge.close();throw error;}
    finally{if(this.bridge===bridge)this.restarting=false;}
  }
  async requestSpeech(text,rate,guard,details) {
    for(let attempt=0;attempt<2;attempt++){
      if(!guard())return null;
      try{return await this.bridge.request({type:'synthesize',text,rate});}
      catch(error){
        if(!guard())return null;
        this.emit('chunk.error',{...details,attempt,code:error.code||'unknown',scope:error.scope||'engine',message:error.message});
        if(attempt===1)throw error;
        this.metrics.chunkRetries++;
        if(error.scope==='utterance' && !this.bridge.closed)continue;
        if(!await this.restartEngine(guard,error))return null;
      }
    }
    return null;
  }
  serialize(work) {
    const promise = this.serial.then(work);
    this.serial = promise.then(() => undefined, () => undefined);
    return promise;
  }
  generate(job, index) {
    return this.serialize(() => {
      if (!this.valid(job) || this.outdated(job)) return null;
      job.generatingChunk=index;
      return this.requestSpeech(synthesisText(job.chunks[index], index===job.chunks.length-1),job.rate,
        ()=>this.valid(job)&&!this.outdated(job),{jobId:job.id,chunk:index});
    });
  }
  prefetchPending() {
    const queued = this.pending;
    if (!queued || queued.prepared || !this.current?.started || !this.current.finishing) return;
    let chunks;
    try { chunks = speechChunks(queued.text); } catch { return; }
    if (!chunks.length) return;
    queued.prepared = this.serialize(async () => {
      if (this.generation !== queued.generation ||
          (this.pending !== queued && this.current?.queued !== queued)) return null;
      const result=await this.requestSpeech(synthesisText(chunks[0],chunks.length===1),queued.rate,
        ()=>this.generation===queued.generation&&(this.pending===queued||this.current?.queued===queued),{prefetch:true,chunk:0});
      this.metrics.preloadedPending++;
      return result;
    });
    // This promise may be deliberately discarded if a newer caption arrives.
    queued.prepared.catch(() => {});
  }
  async schedule(job, result, index) {
    await job.audioReady;
    if (!this.valid(job) || this.outdated(job)) return null;
    if (this.context?.state !== 'running') await this.resumeAudio();
    if (!this.valid(job) || this.outdated(job)) return null;
    if (!job.started && !job.manual && this.time() - job.launchedAt > 3500) return null;
    if (this.context?.state !== 'running') {
      throw new Error('Звук Safari приостановлен. Нажмите «Проверить голос» и начните озвучку снова.');
    }
    const pcm = new Float32Array(result.pcm);
    const buffer = this.context.createBuffer(1, pcm.length, result.sampleRate);
    buffer.copyToChannel(pcm, 0); // Keep the complete waveform, including word endings.
    const node = this.context.createBufferSource(); node.buffer = buffer;
    node.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.015, job.nextAudioTime);
    if (index > 0) {
      this.metrics.playbackGapsMs.push(Math.round(Math.max(0, start - job.nextAudioTime) * 1000));
      if (this.metrics.playbackGapsMs.length > 40) this.metrics.playbackGapsMs.shift();
    }
    job.nextAudioTime = start + buffer.duration;
    let done, watchdog;
    const ended = new Promise(resolve => { done = resolve; });
    const finish = () => {
      if (!this.sources.has(node)) return;
      clearTimeout(watchdog); node.onended = null; node.disconnect();
      this.sources.delete(node); done(this.valid(job));
      this.emit('chunk.finished',{jobId:job.id,chunk:index,cancelled:!this.valid(job)});
    };
    this.sources.set(node, finish);
    watchdog = setTimeout(() => {
      if (!this.valid(job)) { finish(); return; }
      // A delayed onended callback must not stop a healthy, already rendered
      // buffer. Use the audio clock before declaring a stalled playback.
      if(this.context?.state==='running' && this.context.currentTime>=start+buffer.duration){
        this.metrics.recoveredEndEvents++;this.emit('audio.ended.recovered',{jobId:job.id,chunk:index});finish();return;
      }
      this.emit('audio.watchdog',{jobId:job.id,chunk:index,scheduledEnd:start+buffer.duration,audioTime:this.context?.currentTime});
      this.stop('audio-watchdog');
      this.options.onError('Воспроизведение было прервано. Проверьте голос и повторите запуск.');
    }, Math.max(15000, (job.nextAudioTime - this.context.currentTime) * 1000 + 5000));
    node.onended = finish;
    try { node.start(start); }
    catch (error) { finish(); throw error; }
    this.metrics.scheduledChunks++; job.playedChunks++;job.lastEnded=ended;
    this.emit('chunk.scheduled',{jobId:job.id,chunk:index,durationMs:Math.round(buffer.duration*1000)});
    if (index === 0) {
      job.started = true; this.metrics.played++;
      this.options.onStart(job.text, job.announcement, {
        ...job.metadata, voice: 'Dmitri', rate: job.rate,
        jobId:job.id,
        textLength: job.text.length, firstChunkLength: job.chunks[0].length,
        chunkCount: job.chunks.length, synthesisMs: result.readyMs,
        afterRecognitionMs: this.time() - job.acceptedAt + (start - this.context.currentTime) * 1000,
        queueWaitMs: job.queueWaitMs,
        assetReadsDuringSynthesis: result.assetReadsDuringSynthesis,
        phonemeGroups: result.phonemeGroups ?? 1, manual: job.manual
      });
    }
    return { ended };
  }
  async run(job) {
    this.options.onStatus('Dmitri готовит реплику…');
    let playing = null;
    for (let i = 0; ; i++) {
      if (i >= job.chunks.length) {
        if (playing && !await playing.ended) return;
        playing = null;
        // OCR may have recovered the ending while the last buffer was playing.
        if (i >= job.chunks.length) break;
      }
      let result = i === 0 && job.queued?.prepared ? await job.queued.prepared : null;
      if (!result) result = await this.generate(job, i);
      if (!result || !this.valid(job) || this.outdated(job)) break;
      const next = await this.schedule(job, result, i);
      if (!next) break;
      if (i === job.chunks.length - 1) {
        job.finishing = true;
        this.prefetchPending();
      }
      // Schedule the next buffer before the previous buffer ends, without overlap.
      // At most two buffers are retained, and only one model request runs at once.
      if (playing && !await playing.ended) return;
      playing = next;
    }
    if (playing && !await playing.ended) return;
    if (!this.valid(job)) return;
    if (!job.started) this.metrics.droppedBeforePlayback++;
    else {
      this.metrics.completed++;
      this.options.onComplete?.({ chunkCount: job.chunks.length,
        jobId:job.id,
        playedChunks: job.playedChunks, extensions: job.extensions || 0,
        elapsedMs: this.time() - job.acceptedAt, manual: job.manual });
    }
    this.current = null;
    this.advance();
  }
  advance() {
    const next = this.pending; this.pending = null;
    if (next && this.options.isReading() && this.time() - next.time < 3000) {
      this.begin(next.text, false, false, next.metadata, next);
    } else this.options.onStatus('Dmitri готов');
  }
}



