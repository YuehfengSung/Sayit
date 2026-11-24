/* SayIt 英語口說 — 個人用 PWA
 * 資料都存在本機瀏覽器（localStorage + IndexedDB）。
 * 外部服務：Claude API（文字）、Google Cloud TTS（語音，可選）、瀏覽器語音辨識。
 */
'use strict';

/* ---------- 基本工具 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const store = {
  get(k, def) { try { const v = localStorage.getItem('sayit.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('sayit.' + k, JSON.stringify(v)); } catch (e) { toast('儲存失敗：' + e.message); } }
};

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
const spinner = msg => `<div class="spinner">${esc(msg)}</div>`;

/* ---------- 設定 ---------- */
const DEFAULTS = {
  claudeKey: '', model: 'claude-haiku-5-5',
  ttsKey: '', voiceEn: 'en-US-Chirp3-HD-Aoede', voiceZh: 'cmn-TW-Wavenet-A', rate: 0.95,
  repeat: 2, pause: 2, zhMode: 'after',
  level: '中級：讀寫還可以，口說不夠流利，想學道地的日常說法',
  interests: '日常生活、研究室日常與開會、國際研討會交流與 small talk、出國旅遊',
  autoplay: true, autoSend: true
};
let S = Object.assign({}, DEFAULTS, store.get('settings', {}));

const EN_VOICES = [
  ['en-US-Chirp3-HD-Aoede', '美式 女聲 Aoede'], ['en-US-Chirp3-HD-Kore', '美式 女聲 Kore'],
  ['en-US-Chirp3-HD-Leda', '美式 女聲 Leda'], ['en-US-Chirp3-HD-Zephyr', '美式 女聲 Zephyr'],
  ['en-US-Chirp3-HD-Charon', '美式 男聲 Charon'], ['en-US-Chirp3-HD-Puck', '美式 男聲 Puck'],
  ['en-US-Chirp3-HD-Fenrir', '美式 男聲 Fenrir'], ['en-US-Chirp3-HD-Orus', '美式 男聲 Orus'],
  ['en-GB-Chirp3-HD-Aoede', '英式 女聲 Aoede'], ['en-GB-Chirp3-HD-Charon', '英式 男聲 Charon']
];

/* ---------- 用量與費用估計 ---------- */
const PRICE = { // USD / 百萬 token
  'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5': [1, 5]
};
function addUsage(model, u, ttsChars = 0) {
  const m = new Date().toISOString().slice(0, 7);
  const U = store.get('usage', {});
  if (!U[m]) U[m] = { usd: 0, inTok: 0, outTok: 0, ttsChars: 0, calls: 0 };
  if (u) {
    const p = PRICE[model] || [2, 10];
    const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    U[m].inTok += inTok; U[m].outTok += u.output_tokens || 0; U[m].calls++;
    U[m].usd += (inTok * p[0] + (u.output_tokens || 0) * p[1]) / 1e6;
  }
  U[m].ttsChars += ttsChars;
  store.set('usage', U); renderUsage();
}
function renderUsage() {
  const m = new Date().toISOString().slice(0, 7);
  const u = store.get('usage', {})[m];
  $('#costBadge').textContent = u ? `本月約 US$${u.usd.toFixed(3)}` : '';
  $('#usageText').textContent = u
    ? `本月：Claude 呼叫 ${u.calls} 次，約 US$${u.usd.toFixed(3)}；Google 語音 ${u.ttsChars.toLocaleString()} 字（每月 100 萬字內免費）。`
    : '本月尚無用量。';
}

/* ---------- Claude API ---------- */
function systemPrompt(extra = '') {
  return `You are a friendly, practical English speaking coach for a Taiwanese adult learner.
Learner level: ${S.level}
Learner's everyday contexts and interests: ${S.interests}
Teach natural, everyday spoken American English — what a native speaker would actually say out loud, not textbook or written style.
All explanations must be in Traditional Chinese as used in Taiwan (繁體中文、台灣用語), short and clear.
When asked for JSON, output ONLY one valid JSON object: no markdown fences, no extra text.
${extra}`;
}

async function claude(system, messages, maxTokens = 3000) {
  if (!S.claudeKey) { showTab('settings'); throw new Error('請先在「設定」填入 Claude API key。'); }
  const body = { model: S.model, max_tokens: maxTokens, system, messages };
  if (/-5-5$|-5$/.test(S.model)) body.output_config = { effort: 'low' };
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': S.claudeKey,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
  } catch (e) { throw new Error('連線失敗，請檢查網路。'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 401) throw new Error('Claude API key 不正確（401）。');
    if (res.status === 429) throw new Error('請求太頻繁或額度不足（429），稍等再試。');
    throw new Error(`Claude API 錯誤 ${res.status}：${msg}`);
  }
  addUsage(S.model, data.usage);
  if (data.stop_reason === 'refusal') throw new Error('AI 拒絕回答這個內容。');
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

function parseJSON(text) {
  let t = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('AI 回覆格式不正確，請再試一次。');
  return JSON.parse(t.slice(a, b + 1));
}
async function claudeJSON(system, userText, maxTokens) {
  const txt = await claude(system, [{ role: 'user', content: userText }], maxTokens);
  return parseJSON(txt);
}

