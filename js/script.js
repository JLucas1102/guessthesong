const $ = id => document.getElementById(id);
const LV = {audio:[0.5,1,2,4,6], lyrics:[3,5,8,12,16]};
const IMG="https://i.scdn.co/image/ab67616d0000b273", PRE="https://p.scdn.co/mp3-preview/", CID="?cid=9950ac751e34487dbbe027c4fd7f8e99";

let mode="audio", tracks=[], pool=[], cur=null, attempt=0, guesses=[], over=false;
let timer=null, raf=null, playing=false, wins=0, played=0, prevN=0, netErr=false;
const audio = $("audio");
let guessedTracks = new Set(), guessedKeys = new Set();  // palpites já feitos na rodada

/* ---------- utilidades ---------- */
const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/\(.*?\)|\[.*?\]/g," ").replace(/\s[-–]\s(remaster|remastered|live|ao vivo|single|version|mono|stereo).*$/,"")
  .replace(/\b(feat|ft|with)\b.*$/,"").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();
const fmt = n => String(n).replace(".", ",");
const enc = encodeURIComponent;
const say = (el, t, err) => { el.textContent = t; el.classList.toggle("err", !!err); };
const lbl = i => mode==="audio" ? fmt(LV.audio[i])+"s" : LV.lyrics[i]+" pal.";

/* ---------- CSV ---------- */
function csvRows(txt){
  const rows=[]; let row=[], f="", q=false;
  txt = txt.replace(/^\uFEFF/,"");
  for(let i=0;i<txt.length;i++){
    const c=txt[i];
    if(q){ if(c==='"'){ if(txt[i+1]==='"'){ f+='"'; i++; } else q=false; } else f+=c; }
    else if(c==='"') q=true;
    else if(c===","){ row.push(f); f=""; }
    else if(c==="\n"||c==="\r"){ if(c==="\r"&&txt[i+1]==="\n") i++; row.push(f); f=""; if(row.length>1||row[0]) rows.push(row); row=[]; }
    else f+=c;
  }
  if(f||row.length){ row.push(f); rows.push(row); }
  return rows;
}
function parseCsv(txt){
  const rows=csvRows(txt); if(rows.length<2) return [];
  const h=rows[0].map(norm), data=rows.slice(1);
  let ti,ai,ci=-1,pi=-1;
  if(/^spotify:track:/.test(data[0][0])){ ti=1; ai=3; ci=9; pi=13; }  // layout do Exportify, em qualquer idioma
  else{
    ti=h.findIndex(x=>/^(track name|title|song|name|nome da faixa|musica|titulo|faixa)$/.test(x));
    ai=h.findIndex(x=>/^(artist|artists|artist name|artista|nome do artista)/.test(x) && !/uri/.test(x));
  }
  if(ti<0||ai<0) return [];
  return data.filter(r=>r[ti]&&r[ai]).map(r=>{
    const a=r[ai].split(";").map(s=>s.trim()).filter(Boolean);
    return {title:r[ti].trim(), artist:a.join(", "), artists:a, cover:ci>=0?r[ci]:null, preview:pi>=0&&r[pi]?r[pi]:null};
  });
}
const demoTracks = () => DEMO.map(d=>{ const a=d[1].split(";"); return {title:d[0],artist:a.join(", "),artists:a,cover:IMG+d[2],preview:PRE+d[3]+CID}; });

