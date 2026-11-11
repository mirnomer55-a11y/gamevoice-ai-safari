const clean = text => String(text || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
const comparison = text => clean(text).toLowerCase().replace(/ё/gu, 'е').replace(/[^а-яa-z0-9]/gu, '');
const forbidden = /[=<>^{}\[\]|\\`~≠≈≤≥]/u;
const ordinary = new Set(('слушай слушайте подожди подождите смотри смотрите внимание осторожно запомни запомните помни помните учти учтите значит итак план правило например постой стой нет да хорошо главное пожалуйста привет пока спасибо прости извините извини ладно').split(' '));
const particles = /^(?:де|дель|да|ван|фон|ла|ле|аль|эль|и|the|of|von|van)$/iu;
const nameToken = /^[\p{Lu}][\p{L}\p{N}_'’.-]*$/u;

function probableName(value) {
  const text = clean(value).replace(/^[—–-]\s*/u, '').replace(/[:：;.]+$/u, '').trim();
  const words = text.split(' ');
  return text.length >= 2 && text.length <= 60 && words.length <= 4 &&
    !ordinary.has(words[0].toLowerCase()) && words.every((word, i) => nameToken.test(word) || (i > 0 && particles.test(word)));
}
const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);

// Bounding boxes are in the OCR input. Offsets map them back through the
// existing crop and its 12px padding to the ORIGINAL colour frame.
export function wordColour(bbox, frame) {
  if (!bbox || !frame?.data || !frame.width || !frame.height) return null;
  const x0 = Math.max(0, Math.floor(bbox.x0 + frame.offsetX));
  const y0 = Math.max(0, Math.floor(bbox.y0 + frame.offsetY));
  const x1 = Math.min(frame.width, Math.ceil(bbox.x1 + frame.offsetX));
  const y1 = Math.min(frame.height, Math.ceil(bbox.y1 + frame.offsetY));
  if (![x0,y0,x1,y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  const step = Math.max(1, Math.ceil(Math.sqrt((x1-x0)*(y1-y0)/600)));
  let count=0; const sums=[0,0,0], squares=[0,0,0];
  for(let y=y0;y<y1;y+=step) for(let x=x0;x<x1;x+=step) {
    const i=4*(y*frame.width+x), r=frame.data[i],g=frame.data[i+1],b=frame.data[i+2];
    const maximum=Math.max(r,g,b),minimum=Math.min(r,g,b);
    if(frame.mode==='light' ? Math.min(r,g)<frame.threshold : maximum<155 || (maximum-minimum<55 && minimum<160)) continue;
    const colour=[r/maximum,g/maximum,b/maximum];
    for(let c=0;c<3;c++){sums[c]+=colour[c];squares[c]+=colour[c]*colour[c];}count++;
  }
  if(count<5) return null;
  const mean=sums.map(value=>value/count);
  if(mean.some((value,i)=>squares[i]/count-value*value>0.045)) return null;
  return mean;
}

function colourPrefix(line, following, frame) {
  const words=(line.words||[]).filter(w=>clean(w.text));
  if(!words.length || comparison(words.map(w=>w.text).join(' '))!==comparison(line.text)) return null;
  const start=/^[—–-]$/u.test(words[0].text) ? 1 : 0;
  const first=wordColour(words[start]?.bbox,frame);
  if(!first) return null;
  let end=start;
  while(end<words.length && end-start<4){
    const colour=wordColour(words[end].bbox,frame);
    if(!colour || distance(first,colour)>0.16) break;
    end++;
  }
  if(end===start) return null;
  const label=words.slice(start,end).map(w=>w.text).join(' ');
  if(!probableName(label)) return null;
  const rest=[...words.slice(end),...(following?.words||[])].filter(w=>/[\p{L}\p{N}]/u.test(w.text));
  if(!rest.length) return null;
  const body=wordColour(rest[0].bbox,frame);
  if(!body || distance(first,body)<0.30) return null;
  const colours=rest.slice(0,3).map(w=>wordColour(w.bbox,frame)).filter(Boolean);
  if(!colours.length || colours.some(colour=>distance(body,colour)>0.18)) return null;
  return {text:clean(words.slice(end).map(w=>w.text).join(' ')),name:label.replace(/[:：;.]+$/u,'')};
}

// Banded edit distance avoids a full matrix for every recent subtitle.
function near(a,b) {
  if(a===b)return true;
  const limit=Math.floor(Math.max(a.length,b.length)*0.10);
  if(Math.min(a.length,b.length)<18 || Math.abs(a.length-b.length)>limit)return false;
  let previous=Array.from({length:b.length+1},(_,j)=>j),next;
  for(let i=1;i<=a.length;i++){
    next=new Array(b.length+1).fill(limit+1);next[0]=i;let minimum=limit+1;
    for(let j=Math.max(1,i-limit);j<=Math.min(b.length,i+limit);j++){
      next[j]=Math.min(next[j-1]+1,previous[j]+1,previous[j-1]+Number(a[i-1]!==b[j-1]));minimum=Math.min(minimum,next[j]);
    }
    if(minimum>limit)return false;previous=next;
  }
  return previous[b.length]<=limit;
}
function entry(text,at) {
  const normalized=clean(text).toLowerCase().replace(/ё/gu,'е');
  return {text:normalized,key:comparison(normalized),at,
    numbers:(normalized.match(/\d+(?:[.,]\d+)*/gu)||[]).join('|'),
    negative:/(?:^|[^а-яa-z])(?:не|нет|ни|нельзя)(?:$|[^а-яa-z])/u.test(normalized)};
}
export class SubtitleFilter {
  constructor({clock=()=>performance.now(),rememberMs=120000,maxEntries=96}={}) {
    this.clock=clock;this.rememberMs=rememberMs;this.maxEntries=maxEntries;this.history=[];this.names=new Set();
    this.metrics={blockedSymbolFrames:0,strippedNameFrames:0,duplicateFrames:0};
  }
  sanitize(lines,frame) {
    const selected=lines.map(line=>({...line,text:clean(line.text)})).filter(line=>line.text);
    // A bad caption is rejected as a whole; deleting '=' would make nonsense
    // look like an ordinary, confidently recognised sentence.
    if(selected.some(line=>forbidden.test(line.text))){this.metrics.blockedSymbolFrames++;return{text:'',blocked:'symbols',namesRemoved:0};}
    let namesRemoved=0;
    const result=selected.map((line,i)=>{
      const coloured=colourPrefix(line,selected[i+1],frame);
      if(coloured){this.names.add(coloured.name.toLowerCase());namesRemoved++;return coloured.text;}
      const prefix=line.text.match(/^(?:[—–-]\s*)?([^:：]{2,60})[:：]\s*(.*)$/u);
      if(prefix && (probableName(prefix[1]) || this.names.has(prefix[1].toLowerCase()))){
        namesRemoved++;return clean(prefix[2]);
      }
      return line.text;
    });
    while(this.names.size>96)this.names.delete(this.names.values().next().value);
    if(namesRemoved)this.metrics.strippedNameFrames++;
    return{text:clean(result.filter(Boolean).join(' ')),blocked:'',namesRemoved};
  }
  prune() { const cutoff=this.clock()-this.rememberMs;this.history=this.history.filter(value=>value.at>=cutoff); }
  wasSpoken(text) {
    this.prune();const value=entry(text,this.clock());if(!value.key)return false;
    const match=this.history.find(old=>{
      if(old.key===value.key)return true;
      if(old.numbers!==value.numbers || old.negative!==value.negative)return false;
      if(near(value.key,old.key))return true;
      // Losing a previously read line must not replay its remaining fragment.
      return value.key.length>=16 && value.text.split(' ').length>=3 && old.key.includes(value.key);
    });
    // A paused game showing the same caption must not trigger a repeat when
    // the history interval passes; expire it only after it is no longer seen.
    if(match)match.at=this.clock();
    return !!match;
  }
  remember(text) {
    this.prune();const value=entry(text,this.clock());if(!value.key)return;
    this.history=this.history.filter(old=>old.key!==value.key);
    this.history.push(value);if(this.history.length>this.maxEntries)this.history.shift();
  }
}