/* ---------- 語音合成（TTS） ---------- */
let idb;
function openDB() {
  if (idb) return Promise.resolve(idb);
  return new Promise((res, rej) => {
    const r = indexedDB.open('sayit', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('audio');
    r.onsuccess = () => { idb = r.result; res(idb); };
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(k) {
  try { const db = await openDB(); return await new Promise(res => { const q = db.transaction('audio').objectStore('audio').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch { return undefined; }
}
async function dbPut(k, v) {
  try { const db = await openDB(); await new Promise(res => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(v, k); tx.oncomplete = res; tx.onerror = res; }); } catch { }
}
async function dbClear() {
  const db = await openDB(); await new Promise(res => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').clear(); tx.oncomplete = res; });
}

const isZh = s => /[一-鿿]/.test(s);

/** 取得 Google TTS mp3（有快取）。lang: 'en' | 'zh' */
async function ttsBlob(text, lang = 'en', rate) {
  const voice = lang === 'zh' ? S.voiceZh : S.voiceEn;
  rate = rate ?? (lang === 'zh' ? 1.0 : S.rate);
  const key = `${voice}|${rate}|${text}`;
  const hit = await dbGet(key);
  if (hit) return hit;
  const langCode = voice.split('-').slice(0, 2).join('-');
  const req = async withRate => {
    const audioConfig = { audioEncoding: 'MP3' };
    if (withRate) audioConfig.speakingRate = rate;
    return fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(S.ttsKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: langCode, name: voice }, audioConfig })
    });
  };
  let res = await req(true);
  if (res.status === 400 && rate !== 1) res = await req(false); // 少數語音不支援語速
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google 語音錯誤：' + (data?.error?.message || res.status));
  const bin = atob(data.audioContent);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: 'audio/mpeg' });
  addUsage(null, null, text.length);
  await dbPut(key, blob);
  return blob;
}

const oneShot = new Audio();
let oneShotURL;
/** 播放一句話。slow=true 時放慢 */
async function speak(text, { slow = false, lang } = {}) {
  lang = lang || (isZh(text) ? 'zh' : 'en');
  stopSpeak();
  if (S.ttsKey) {
    try {
      const rate = lang === 'en' ? (slow ? Math.max(0.6, S.rate - 0.25) : S.rate) : 1.0;
      const blob = await ttsBlob(text, lang, rate);
      if (oneShotURL) URL.revokeObjectURL(oneShotURL);
      oneShotURL = URL.createObjectURL(blob);
      oneShot.src = oneShotURL;
      const done = new Promise(r => { oneShot.onended = r; oneShot.onpause = r; });
      await oneShot.play();
      return done;
    } catch (e) {
      if (e.name === 'AbortError') return; // 被下一句打斷，正常
      toast(e.message);
    }
  }
  // 手機內建語音備援
  if (!('speechSynthesis' in window)) return;
  return new Promise(r => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'zh' ? 'zh-TW' : 'en-US';
    u.rate = lang === 'en' ? (slow ? 0.7 : S.rate) : 1;
    const v = speechSynthesis.getVoices().find(v => v.lang.replace('_', '-').startsWith(u.lang));
    if (v) u.voice = v;
    u.onend = r; u.onerror = r;
    speechSynthesis.speak(u);
  });
}
function stopSpeak() {
  try { oneShot.pause(); } catch { }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

/* ---------- 語音辨識 ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRec = null;
/** 開始辨識，回傳最終文字。onInterim 會收到即時結果 */
function listen(lang = 'en-US', onInterim) {
  return new Promise((resolve, reject) => {
    if (!SR) return reject(new Error('這個瀏覽器不支援語音辨識，請用 Android 版 Chrome。'));
    stopSpeak();
    if (activeRec) try { activeRec.abort(); } catch { }
    const rec = new SR();
    activeRec = rec;
    rec.lang = lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = '';
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      onInterim && onInterim((finalText + ' ' + interim).trim());
    };
    rec.onerror = e => {
      activeRec = null;
      if (e.error === 'no-speech') reject(new Error('沒有聽到聲音，再試一次。'));
      else if (e.error === 'not-allowed') reject(new Error('請允許麥克風權限。'));
      else if (e.error === 'aborted') resolve(finalText.trim());
      else reject(new Error('語音辨識錯誤：' + e.error));
    };
    rec.onend = () => { activeRec = null; resolve(finalText.trim()); };
    rec.start();
  });
}
function stopListen() { if (activeRec) try { activeRec.stop(); } catch { } }

/** 把錄音按鈕接上辨識。onDone(text) */
function micButton(btn, lang, { idleLabel, onInterim, onDone }) {
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('rec')) { stopListen(); return; }
    btn.classList.add('rec'); btn.textContent = '⏹ 聆聽中…（點我結束）';
    try {
      const text = await listen(lang, onInterim);
      if (text) onDone(text); else toast('沒有辨識到內容');
    } catch (e) { toast(e.message, 3000); }
    finally { btn.classList.remove('rec'); btn.textContent = idleLabel; }
  });
}