/* ---------- áudio: preview do Spotify (CSV) com fallback no iTunes ---------- */
function jsonp(url){
  return new Promise((res,rej)=>{
    const cb="itcb"+Math.random().toString(36).slice(2), s=document.createElement("script");
    const done=()=>{ clearTimeout(to); delete window[cb]; s.remove(); };
    const to=setTimeout(()=>{ done(); rej(new Error("timeout")); },8000);
    window[cb]=d=>{ done(); res(d); };
    s.onerror=()=>{ done(); rej(new Error("net")); };
    s.src=url+"&callback="+cb; document.head.appendChild(s);
  });
}
async function itunesLookup(t){
  const d=await jsonp(`https://itunes.apple.com/search?term=${enc(t.title+" "+t.artists[0])}&media=music&entity=song&limit=8`);
  const res=(d.results||[]).filter(x=>x.previewUrl), nt=norm(t.title), na=norm(t.artists[0]);
  const b=res.find(x=>norm(x.trackName)===nt && norm(x.artistName).includes(na.split(" ")[0])) || res.find(x=>norm(x.trackName).includes(nt)||nt.includes(norm(x.trackName)));
  return b ? {preview:b.previewUrl, cover:(b.artworkUrl100||"").replace("100x100","300x300")} : null;
}
function loadSrc(url){
  return new Promise(res=>{
    const clean=()=>{ clearTimeout(to); audio.removeEventListener("loadedmetadata",ok); audio.removeEventListener("error",bad); };
    const ok=()=>{ clean(); res(true); }, bad=()=>{ clean(); res(false); };
    const to=setTimeout(bad,8000);
    audio.addEventListener("loadedmetadata",ok); audio.addEventListener("error",bad);
    audio.src=url; audio.load();
  });
}
async function prepareAudio(t){
  if(t.preview && await loadSrc(t.preview)) return true;
  if(!t.itunesTried){
    t.itunesTried=true;
    try{
      const f=await itunesLookup(t);
      if(f){ t.cover=t.cover||f.cover; if(await loadSrc(f.preview)){ t.preview=f.preview; return true; } }
    }catch(e){ netErr=true; t.itunesTried=false; return false; }
  }
  t.noAudio=true; return false;
}

/* ---------- letras: LRCLIB (principal) e lyrics.ovh (reserva) ---------- */
async function getJson(u){ const r=await fetch(u); if(!r.ok) throw new Error("http "+r.status); return r.json(); }
async function getLyrics(t){
  if(t.lines!==undefined) return t.lines;
  const ti=t.title.replace(/\s-\s.*$/,"").replace(/\(.*?\)/g,"").trim(), ar=t.artists[0];
  let txt=null;
  const tryGet=async fn=>{ if(txt) return; try{ txt=await fn(); }catch(e){ if(e instanceof TypeError) netErr=true; } };
  await tryGet(async()=> (await getJson(`https://lrclib.net/api/get?artist_name=${enc(ar)}&track_name=${enc(ti)}`)).plainLyrics);
  await tryGet(async()=>{ const j=await getJson(`https://lrclib.net/api/search?q=${enc(ti+" "+ar)}`); const h=j.find(x=>x.plainLyrics); return h&&h.plainLyrics; });
  await tryGet(async()=> (await getJson(`https://api.lyrics.ovh/v1/${enc(ar)}/${enc(ti)}`)).lyrics);
  const lines=(txt||"").split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !/^\[.*\]$/.test(l));
  if(lines.join(" ").split(/\s+/).length>=20) return (t.lines=lines);
  if(!netErr) t.noLyrics=true;
  return null;
}
function pickLyrics(lines){
  const need=LV.lyrics[4], cum=[]; let n=0;
  lines.forEach(l=>{ cum.push(n); n+=l.split(/\s+/).length; });
  const ok=lines.map((_,i)=>i).filter(i=>n-cum[i]>=need);
  const s=ok.length ? ok[Math.floor(Math.random()*Math.ceil(ok.length*0.7))] : 0;
  const toks=[];
  lines.slice(s).forEach(l=>l.split(/\s+/).forEach((w,j)=>toks.push({w, br:j===0&&toks.length>0})));
  return toks;
}

/* ---------- tela 1 ---------- */
document.querySelectorAll(".mode").forEach(b=>b.onclick=()=>{
  mode=b.dataset.m;
  document.querySelectorAll(".mode").forEach(x=>{ x.classList.toggle("on",x===b); x.setAttribute("aria-checked",x===b); });
});
async function begin(useDemo){
  const msg=$("msg"); say(msg,""); let list;
  try{
    if(useDemo) list=demoTracks();
    else{
      const f=$("file").files[0];
      if(!f) throw new Error("Selecione o arquivo CSV da sua playlist.");
      list=parseCsv(await f.text());
      if(!list.length) throw new Error("Não consegui ler esse CSV. Use o arquivo gerado pelo Exportify.");
    }
  }catch(e){ return say(msg,e.message||"Erro ao ler o arquivo.",true); }
  tracks=list; pool=[]; wins=played=0;
  $("setup").classList.add("hidden"); $("game").classList.remove("hidden");
  newRound();
}
$("start").onclick=()=>begin(false);
$("demo").onclick=()=>begin(true);
$("back").onclick=()=>{ stop(); cur=null; $("game").classList.add("hidden"); $("setup").classList.remove("hidden"); };

