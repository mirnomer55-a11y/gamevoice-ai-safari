const clean=text=>String(text||'').normalize('NFC').replace(/\s+/gu,' ').trim();
const wordKey=text=>text.toLowerCase().replace(/ё/gu,'е');
const tokens=text=>[...clean(text).matchAll(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu)];

export function preserveLightDetails(pixels) {
  // Retain grey/antialiased strokes instead of erasing them with a hard cutoff.
  // Red/green brightness also retains the existing white/yellow subtitle mode.
  for(let i=0;i<pixels.length;i+=4){
    const value=255-Math.min(pixels[i],pixels[i+1]);
    pixels[i]=pixels[i+1]=pixels[i+2]=value;
  }
  return pixels;
}

export function ocrProfile(mode) {
  return mode==='accurate' ? {
    id:'accurate',label:'Точнее',gzip:false,
    langPath:'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec',
    cachePath:'gamevoice-best-ru-e12c65a9-v1'
  } : {
    id:'fast',label:'Быстрее',gzip:true,
    langPath:'https://tessdata.projectnaptha.com/4.0.0_fast',cachePath:'gamevoice-fast-ru-v1'
  };
}

// Only a complete sequence of identical initial WORDS can be continued.
// A changed digit, negation or partially recognised word is not an extension.
export function captionTail(previous, full) {
  const a=tokens(previous),b=tokens(full);
  if(a.length<3 || b.length<=a.length || a.map(x=>x[0]).join('').length<12)return '';
  if(a.some((value,i)=>wordKey(value[0])!==wordKey(b[i][0])))return '';
  return clean(full).slice(b[a.length].index).trim();
}

function ending(text) {return tokens(text).slice(-2).map(x=>wordKey(x[0])).join('|');}
export class CaptionGate {
  constructor(options) {
    this.options=options;
    this.metrics={waitedFrames:0,stableAccepted:0,clearAccepted:0,continuedAccepted:0};
    this.reset();
  }
  reset(){this.candidate='';this.count=0;this.spoken='';this.blankAt=null;this.candidateSince=null;this.waitMs=0;}
  consider(result) {
    const now=this.options.clock?.()??performance.now();
    if(!result.text){
      this.candidate='';this.count=0;this.candidateSince=null;this.waitMs=0;
      if(this.blankAt===null)this.blankAt=now;
      if(now-this.blankAt>1000)this.options.onBlank?.();
      return '';
    }
    this.blankAt=null;
    const text=clean(result.text);
    const same=this.candidate && ending(text)===ending(this.candidate) &&
      this.options.similar(this.options.key(text),this.options.key(this.candidate));
    if(!same)this.candidateSince=now;
    this.waitMs=now-this.candidateSince;
    this.count=same?this.count+1:1;this.candidate=text;
    const continuation=this.options.canContinue?.(text);
    if(!continuation && this.options.wasSpoken(text)){
      this.options.onDuplicate?.();return '';
    }
    const clear=result.confidence>=92 && result.tailConfidence>=85 && result.hasWords &&
      !result.touchesEdge && /[.!?…][»”"')\]]*$/u.test(text);
    if(!clear && (this.count<2 || result.confidence<58)){
      this.metrics.waitedFrames++;return '';
    }
    if(continuation)this.metrics.continuedAccepted++;
    if(clear)this.metrics.clearAccepted++;else this.metrics.stableAccepted++;
    return text;
  }
}

// Preserve every accepted line in reading order. Never select only the three
// longest lines, which silently discarded short final lines of a long caption.
export function captionLines(data) {
  let lines=(data.blocks||[]).flatMap(block=>(block.paragraphs||[]).flatMap(p=>p.lines||[]));
  if(!lines.length && clean(data.text)){
    lines=String(data.text).split(/\r?\n/u).filter(x=>clean(x)).map((text,i)=>({text,confidence:data.confidence,bbox:{y0:i}}));
  }
  return lines.filter(line=>{
    const text=clean(line.text),russian=(text.match(/[а-яё]/giu)||[]).length;
    const letters=(text.match(/[а-яёa-z]/giu)||[]).length;
    return russian>=2 && letters/Math.max(1,text.replace(/\s/gu,'').length)>0.55 &&
      Number(line.confidence)>=35 && (letters>=4 || Number(line.confidence)>=80);
  }).sort((a,b)=>(a.bbox?.y0||0)-(b.bbox?.y0||0) || (a.bbox?.x0||0)-(b.bbox?.x0||0));
}

export function lineQuality(lines,frame) {
  const last=lines.at(-1),words=(last?.words||[]).filter(word=>/[\p{L}\p{N}]/u.test(word.text));
  const tail=words.slice(-2).map(word=>Number(word.confidence)).filter(Number.isFinite);
  const sourceBottom=last?.bbox?.y1+(frame?.offsetY||0);
  return {lineCount:lines.length,hasWords:words.length>0,
    tailConfidence:tail.length?Math.min(...tail):0,
    touchesEdge:!!frame && Number.isFinite(sourceBottom) && sourceBottom>=frame.height-2};
}