/* ---------- 比對跟讀結果 ---------- */
const CONTRACT = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are', "it's": 'it is', "that's": 'that is',
  "there's": 'there is', "what's": 'what is', "let's": 'let us', "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "can't": 'can not', "cannot": 'can not', "won't": 'will not', "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not',
  "i'll": 'i will', "you'll": 'you will', "we'll": 'we will', "i've": 'i have', "you've": 'you have', "we've": 'we have',
  "i'd": 'i would', "you'd": 'you would', "gonna": 'going to', "wanna": 'want to', "gotta": 'got to', "ok": 'okay'
};
const normTok = w => {
  w = w.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
  return (CONTRACT[w] || w).split(' ').filter(Boolean);
};
function compareSpeech(target, heard) {
  const words = target.split(/\s+/).filter(Boolean);
  const tTok = [], owner = [];
  words.forEach((w, i) => normTok(w).forEach(t => { tTok.push(t); owner.push(i); }));
  const hTok = heard.split(/\s+/).flatMap(normTok);
  // LCS
  const n = tTok.length, m = hTok.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = tTok[i] === hTok[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const okTok = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (tTok[i] === hTok[j]) { okTok[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  const wordOk = words.map(() => true);
  okTok.forEach((ok, k) => { if (!ok) wordOk[owner[k]] = false; });
  const scorable = words.map((w, k) => normTok(w).length > 0);
  const total = scorable.filter(Boolean).length || 1;
  const good = words.filter((w, k) => scorable[k] && wordOk[k]).length;
  return { words, wordOk, score: Math.round(100 * good / total) };
}

/* ---------- 頁籤 ---------- */
const TITLES = { daily: '今日片語', express: '我想說', chat: '英文對話', fav: '我的最愛', settings: '設定' };
function showTab(name) {
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('#pageTitle').textContent = TITLES[name];
  window.scrollTo(0, 0);
  if (name === 'daily') ensureDaily();
  if (name === 'fav') renderFavs();
  if (name === 'settings') loadSettingsForm();
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- 共用的句子列 ---------- */
// data-say / data-shadow / data-chat 由下方的事件委派處理
function sentenceLine(en, zh, { fav = true, chat = false } = {}) {
  return `<div class="line">
    <div class="txt"><div class="en">${esc(en)}</div>${zh ? `<div class="zh">${esc(zh)}</div>` : ''}</div>
    <button class="icon-btn" data-say="${esc(en)}" title="播放">🔊</button>
    <button class="icon-btn" data-shadow="${esc(en)}" data-zh="${esc(zh || '')}" title="跟讀">🎤</button>
    ${fav ? `<button class="icon-btn" data-favline="${esc(en)}" data-zh="${esc(zh || '')}" title="加入最愛">☆</button>` : ''}
    ${chat ? `<button class="icon-btn" data-chat="${esc(en)}" title="用這句聊天">💬</button>` : ''}
  </div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-say],[data-shadow],[data-favline],[data-chat],[data-close]');
  if (!b) return;
  if (b.dataset.say != null) speak(b.dataset.say);
  else if (b.dataset.shadow != null) openShadow(b.dataset.shadow, b.dataset.zh);
  else if (b.dataset.favline != null) {
    addFav({ title: b.dataset.favline, note: '', sentences: [{ en: b.dataset.favline, zh: b.dataset.zh }] });
    b.textContent = '★';
  }
  else if (b.dataset.chat != null) startChat(`練習使用這個說法：「${b.dataset.chat}」`, b.dataset.chat, `練習「${b.dataset.chat}」`);
  else if (b.dataset.close != null) { b.closest('.sheet').classList.add('hidden'); stopSpeak(); stopListen(); if (b.closest('#playerSheet')) stopPlayer(); }
});

/* ---------- 今日片語 ---------- */
let dailyBusy = false;
async function ensureDaily() {
  const d = store.get('daily', null);
  if (d && d.date === today() && d.items?.length) return renderDaily();
  if (!S.claudeKey) {
    $('#dailyList').innerHTML = `<div class="card">歡迎！請先到「設定」填入 Claude API key，就會每天自動產生 3 個實用片語。</div>`;
    return;
  }
  await moreDaily(true);
}
async function moreDaily(fresh = false) {
  if (dailyBusy) return; dailyBusy = true;
  const list = $('#dailyList');
  const holder = document.createElement('div'); holder.innerHTML = spinner('正在挑選今天的片語…');
  if (fresh) list.innerHTML = '';
  list.appendChild(holder);
  try {
    const history = store.get('history', []);
    const prompt = `Today is ${today()}. Give me 3 short, high-frequency spoken English expressions (natural chunks of about 2–7 words, like "I'm swamped", "It slipped my mind", "Let me get back to you on that").
Mix different everyday situations, drawing on my contexts. Prefer expressions an intermediate learner probably doesn't use yet but natives say often.
Do NOT repeat any of these I've already learned: ${JSON.stringify(history.slice(-150))}
JSON shape:
{"phrases":[{"phrase":"","meaning_zh":"簡短中文意思","usage_zh":"什麼情況用、語氣、注意事項（1–2 句）","examples":[{"en":"short natural spoken sentence using it","zh":"中文翻譯"},{"en":"","zh":""}]}]}`;
    const j = await claudeJSON(systemPrompt(), prompt, 3000);
    const items = (j.phrases || []).slice(0, 3);
    const d = store.get('daily', null);
    const all = (!fresh && d && d.date === today()) ? d.items.concat(items) : items;
    store.set('daily', { date: today(), items: all });
    store.set('history', history.concat(items.map(p => p.phrase)).slice(-400));
    renderDaily();
  } catch (e) {
    holder.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  } finally { dailyBusy = false; }
}
function phraseToFav(p) {
  return { title: p.phrase, note: `${p.meaning_zh || ''}${p.usage_zh ? '｜' + p.usage_zh : ''}`,
    sentences: [{ en: p.phrase, zh: p.meaning_zh || '' }, ...(p.examples || []).map(x => ({ en: x.en, zh: x.zh }))] };
}
function renderDaily() {
  const d = store.get('daily', { items: [] });
  $('#dailyList').innerHTML = d.items.map((p, i) => `
    <div class="card">
      <div class="line">
        <p class="phrase txt">${esc(p.phrase)}</p>
        <button class="icon-btn" data-say="${esc(p.phrase)}">🔊</button>
        <button class="icon-btn" data-dailyfav="${i}" title="加入最愛">${isFav(p.phrase) ? '★' : '☆'}</button>
      </div>
      <p class="meaning">${esc(p.meaning_zh)}</p>
      <p class="small muted">${esc(p.usage_zh)}</p>
      ${(p.examples || []).map(x => `<div class="ex">${sentenceLine(x.en, x.zh, { fav: false })}</div>`).join('')}
      <div class="row">
        <button class="btn tiny ghost" data-shadow="${esc(p.phrase)}" data-zh="${esc(p.meaning_zh)}">🎤 跟讀</button>
        <button class="btn tiny ghost" data-lesson-phrase="${i}">📚 建立小課程</button>
        <button class="btn tiny ghost" data-chat="${esc(p.phrase)}">💬 用它聊天</button>
      </div>
    </div>`).join('');
}
$('#dailyList').addEventListener('click', async e => {
  const f = e.target.closest('[data-dailyfav]');
  if (f) {
    const p = store.get('daily').items[+f.dataset.dailyfav];
    if (!isFav(p.phrase)) { addFav(phraseToFav(p)); f.textContent = '★'; }
    return;
  }
  const l = e.target.closest('[data-lesson-phrase]');
  if (l) {
    const p = store.get('daily').items[+l.dataset.lessonPhrase];
    makeLesson(p.phrase, p.meaning_zh, l);
  }
});
$('#btnMoreDaily').addEventListener('click', () => moreDaily(false));

/* ---------- 小課程 ---------- */
async function makeLesson(en, zh, btn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '建立中…'; }
  try {
    const j = await claudeJSON(systemPrompt(), `Make a mini listening lesson so I can master this expression by listening repeatedly during my commute:
Expression: "${en}" ${zh ? `(意思：${zh})` : ''}
Give 6 short, natural spoken sentences that use it (or its key chunk) in different realistic situations from my life; vary tense/person a little. Keep each sentence under 15 words.
JSON: {"title":"簡短中文標題","key":"the core chunk","note_zh":"用法重點 1–2 句","sentences":[{"en":"","zh":""}]}`, 3000);
    addFav({ title: `📚 ${j.key || en}`, note: `${j.title || ''}${j.note_zh ? '｜' + j.note_zh : ''}`,
      sentences: [{ en, zh: zh || '' }, ...(j.sentences || [])] });
    if (btn) btn.textContent = '✓ 已加入最愛';
  } catch (e) { toast(e.message, 3500); if (btn) btn.textContent = old; }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- 我想說（中→英） ---------- */
let lastExpress = null;
micButton($('#btnZhMic'), 'zh-TW', {
  idleLabel: '🎤 中文語音',
  onInterim: t => { $('#zhInput').value = t; },
  onDone: t => { $('#zhInput').value = t; }
});
$('#btnExpress').addEventListener('click', doExpress);
async function doExpress() {
  const zh = $('#zhInput').value.trim();
  if (!zh) return toast('先輸入想說的話');
  const out = $('#expressResult');
  out.innerHTML = spinner('想想英文怎麼說…');
  try {
    const j = await claudeJSON(systemPrompt(), `I want to say this in natural spoken English: 「${zh}」
Give the most natural way a native speaker would say it in conversation, plus 2 alternatives with different tone. Break out useful chunks to learn.
JSON: {"best":{"en":"","note_zh":"為什麼這樣說／語氣"},"alternatives":[{"en":"","style":"casual|polite|formal","note_zh":""}],"chunks":[{"en":"","zh":""}],"tip_zh":"台灣人常見的錯誤說法或提醒（沒有就留空）"}`, 3000);
    lastExpress = { zh, ...j };
    renderExpress();
  } catch (e) { out.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
function renderExpress() {
  const j = lastExpress; if (!j) return;
  const styleZh = { casual: '輕鬆', polite: '客氣', formal: '正式' };
  $('#expressResult').innerHTML = `
    <div class="card">
      <span class="tag">最自然</span>
      <p class="big-en">${esc(j.best?.en)}</p>
      <p class="small muted">${esc(j.best?.note_zh)}</p>
      <div class="row">
        <button class="btn ghost" data-say="${esc(j.best?.en)}">🔊 聽</button>
        <button class="btn primary grow" data-shadow="${esc(j.best?.en)}" data-zh="${esc(j.zh)}">🎤 跟著唸</button>
      </div>
    </div>
    ${(j.alternatives || []).length ? `<div class="card"><b>其他說法</b>
      ${j.alternatives.map(a => `<div class="ex"><span class="tag">${esc(styleZh[a.style] || a.style)}</span>${sentenceLine(a.en, a.note_zh, { fav: false })}</div>`).join('')}</div>` : ''}
    ${(j.chunks || []).length ? `<div class="card"><b>重點片語</b><div class="chunks">
      ${j.chunks.map(c => `<span class="chunk" data-say="${esc(c.en)}">${esc(c.en)}｜${esc(c.zh)}</span>`).join('')}</div></div>` : ''}
    ${j.tip_zh ? `<div class="card small">💡 ${esc(j.tip_zh)}</div>` : ''}
    <div class="row">
      <button id="exFav" class="btn ghost grow">☆ 加入最愛</button>
      <button id="exLesson" class="btn ghost grow">📚 建立小課程</button>
    </div>
    <button id="exChat" class="btn primary full">💬 唸完了，接著用英文聊</button>`;
  $('#exFav').onclick = e => {
    addFav({ title: j.best.en, note: j.zh, sentences: [{ en: j.best.en, zh: j.zh }, ...(j.alternatives || []).map(a => ({ en: a.en, zh: a.note_zh || '' }))] });
    e.target.textContent = '★ 已加入';
  };
  $('#exLesson').onclick = e => makeLesson(j.best.en, j.zh, e.target);
  $('#exChat').onclick = () => startChat(`我剛學會怎麼說「${j.zh}」→ "${j.best.en}"。請開啟一段會自然用到這句話的日常對話。`, j.best.en, `練習「${j.zh}」`);
}

/* ---------- 跟讀 ---------- */
let shadowTarget = { en: '', zh: '' };
function openShadow(en, zh) {
  shadowTarget = { en, zh };
  $('#shTarget').textContent = en; $('#shZh').textContent = zh || '';
  $('#shResult').innerHTML = '';
  $('#shadowSheet').classList.remove('hidden');
  speak(en);
}
$('#shPlay').onclick = () => speak(shadowTarget.en);
$('#shSlow').onclick = () => speak(shadowTarget.en, { slow: true });
micButton($('#shMic'), 'en-US', {
  idleLabel: '🎤 按下開始唸',
  onInterim: t => { $('#shResult').innerHTML = `<p class="muted">${esc(t)}</p>`; },
  onDone: heard => {
    const r = compareSpeech(shadowTarget.en, heard);
    const words = r.words.map((w, i) => `<span class="${r.wordOk[i] ? 'w-ok' : 'w-miss'}">${esc(w)}</span>`).join(' ');
    const msg = r.score >= 90 ? '很棒！🎉' : r.score >= 70 ? '不錯，紅色的字再注意一下' : '再試一次，先聽慢速版';
    $('#shResult').innerHTML = `
      <div class="card"><div class="row between"><span class="score">${r.score}</span><span>${msg}</span></div>
      <p class="en">${words}</p><p class="small muted">辨識到：${esc(heard)}</p>
      <button id="shAsk" class="btn tiny ghost">🤖 請 AI 給發音建議</button><div id="shTips"></div></div>`;
    $('#shAsk').onclick = async e => {
      e.target.disabled = true; $('#shTips').innerHTML = spinner('分析中…');
      try {
        const t = await claude(systemPrompt('Reply in plain text (no JSON), at most 4 short bullet points.'), [{ role: 'user', content:
          `I tried to say: "${shadowTarget.en}"\nSpeech recognition heard: "${heard}"\nBased on the differences, which words did I probably mispronounce or swallow, and how should I say them (stress, linking, reductions)? If it matches well, just give one tip for sounding more natural (linking/intonation).` }], 1500);
        $('#shTips').innerHTML = `<p class="small" style="white-space:pre-wrap">${esc(t)}</p>`;
      } catch (err) { $('#shTips').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    };
  }
});

/* ---------- 對話 ---------- */
let chat = null; // {topic, system, messages:[{role, content}], view:[]}
const CHAT_RULES = topic => systemPrompt(`
You are now "Sam", a friendly native English speaker chatting with the learner to practice everyday spoken English.
Conversation context: ${topic || 'a casual everyday topic of your choice that fits the learner\'s life'}
Rules:
- Reply in natural spoken English, 1–3 short sentences, matched to the learner's level. Usually end with a question to keep the chat going.
- The learner's messages are often speech-recognition transcripts: ignore missing punctuation/capitalization and obvious recognition errors.
- If the learner's English has a real grammar mistake or sounds unnatural, put a more natural version in "correction". If it's fine, set "correction" to null. Don't nitpick.
- If the learner writes in Chinese (they didn't know how to say it), put the natural English for it in "correction.better", then continue the chat as if they'd said it.
- Output ONLY JSON: {"reply":"your English reply","reply_zh":"繁中翻譯","correction":null | {"better":"","note_zh":"簡短說明"}}`);

async function startChat(topic, seedSentence, label) {
  showTab('chat');
  label = label || topic || '自由聊天';
  chat = { topic: label, system: CHAT_RULES(topic), messages: [], };
  $('#chatStart').classList.add('hidden'); $('#chatBox').classList.remove('hidden');
  $('#chatTopicLabel').textContent = '主題：' + label;
  $('#chatLog').innerHTML = '';
  ensureComposer();
  const opener = `[Start the conversation now with a natural opening line${seedSentence ? `, steering toward a situation where I would naturally say "${seedSentence}"` : ''}. Return the JSON.]`;
  await chatSend(opener, { hidden: true });
}
function ensureComposer() {
  if ($('#composer')) return;
  const c = document.createElement('div');
  c.id = 'composer'; c.className = 'composer';
  c.innerHTML = `
    <div class="row"><button id="cMic" class="btn primary grow">🎤 用英文回答</button><button id="cHelp" class="btn ghost" title="不知道怎麼說時，用中文說">🀄 中文求救</button></div>
    <div class="row"><input id="cText" type="text" placeholder="或打字…" enterkeyhint="send"><button id="cSend" class="btn ghost">送出</button></div>`;
  $('#chatBox').appendChild(c);
  micButton($('#cMic'), 'en-US', {
    idleLabel: '🎤 用英文回答',
    onInterim: t => { $('#cText').value = t; },
    onDone: t => { $('#cText').value = t; if (S.autoSend) sendTyped(); }
  });
  micButton($('#cHelp'), 'zh-TW', {
    idleLabel: '🀄 中文求救',
    onInterim: t => { $('#cText').value = t; },
    onDone: t => { $('#cText').value = t; if (S.autoSend) sendTyped(); }
  });
  $('#cSend').onclick = sendTyped;
  $('#cText').addEventListener('keydown', e => { if (e.key === 'Enter') sendTyped(); });
}
function sendTyped() {
  const t = $('#cText').value.trim(); if (!t || !chat) return;
  $('#cText').value = ''; chatSend(t);
}
async function chatSend(text, { hidden = false } = {}) {
  const log = $('#chatLog');
  let meEl;
  if (!hidden) {
    meEl = document.createElement('div'); meEl.className = 'bubble me'; meEl.textContent = text; log.appendChild(meEl);
  }
  chat.messages.push({ role: 'user', content: text });
  const wait = document.createElement('div'); wait.innerHTML = spinner('Sam 正在回覆…'); log.appendChild(wait);
  wait.scrollIntoView({ behavior: 'smooth', block: 'end' });
  const myChat = chat;
  try {
    const raw = await claude(chat.system, chat.messages.slice(-30), 2000);
    if (chat !== myChat) return; // 對話已結束
    let j; try { j = parseJSON(raw); } catch { j = { reply: raw, reply_zh: '', correction: null }; }
    chat.messages.push({ role: 'assistant', content: JSON.stringify(j) });
    wait.remove();
    if (j.correction && j.correction.better && meEl) {
      const fx = document.createElement('div'); fx.className = 'fix';
      fx.innerHTML = `<b>更自然的說法</b>${sentenceLine(j.correction.better, j.correction.note_zh)}`;
      log.appendChild(fx);
    }
    const ai = document.createElement('div'); ai.className = 'bubble ai';
    ai.innerHTML = `<div class="en">${esc(j.reply)}</div><div class="zh hidden">${esc(j.reply_zh)}</div>
      <div class="tools"><button class="icon-btn" data-say="${esc(j.reply)}">🔊</button>
      <button class="icon-btn" data-showzh>中</button>
      <button class="icon-btn" data-shadow="${esc(j.reply)}" data-zh="${esc(j.reply_zh)}">🎤</button>
      <button class="icon-btn" data-favline="${esc(j.reply)}" data-zh="${esc(j.reply_zh)}">☆</button></div>`;
    ai.querySelector('[data-showzh]').onclick = () => ai.querySelector('.zh').classList.toggle('hidden');
    log.appendChild(ai);
    ai.scrollIntoView({ behavior: 'smooth', block: 'end' });
    if (S.autoplay) speak(j.reply);
  } catch (e) {
    chat.messages.pop();
    wait.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}
$('#btnStartChat').onclick = () => startChat($('#chatTopic').value.trim());
$('#btnEndChat').onclick = () => {
  chat = null; stopSpeak(); stopListen();
  $('#chatBox').classList.add('hidden'); $('#chatStart').classList.remove('hidden');
};

/* ---------- 最愛 ---------- */
const favs = () => store.get('favs', []);
const isFav = title => favs().some(f => f.title === title || f.title === '📚 ' + title);
function addFav(item) {
  const list = favs();
  if (list.some(f => f.title === item.title && f.sentences.length === item.sentences.length)) return toast('已經在最愛裡了');
  list.unshift({ id: uid(), created: Date.now(), selected: true, ...item });
  store.set('favs', list); toast('已加入最愛 ⭐');
}
function renderFavs() {
  const list = favs();
  $('#favCount').textContent = `共 ${list.length} 項，已選 ${list.filter(f => f.selected).length} 項（${list.filter(f => f.selected).reduce((a, f) => a + f.sentences.length, 0)} 句）`;
  $('#favSelectAll').checked = list.length > 0 && list.every(f => f.selected);
  $('#favList').innerHTML = list.length ? list.map(f => `
    <div class="card" data-id="${f.id}">
      <div class="fav-head">
        <input type="checkbox" data-sel ${f.selected ? 'checked' : ''}>
        <span class="title" data-toggle>${esc(f.title)}</span>
        <span class="small muted">${f.sentences.length} 句</span>
        <button class="icon-btn" data-toggle>▾</button>
      </div>
      <div class="fav-body hidden">
        ${f.note ? `<p class="small muted">${esc(f.note)}</p>` : ''}
        ${f.sentences.map(s => `<div class="ex">${sentenceLine(s.en, s.zh, { fav: false })}</div>`).join('')}
        <div class="row"><button class="btn tiny ghost" data-lessonfav>📚 擴充成小課程</button>
        <button class="btn tiny ghost" data-del>🗑 刪除</button></div>
      </div>
    </div>`).join('') : `<div class="card muted">還沒有最愛。在今日片語、我想說、對話中按 ☆ 就會加進來。</div>`;
}
$('#favList').addEventListener('click', e => {
  const card = e.target.closest('[data-id]'); if (!card) return;
  const id = card.dataset.id, list = favs(), f = list.find(x => x.id === id);
  if (e.target.closest('[data-toggle]')) card.querySelector('.fav-body').classList.toggle('hidden');
  else if (e.target.closest('[data-sel]')) { f.selected = e.target.checked; store.set('favs', list); renderFavCount(); }
  else if (e.target.closest('[data-del]')) { if (confirm('刪除「' + f.title + '」？')) { store.set('favs', list.filter(x => x.id !== id)); renderFavs(); } }
  else if (e.target.closest('[data-lessonfav]')) makeLesson(f.sentences[0].en, f.sentences[0].zh, e.target).then(renderFavs);
});
function renderFavCount() {
  const list = favs();
  $('#favCount').textContent = `共 ${list.length} 項，已選 ${list.filter(f => f.selected).length} 項（${list.filter(f => f.selected).reduce((a, f) => a + f.sentences.length, 0)} 句）`;
}
$('#favSelectAll').onchange = e => { const l = favs(); l.forEach(f => f.selected = e.target.checked); store.set('favs', l); renderFavs(); };

/* ---------- 通勤播放 ---------- */
const plAudio = $('#plAudio');
let pl = null; // {url, segs:[{start,end,en,zh}], token}
const SR_OUT = 22050;

function encodeWAV(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0, o = 44; i < samples.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}
async function decode(blob) {
  const ctx = new OfflineAudioContext(1, 1, SR_OUT);
  const ab = await ctx.decodeAudioData(await blob.arrayBuffer());
  if (ab.numberOfChannels === 1) return ab.getChannelData(0);
  const a = ab.getChannelData(0), b = ab.getChannelData(1), m = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) / 2; return m;
}

$('#btnCommute').onclick = async () => {
  let items = favs().filter(f => f.selected);
  let sents = items.flatMap(f => f.sentences.filter(s => s.en));
  if (!sents.length) return toast('請先在最愛裡勾選要聽的項目');
  if ($('#optShuffle').checked) sents = sents.map(s => [Math.random(), s]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  openPlayer();
  if (!S.ttsKey) return liveFallback(sents);
  const token = uid(); pl = { token, segs: [] };
  const chunks = []; let pos = 0;
  const silence = sec => { const z = new Float32Array(Math.round(sec * SR_OUT)); chunks.push(z); pos += z.length; };
  try {
    for (let i = 0; i < sents.length; i++) {
      if (pl?.token !== token) return;
      const s = sents[i];
      $('#plStatus').textContent = `準備音檔中… ${i + 1} / ${sents.length}（第一次會比較久，之後有快取）`;
      $('#plBar').style.width = `${Math.round(100 * (i + 1) / sents.length)}%`;
      const en = await decode(await ttsBlob(s.en, 'en'));
      const zh = (S.zhMode !== 'none' && s.zh) ? await decode(await ttsBlob(s.zh, 'zh')) : null;
      const start = pos / SR_OUT;
      const pushZh = () => { if (zh) { chunks.push(zh); pos += zh.length; silence(0.8); } };
      if (S.zhMode === 'before') pushZh();
      for (let r = 0; r < S.repeat; r++) { chunks.push(en); pos += en.length; silence(r < S.repeat - 1 ? Math.max(1, S.pause) : 0.8); }
      if (S.zhMode === 'after') pushZh();
      silence(+S.pause);
      pl.segs.push({ start, end: pos / SR_OUT, en: s.en, zh: s.zh });
    }
    const all = new Float32Array(pos); let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const wav = encodeWAV(all, SR_OUT);
    if (pl.url) URL.revokeObjectURL(pl.url);
    pl.url = URL.createObjectURL(wav);
    plAudio.src = pl.url;
    $('#plDownload').href = pl.url;
    $('#plDownload').download = `sayit-${today()}.wav`;
    const mins = (pos / SR_OUT / 60).toFixed(1);
    $('#plStatus').textContent = `共 ${sents.length} 句，約 ${mins} 分鐘`;
    setupMediaSession();
    plAudio.play().catch(() => toast('點播放鍵開始'));
  } catch (e) { $('#plStatus').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
};
function openPlayer() {
  $('#plEn').textContent = ''; $('#plZh').textContent = ''; $('#plBar').style.width = '0';
  $('#plAudio').classList.toggle('hidden', !S.ttsKey); $('#plDownload').classList.toggle('hidden', !S.ttsKey);
  $('#playerSheet').classList.remove('hidden');
}
function stopPlayer() { if (pl) pl.token = null; plAudio.pause(); stopSpeak(); }
function curSeg() { if (!pl?.segs) return -1; const t = plAudio.currentTime; return pl.segs.findIndex(s => t >= s.start && t < s.end); }
plAudio.addEventListener('timeupdate', () => {
  const i = curSeg(); if (i < 0) return;
  const s = pl.segs[i];
  if ($('#plEn').textContent !== s.en) { $('#plEn').textContent = s.en; $('#plZh').textContent = s.zh || ''; }
  $('#plBar').style.width = `${(100 * plAudio.currentTime / (plAudio.duration || 1)).toFixed(1)}%`;
  $('#plStatus').textContent = `第 ${i + 1} / ${pl.segs.length} 句`;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata && (navigator.mediaSession.metadata.title = s.en);
});
plAudio.addEventListener('ended', () => { if ($('#plLoop').checked) { plAudio.currentTime = 0; plAudio.play(); } });
function seekSeg(delta) {
  if (!pl?.segs?.length) return;
  let i = curSeg(); if (i < 0) i = 0;
  i = Math.max(0, Math.min(pl.segs.length - 1, i + delta));
  plAudio.currentTime = pl.segs[i].start + 0.01; plAudio.play();
}
$('#plPrev').onclick = () => seekSeg(-1);
$('#plNext').onclick = () => seekSeg(1);
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'SayIt 通勤播放', artist: 'SayIt', artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  navigator.mediaSession.setActionHandler('previoustrack', () => seekSeg(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => seekSeg(1));
  navigator.mediaSession.setActionHandler('play', () => plAudio.play());
  navigator.mediaSession.setActionHandler('pause', () => plAudio.pause());
}
/** 沒有 Google key：用手機內建語音即時播放（需要開著螢幕） */
async function liveFallback(sents) {
  const token = uid(); pl = { token };
  $('#plStatus').textContent = '使用手機內建語音（需保持螢幕開啟）。設定 Google 語音後可產生背景播放音檔。';
  do {
    for (let i = 0; i < sents.length; i++) {
      const s = sents[i];
      $('#plEn').textContent = s.en; $('#plZh').textContent = s.zh || '';
      $('#plBar').style.width = `${Math.round(100 * (i + 1) / sents.length)}%`;
      if (S.zhMode === 'before' && s.zh) { if (pl?.token !== token) return; await speak(s.zh, { lang: 'zh' }); await sleep(600); }
      for (let r = 0; r < S.repeat; r++) { if (pl?.token !== token) return; await speak(s.en, { lang: 'en' }); await sleep(S.pause * 1000); }
      if (S.zhMode === 'after' && s.zh) { if (pl?.token !== token) return; await speak(s.zh, { lang: 'zh' }); await sleep(S.pause * 1000); }
    }
  } while ($('#plLoop').checked && pl?.token === token);
}

/* ---------- 設定頁 ---------- */
function loadSettingsForm() {
  $('#setVoiceEn').innerHTML = EN_VOICES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
  $('#setClaudeKey').value = S.claudeKey; $('#setModel').value = S.model;
  $('#setTtsKey').value = S.ttsKey; $('#setVoiceEn').value = S.voiceEn; $('#setVoiceZh').value = S.voiceZh;
  $('#setRate').value = S.rate; $('#rateVal').textContent = S.rate;
  $('#setRepeat').value = String(S.repeat); $('#setPause').value = String(S.pause); $('#setZhMode').value = S.zhMode;
  $('#setLevel').value = S.level; $('#setInterests').value = S.interests;
  $('#setAutoplay').checked = S.autoplay; $('#setAutoSend').checked = S.autoSend;
  renderUsage();
}
function readSettingsForm() {
  return Object.assign({}, S, {
    claudeKey: $('#setClaudeKey').value.trim(), model: $('#setModel').value,
    ttsKey: $('#setTtsKey').value.trim(), voiceEn: $('#setVoiceEn').value, voiceZh: $('#setVoiceZh').value,
    rate: +$('#setRate').value, repeat: +$('#setRepeat').value, pause: +$('#setPause').value, zhMode: $('#setZhMode').value,
    level: $('#setLevel').value.trim() || DEFAULTS.level, interests: $('#setInterests').value.trim(),
    autoplay: $('#setAutoplay').checked, autoSend: $('#setAutoSend').checked
  });
}
$('#setRate').oninput = e => $('#rateVal').textContent = e.target.value;
$('#btnSaveSettings').onclick = () => { S = readSettingsForm(); store.set('settings', S); toast('已儲存'); };
$('#btnTestVoice').onclick = async () => {
  const keep = S; S = readSettingsForm(); // 用表單上尚未儲存的值試聽
  try { await speak("Hey, how's it going? Let me get back to you on that."); if (S.ttsKey) await speak('這是中文語音測試。', { lang: 'zh' }); }
  finally { S = keep; }
};
$('#btnExport').onclick = () => {
  const data = { app: 'sayit', exported: new Date().toISOString(), favs: favs(), history: store.get('history', []),
    daily: store.get('daily', null), usage: store.get('usage', {}),
    settings: Object.assign({}, S, { claudeKey: '', ttsKey: '' }) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = `sayit-backup-${today()}.json`; a.click();
};
$('#btnImport').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== 'sayit') throw new Error('不是 SayIt 的備份檔');
    const cur = favs(), ids = new Set(cur.map(x => x.id));
    store.set('favs', cur.concat((d.favs || []).filter(x => !ids.has(x.id))));
    store.set('history', [...new Set(store.get('history', []).concat(d.history || []))]);
    if (d.settings) { S = Object.assign({}, S, d.settings, { claudeKey: S.claudeKey, ttsKey: S.ttsKey }); store.set('settings', S); }
    toast('匯入完成'); loadSettingsForm();
  } catch (err) { toast('匯入失敗：' + err.message, 3500); }
  e.target.value = '';
};
$('#btnClearAudio').onclick = async () => { await dbClear(); toast('語音快取已清除'); };

/* ---------- 啟動 ---------- */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
if ('speechSynthesis' in window) speechSynthesis.getVoices();
renderUsage();
showTab(S.claudeKey ? 'daily' : 'settings');