/* ---------- rodada ---------- */
function refreshOptions(){
  $("songs").innerHTML = tracks.filter(t=>!guessedTracks.has(t))
    .map(t=>`<option value="${(t.title+" — "+t.artist).replace(/"/g,"&quot;")}">`).join("");
}
function matchTrack(raw){
  const exact = tracks.find(t => t.title+" — "+t.artist === raw.trim());
  if(exact) return exact;
  const g = norm(raw.replace(/—.*$/,""));
  return g ? (tracks.find(t=>norm(t.title)===g && !guessedTracks.has(t)) || tracks.find(t=>norm(t.title)===g)) : null;
}
const lock = b => { $("play").disabled=$("send").disabled=$("skip").disabled=$("guess").disabled=b; };
async function newRound(){
  stop(); over=false; attempt=0; guesses=[]; cur=null; prevN=0;
  guessedTracks=new Set(); guessedKeys=new Set(); refreshOptions();
  audio.removeAttribute("src"); audio.load();
  $("end").classList.add("hidden"); $("guessBox").classList.remove("hidden");
  $("guess").value=""; lock(true); render();
  $("gmsg").innerHTML='<span class="spin"></span>'+(mode==="audio"?"Carregando música…":"Buscando a letra…");
  let tries=0, netFails=0;
  const myMode=mode;
  while(tries++<15 && netFails<3){
    const usable=t=>myMode==="audio"?!t.noAudio:!t.noLyrics;
    if(!pool.length) pool=tracks.filter(usable).sort(()=>Math.random()-.5);
    if(!pool.length) break;
    const t=pool.pop(); netErr=false;
    let ok;
    if(myMode==="audio") ok=await prepareAudio(t);
    else{ const l=await getLyrics(t); ok=!!l; if(ok) t.toks=pickLyrics(l); }
    if(mode!==myMode || !$("setup").classList.contains("hidden")) return;
    if(ok){ cur=t; break; }
    if(netErr) netFails++;
  }
  if(!cur){
    say($("gmsg"), netErr ? "Não consegui acessar a internet para buscar "+(mode==="audio"?"o áudio":"a letra")+". Verifique a conexão e clique em Trocar playlist ou modo." : "Nenhuma música desta playlist tem "+(mode==="audio"?"trecho de áudio":"letra")+" disponível.", true);
    return;
  }
  say($("gmsg"),""); lock(false); render();
}

function render(){
  const lvl=Math.min(attempt,4), isA=mode==="audio";
  const slots=$("slots"); slots.innerHTML="";
  LV[mode].forEach((_,i)=>{
    const g=guesses[i], el=document.createElement("div");
    el.className="slot"+(g?" "+g.cls:"")+(!g&&i===attempt&&!over?" cur":"");
    el.innerHTML=`<span class="n">${i+1}</span><span class="t"></span><span class="d">${lbl(i)}</span>`;
    el.querySelector(".t").textContent=g?g.text:(i===attempt&&!over&&cur?"Aguardando palpite…":"");
    if(g&&g.fresh){ el.classList.add("pop"); g.fresh=false; }
    slots.appendChild(el);
  });
  const info = over ? "Trecho completo" : isA ? "Duração: "+fmt(LV.audio[lvl])+"s" : "Trecho: "+LV.lyrics[lvl]+" palavras";
  const att = over ? "" : `Tentativa ${lvl+1} de 5`;
  $("player").classList.toggle("hidden", !isA && !over);
  $("lyr").classList.toggle("hidden", isA);
  $("lyrInfo").classList.toggle("hidden", isA);
  $("dur").textContent=isA||over?info:""; $("att").textContent=att;
  $("dur2").textContent=info; $("att2").textContent=att;
  $("unl").style.width=(over?100:LV.audio[lvl]/6*100)+"%";
  $("ticks").innerHTML=LV.audio.slice(0,4).map(d=>`<i style="left:${d/6*100}%"></i>`).join("");
  $("stats").textContent=played?`Acertos: ${wins}/${played}`:"";
  if(!isA) renderLyrics(LV.lyrics[lvl]);
}
function renderLyrics(n){
  const box=$("lyr"); box.innerHTML="";
  if(!cur||!cur.toks){ return; }
  cur.toks.slice(0,n).forEach((t,i)=>{
    if(i&&t.br) box.appendChild(document.createElement("br"));
    const s=document.createElement("span"); s.className=i>=prevN?"new":"old"; s.textContent=(i&&!t.br?" ":"")+t.w; box.appendChild(s);
  });
  const d=document.createElement("span"); d.className="dots"; d.textContent=" …"; box.appendChild(d);
  prevN=Math.max(prevN,n);
}

