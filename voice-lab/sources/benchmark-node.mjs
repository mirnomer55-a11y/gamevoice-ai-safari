import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const phrases=['Сейчас здесь находится сувенирный магазин.','Мы должны добраться до замка до наступления темноты. Возьми карту и проверь, какой дорогой нам лучше идти.'];
const results=[];
function wav(pcm,sr){const b=Buffer.alloc(44+pcm.byteLength);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(pcm.byteLength,40);Buffer.from(pcm).copy(b,44);return b;}
for(let trial=0;trial<3;trial++)for(const voice of ['Anna','Aleksandr']){
 let id=0;const jobs=new Map();let boot;
 const ready=new Promise(resolve=>boot=resolve);const start=performance.now();
 const worker=new Worker(new URL('./worker-node.mjs',import.meta.url),{workerData:{moduleURL:pathToFileURL(root+'/worker.mjs').href}});
 worker.on('message', m=>{if(m.type==='boot'){boot();return;}const job=jobs.get(m.id);if(job){jobs.delete(m.id);m.ok?job.resolve(m):job.reject(Error(m.error));}});
 worker.on('error',e=>{console.error(e);process.exit(1)});
 function send(msg){return new Promise((resolve,reject)=>{const n=++id;jobs.set(n,{resolve,reject});worker.postMessage({...msg,id:n});});}
 await ready;const init=await send({type:'init'});const initMs=performance.now()-start;
 const first=await send({type:'synthesize',text:phrases[0],voice,rate:1});
 if(first.networkAttempts || first.fileReads!==init.fileReads)throw Error('Synthesis performed file/network reads');
 const pcm=new Int16Array(first.pcm);let peak=0;for(const n of pcm)peak=Math.max(peak,Math.abs(n));if(peak===0)throw Error('silent output');
 if(trial===0)fs.writeFileSync(root+'/../sample-'+voice.toLowerCase()+'.wav',wav(first.pcm,first.sampleRate));
 const runs=[];
 for(let p=0;p<phrases.length;p++)for(let repeat=0;repeat<5;repeat++){
  const response=await send({type:'synthesize',text:phrases[p],voice,rate:1});
  if(response.fileReads!==init.fileReads || response.networkAttempts)throw Error('Runtime IO');
  runs.push({phrase:p,repeat,synthesisMs:response.synthesisMs,readyMs:response.readyMs,duration:response.duration});
 }
 results.push({trial,voice,initMs,coreInitMs:init.initMs,firstMs:first.readyMs,firstAudioSeconds:first.duration,sampleRate:first.sampleRate,peak,memoryBytes:init.wasmMemory,runtimeFileReads:0,networkAttempts:first.networkAttempts,runs});
 console.log({trial,voice,initMs:Math.round(initMs),firstMs:Math.round(first.readyMs),duration:first.duration,network:0,firstPeak:peak});
 await worker.terminate();
}
const report={created:new Date().toISOString(),environment:{runtime:'Node.js WebAssembly, same worker.mjs and binary as the browser package',node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,notIPhoneMeasurement:true},phrases,results};
fs.writeFileSync(root+'/../benchmark-linux.json',JSON.stringify(report,null,2));