/* ---------- reprodução ---------- */
function stop(){
  clearTimeout(timer); cancelAnimationFrame(raf);
  audio.pause(); playing=false; $("play").textContent="▶"; $("fill").style.width="0";
}
function play(){
  if(!cur) return;
  if(playing){ stop(); return; }
  const limit=over?30:LV.audio[Math.min(attempt,4)];
  audio.currentTime=0;
  audio.play().then(()=>{
    playing=true; $("play").textContent="❚❚";
    const t0=performance.now(), total=over?30:6;
    clearTimeout(timer); timer=setTimeout(stop,limit*1000);
    (function tick(){
      $("fill").style.width=Math.min((performance.now()-t0)/1000/total*100,100)+"%";
      if(playing) raf=requestAnimationFrame(tick);
    })();
  }).catch(()=>say($("gmsg"),"O navegador bloqueou a reprodução automática. Toque em ▶ para ouvir.",true));
}
audio.addEventListener("ended",stop);
$("play").onclick=play;

/* ---------- palpites ---------- */
function evaluate(raw){
  const g=norm(raw.replace(/—.*$/,"")), full=norm(raw), title=norm(cur.title);
  if(g && (g===title || full===title || (title.length>=3 && (" "+full+" ").includes(" "+title+" ")))) return "green";
  const arts=cur.artists.map(norm).concat(norm(cur.artist));
  const hit=arts.some(a=>a && ((" "+full+" ").includes(" "+a+" ") || (g.length>=3 && (" "+a+" ").includes(" "+g+" "))));
  return hit?"yellow":"red";
}
function answer(text, forced){
  if(over||!cur) return;
  if(!forced){
    const m=matchTrack(text), key=norm(text.replace(/—.*$/,""));
    if((m && guessedTracks.has(m)) || guessedKeys.has(key)){
      say($("gmsg"),"Você já chutou essa música. Escolha outra.",true); $("guess").select(); return;
    }
    if(m) guessedTracks.add(m);
    guessedKeys.add(key); refreshOptions();
  }
  stop();
  const cls=forced||evaluate(text);
  guesses[attempt]={text:forced?"Pulado":text, cls, fresh:true};
  $("guess").value="";
  if(cls==="green") return finish(true);
  attempt++;
  if(attempt>=5) return finish(false);
  render();
  say($("gmsg"), cls==="yellow"?"Você acertou o artista! Falta a música.":"");
  if(mode==="audio") play();
}
async function finish(win){
  over=true; played++; if(win) wins++;
  const t=cur;
  $("guessBox").classList.add("hidden"); $("end").classList.remove("hidden");
  const r=$("res"); r.textContent=win?`Acertou na tentativa ${attempt+1}!`:"Não foi dessa vez."; r.className="res "+(win?"win":"lose");
  $("rt").textContent=t.title; $("ra").textContent=t.artist;
  $("cover").src=t.cover||"data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  say($("gmsg"),""); render();
  if(mode==="audio") play();                       // toca o trecho completo automaticamente
  else if(await prepareAudio(t) && over && cur===t) play();
}
$("send").onclick=()=>{ const v=$("guess").value.trim(); if(v) answer(v); };
$("guess").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); $("send").click(); }});
$("skip").onclick=()=>answer("","red");
$("next").onclick=newRound;

/* ---------- tutorial ---------- */
const help = $("help");
document.querySelectorAll(".open-help").forEach(b => b.onclick = () => help.showModal());
$("helpX").onclick = $("helpOk").onclick = () => help.close();
help.addEventListener("click", e => { if(e.target === help) help.close(); });  // clique fora fecha
