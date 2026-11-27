/* SayIt 英語口說 — 個人用 PWA
 * 資料都存在本機瀏覽器（localStorage + IndexedDB）。
 * 外部服務：Claude API（文字）、Google Cloud TTS（語音，可選）、瀏覽器語音辨識。
 */
'use strict';
const APP_VERSION = '1.2（2026-11-25）';

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
  ttsKey: '', voiceEn: 'en-US-Chirp3-HD-Aoede', voiceZh: 'cmn-TW-Wavenet-A', rate: 1.0,
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
/** IndexedDB：audio＝語音快取，files＝情境練習上傳的檔案 */
function openDB() {
  if (idb) return Promise.resolve(idb);
  return new Promise((res, rej) => {
    const r = indexedDB.open('sayit', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    r.onsuccess = () => { idb = r.result; res(idb); };
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(st, k) {
  try { const db = await openDB(); return await new Promise(res => { const q = db.transaction(st).objectStore(st).get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch { return undefined; }
}
async function idbPut(st, k, v) {
  const db = await openDB();
  await new Promise((res, rej) => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function idbDel(st, k) {
  try { const db = await openDB(); await new Promise(res => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).delete(k); tx.oncomplete = res; tx.onerror = res; }); } catch { }
}
const dbGet = k => idbGet('audio', k);
const dbPut = (k, v) => idbPut('audio', k, v).catch(() => { });
async function dbClear() {
  const db = await openDB(); await new Promise(res => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').clear(); tx.oncomplete = res; });
}

const isZh = s => /[一-鿿]/.test(s);

/** 取得 Google TTS mp3（有快取）。lang: 'en' | 'zh'
 * 一律用正常語速合成，播放時再用 playbackRate 調速：換語速不用重新合成，也不受語音是否支援語速影響 */
async function ttsBlob(text, lang = 'en') {
  const voice = lang === 'zh' ? S.voiceZh : S.voiceEn;
  const key = `${voice}|${text}`;
  const hit = await dbGet(key);
  if (hit) return hit;
  const langCode = voice.split('-').slice(0, 2).join('-');
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(S.ttsKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { text }, voice: { languageCode: langCode, name: voice }, audioConfig: { audioEncoding: 'MP3' } })
  });
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
const setRateOn = (audio, r) => { audio.preservesPitch = true; audio.defaultPlaybackRate = r; audio.playbackRate = r; };
/** 播放一句話。slow=true 時再放慢 25% */
async function speak(text, { slow = false, lang } = {}) {
  lang = lang || (isZh(text) ? 'zh' : 'en');
  stopSpeak();
  const rate = lang === 'en' ? (slow ? Math.max(0.5, S.rate * 0.75) : S.rate) : 1.0;
  if (S.ttsKey) {
    try {
      const blob = await ttsBlob(text, lang);
      if (oneShotURL) URL.revokeObjectURL(oneShotURL);
      oneShotURL = URL.createObjectURL(blob);
      oneShot.src = oneShotURL;
      setRateOn(oneShot, rate);
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
    u.rate = rate;
    const v = speechSynthesis.getVoices().find(v => v.lang.replace('_', '-').startsWith(u.lang));
    if (v) u.voice = v;
    u.onend = r; u.onerror = r;
    speechSynthesis.speak(u);
  });
}

/* ---------- 語速（頂端按鈕、播放器、設定頁共用同一個值） ---------- */
const RATE_STEPS = [1.0, 0.9, 0.8, 0.7];
function setRate(r) {
  S.rate = Math.round(r * 100) / 100;
  store.set('settings', S);
  setRateOn(oneShot, S.rate);
  setRateOn(document.getElementById('plAudio'), S.rate);
  renderRate();
}
function renderRate() {
  $('#speedChip').textContent = `🐢 ${S.rate.toFixed(2).replace(/0$/, '')}×`;
  const sel = $('#plRate');
  if (![...sel.options].some(o => +o.value === S.rate)) sel.add(new Option(`${S.rate}×`, String(S.rate)));
  sel.value = [...sel.options].find(o => +o.value === S.rate).value;
  if ($('#setRate')) { $('#setRate').value = S.rate; $('#rateVal').textContent = S.rate; }
}
$('#speedChip').onclick = () => {
  const i = RATE_STEPS.findIndex(x => Math.abs(x - S.rate) < 0.01);
  setRate(RATE_STEPS[(i + 1) % RATE_STEPS.length]);
  toast(`英文語速 ${S.rate}×`, 1200);
};
function stopSpeak() {
  try { oneShot.pause(); } catch { }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

/* ---------- 語音辨識 ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeSession = null;
/** 開始辨識，直到使用者按「說完了」才結束。
 * 手機的辨識遇到停頓會自動結束，所以這裡在結束後自動重新開始，並把每段結果接起來。
 * 連續 4 段都沒聽到聲音（約半分鐘）才自動停止。onInterim 會收到即時結果 */
function listen(lang = 'en-US', onInterim) {
  return new Promise((resolve, reject) => {
    if (!SR) return reject(new Error('這個瀏覽器不支援語音辨識，請用 Android 版 Chrome。'));
    stopSpeak();
    if (activeSession) activeSession.stop();
    let stopped = false, failed = false, committed = '', idle = 0, rec = null;
    const session = { stop() { stopped = true; try { rec && rec.stop(); } catch { } } };
    activeSession = session;
    const join = (...xs) => xs.map(x => (x || '').trim()).filter(Boolean).join(' ');
    const startOne = () => {
      let segFinal = '', segInterim = '', heard = false;
      rec = new SR();
      rec.lang = lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
      rec.onresult = e => {
        segFinal = ''; segInterim = '';
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) segFinal += r[0].transcript; else segInterim += r[0].transcript;
        }
        heard = true;
        onInterim && onInterim(join(committed, segFinal, segInterim));
      };
      rec.onerror = e => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        failed = true; stopped = true;
        reject(new Error(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? '請允許麥克風權限。' : '語音辨識錯誤：' + e.error));
      };
      rec.onend = () => {
        // 按停止時，最後一段可能還沒定案，就用即時結果補上
        committed = join(committed, segFinal || (stopped ? segInterim : ''));
        idle = heard ? 0 : idle + 1;
        if (failed) { activeSession = null; return; }
        if (stopped || idle >= 4) { if (activeSession === session) activeSession = null; return resolve(committed); }
        setTimeout(() => { if (stopped) { activeSession = null; resolve(committed); } else startOne(); }, 80);
      };
      try { rec.start(); } catch (err) { failed = true; activeSession = null; reject(err); }
    };
    startOne();
  });
}
function stopListen() { if (activeSession) activeSession.stop(); }

/** 把錄音按鈕接上辨識：按一下開始，說完再按一下結束。onDone(text) */
function micButton(btn, lang, { idleLabel, recLabel = '⏹ 說完了（點我結束）', onInterim, onDone }) {
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('rec')) { stopListen(); return; }
    btn.classList.add('rec'); btn.textContent = recLabel;
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
const TITLES = { daily: '今日片語', express: '我想說', chat: '英文對話', scene: '情境練習', fav: '我的最愛', settings: '設定' };
let curTab = 'daily';
function showTab(name) {
  curTab = name;
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('#pageTitle').textContent = TITLES[name];
  window.scrollTo(0, 0);
  if (name === 'daily') ensureDaily();
  if (name === 'express') renderExpressView();
  if (name === 'chat') renderChatView();
  if (name === 'scene') renderSceneView();
  if (name === 'fav') renderFavs();
  if (name === 'settings') loadSettingsForm();
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- 手機返回鍵 ----------
 * 永遠在瀏覽紀錄裡多放一筆「保護用」紀錄，按返回鍵時攔下來自己處理：
 * 先關面板 → 再回清單 → 再回「今日」頁 → 都沒有了才提示「再按一次離開」。 */
let guarded = false;
function ensureGuard() { if (!guarded) { try { history.pushState({ sayit: 1 }, ''); guarded = true; } catch { } } }
document.addEventListener('click', ensureGuard, true); // 在使用者點擊時加入，瀏覽器才不會略過這筆紀錄
window.addEventListener('popstate', () => {
  guarded = false;
  if (handleBack()) ensureGuard();
  else toast('再按一次返回鍵離開 SayIt');
});
function closeSheet(sh) {
  sh.classList.add('hidden'); stopSpeak(); stopListen();
  if (sh.id === 'playerSheet') stopPlayer();
  if (sh.id === 'listSheet') pickerClosed();
}
function handleBack() {
  const open = $$('.sheet:not(.hidden)');
  if (open.length) { closeSheet(open[open.length - 1]); return true; }
  if (curTab === 'chat' && chat) { leaveChat(); return true; }
  if (curTab === 'express' && exOpen) { closeExpress(); return true; }
  if (curTab === 'scene' && sceneOpen) { closeScene(); return true; }
  if (curTab !== 'daily') { showTab('daily'); return true; }
  return false;
}

/* ---------- 共用的句子列 ---------- */
// data-say / data-shadow / data-chat 由下方的事件委派處理
function sentenceLine(en, zh, { fav = true, chat = false } = {}) {
  return `<div class="line">
    <div class="txt"><div class="en">${esc(en)}</div>${zh ? `<div class="zh">${esc(zh)}</div>` : ''}</div>
    <button class="icon-btn" data-say="${esc(en)}" title="播放">🔊</button>
    <button class="icon-btn" data-shadow="${esc(en)}" data-zh="${esc(zh || '')}" title="跟讀">🎤</button>
    ${fav ? `<button class="icon-btn" data-favline="${esc(en)}" data-zh="${esc(zh || '')}" title="加入／取消最愛">${isFav(en) ? '★' : '☆'}</button>` : ''}
    ${chat ? `<button class="icon-btn" data-chat="${esc(en)}" title="用這句聊天">💬</button>` : ''}
  </div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-say],[data-shadow],[data-favline],[data-chat],[data-close]');
  if (!b) return;
  if (b.dataset.say != null) speak(b.dataset.say);
  else if (b.dataset.shadow != null) openShadow(b.dataset.shadow, b.dataset.zh);
  else if (b.dataset.favline != null) {
    openListPicker({ title: b.dataset.favline, note: '', sentences: [{ en: b.dataset.favline, zh: b.dataset.zh }] }, b);
  }
  else if (b.dataset.chat != null) startChat(`練習使用這個說法：「${b.dataset.chat}」`, b.dataset.chat, `練習「${b.dataset.chat}」`);
  else if (b.dataset.close != null) closeSheet(b.closest('.sheet'));
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
    sentences: [{ en: p.phrase, zh: p.meaning_zh || '' }] }; // 例句各自有 ☆，可個別加入
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
      ${(p.examples || []).map(x => `<div class="ex">${sentenceLine(x.en, x.zh))}</div>`).join('')}
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
    openListPicker(phraseToFav(p), f);
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
    openListPicker({ title: `📚 ${j.key || en}`, note: `${j.title || ''}${j.note_zh ? '｜' + j.note_zh : ''}`,
      sentences: [{ en, zh: zh || '' }, ...(j.sentences || [])] }, null);
    toast('小課程做好了，選擇要放進哪個清單');
    if (btn) btn.textContent = old;
  } catch (e) { toast(e.message, 3500); if (btn) btn.textContent = old; }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- 我想說（中→英） ----------
 * 每次查詢存成一筆紀錄（localStorage 'express'），清單可點開、刪除。 */
const exRecs = () => store.get('express', []);
const saveExRecs = list => store.set('express', list.slice(0, 300));
let exOpen = null; // 目前打開的紀錄 id
const fmtTime = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

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
  $('#btnExpress').disabled = true;
  try {
    const j = await claudeJSON(systemPrompt(), `I want to say this in natural spoken English: 「${zh}」
Give the most natural way a native speaker would say it in conversation, plus 2 alternatives with different tone. Break out useful chunks to learn.
JSON: {"best":{"en":"","note_zh":"為什麼這樣說／語氣"},"alternatives":[{"en":"","style":"casual|polite|formal","zh":"這句的中文意思","note_zh":"跟最自然說法的差別"}],"chunks":[{"en":"","zh":""}],"tip_zh":"台灣人常見的錯誤說法或提醒（沒有就留空）"}`, 3000);
    const rec = { id: uid(), zh, j, chatId: null, created: Date.now() };
    saveExRecs([rec, ...exRecs()]);
    $('#zhInput').value = '';
    out.innerHTML = '';
    openExpress(rec.id);
  } catch (e) { out.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
  finally { $('#btnExpress').disabled = false; }
}
function openExpress(id) { exOpen = id; if (curTab !== 'express') showTab('express'); else renderExpressView(); window.scrollTo(0, 0); }
function closeExpress() { exOpen = null; renderExpressView(); }
function renderExpressView() {
  const rec = exOpen && exRecs().find(r => r.id === exOpen);
  if (!rec) exOpen = null;
  $('#expressInput').classList.toggle('hidden', !!rec);
  $('#expressListWrap').classList.toggle('hidden', !!rec);
  if (rec) renderExpress(rec);
  else { if (!$('#expressResult .spinner, #expressResult .err')) $('#expressResult').innerHTML = ''; renderExpressList(); }
}
function renderExpressList() {
  const list = exRecs();
  $('#expressList').innerHTML = list.length ? list.map(r => `
    <div class="card list-item" data-exid="${r.id}">
      <div class="li-main"><div class="li-title">${esc(r.zh)}</div>
      <div class="small muted">${esc(r.j?.best?.en || '')}</div></div>
      <div class="li-side"><span class="small muted">${fmtTime(r.created)}</span>
      <button class="icon-btn" data-exdel="${r.id}" title="刪除">🗑</button></div>
    </div>`).join('') : `<p class="small muted center">還沒有紀錄。上面輸入想說的話，每次的結果都會留在這裡。</p>`;
}
$('#expressList').addEventListener('click', e => {
  const del = e.target.closest('[data-exdel]');
  if (del) {
    const r = exRecs().find(x => x.id === del.dataset.exdel);
    if (r && confirm(`刪除「${r.zh}」這筆紀錄？`)) { saveExRecs(exRecs().filter(x => x.id !== r.id)); renderExpressList(); }
    return;
  }
  const it = e.target.closest('[data-exid]');
  if (it) openExpress(it.dataset.exid);
});
function renderExpress(rec) {
  const j = rec.j || {};
  const styleZh = { casual: '輕鬆', polite: '客氣', formal: '正式' };
  const hasChat = rec.chatId && chatsAll().some(c => c.id === rec.chatId);
  const best = j.best?.en || '';
  $('#expressResult').innerHTML = `
    <div class="row between"><button id="exBack" class="btn tiny ghost">← 我想說清單</button><span class="small muted">${fmtTime(rec.created)}</span></div>
    <div class="card"><span class="small muted">你想說：</span>${esc(rec.zh)}</div>
    <div class="card">
      <div class="line"><span class="txt"><span class="tag">最自然</span></span>
        <button class="icon-btn" data-favline="${esc(best)}" data-zh="${esc(rec.zh)}" title="加入／取消最愛">${isFav(best) ? '★' : '☆'}</button></div>
      <p class="big-en">${esc(best)}</p>
      <p class="small muted">${esc(j.best?.note_zh)}</p>
      <div class="row">
        <button class="btn ghost" data-say="${esc(best)}">🔊 聽</button>
        <button class="btn primary grow" data-shadow="${esc(best)}" data-zh="${esc(rec.zh)}">🎤 跟著唸</button>
      </div>
    </div>
    ${(j.alternatives || []).length ? `<div class="card"><b>其他說法</b>
      ${j.alternatives.map(a => `<div class="ex"><span class="tag">${esc(styleZh[a.style] || a.style)}</span>
        ${sentenceLine(a.en, a.zh || a.note_zh || '')}
        ${a.zh && a.note_zh ? `<div class="small muted">💬 ${esc(a.note_zh)}</div>` : ''}</div>`).join('')}</div>` : ''}
    ${(j.chunks || []).length ? `<div class="card"><b>重點片語</b><div class="chunks">
      ${j.chunks.map(c => `<span class="chunk" data-say="${esc(c.en)}">${esc(c.en)}｜${esc(c.zh)}</span>`).join('')}</div></div>` : ''}
    ${j.tip_zh ? `<div class="card small">💡 ${esc(j.tip_zh)}</div>` : ''}
    <div class="row">
      <button id="exLesson" class="btn ghost grow">📚 建立小課程</button>
      <button id="exDel" class="btn ghost">🗑 刪除</button>
    </div>
    <button id="exChat" class="btn primary full">${hasChat ? '💬 繼續這段對話' : '💬 唸完了，接著用英文聊'}</button>`;
  $('#exBack').onclick = closeExpress;
  $('#exLesson').onclick = e => makeLesson(best, rec.zh, e.target);
  $('#exDel').onclick = () => {
    if (!confirm(`刪除「${rec.zh}」這筆紀錄？`)) return;
    saveExRecs(exRecs().filter(x => x.id !== rec.id)); closeExpress();
  };
  $('#exChat').onclick = () => {
    if (hasChat) return openChat(rec.chatId);
    const id = startChat(`我剛學會怎麼說「${rec.zh}」→ "${best}"。請開啟一段會自然用到這句話的日常對話。`, best, `練習「${rec.zh}」`);
    saveExRecs(exRecs().map(x => x.id === rec.id ? { ...x, chatId: id } : x));
  };
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

/* ---------- 對話 ----------
 * 每段對話存成一筆（localStorage 'chats'）：messages 給 API 用，view 用來重畫畫面。 */
let chat = null; // 目前打開的對話 {id, label, topic, messages:[{role, content}], view:[{t:'me'|'fix'|'ai',...}], created, updated}
const chatsAll = () => store.get('chats', []);
function saveChat(c) {
  c.updated = Date.now();
  const list = chatsAll().filter(x => x.id !== c.id);
  list.unshift(c);
  store.set('chats', list.slice(0, 100));
}
const CHAT_RULES = topic => systemPrompt(`
You are now "Sam", a friendly native English speaker chatting with the learner to practice everyday spoken English.
Conversation context: ${topic || 'a casual everyday topic of your choice that fits the learner\'s life'}
Rules:
- Reply in natural spoken English, 1–3 short sentences, matched to the learner's level. Usually end with a question to keep the chat going.
- The learner's messages are often speech-recognition transcripts: ignore missing punctuation/capitalization and obvious recognition errors.
- If the learner's English has a real grammar mistake or sounds unnatural, put a more natural version in "correction". If it's fine, set "correction" to null. Don't nitpick.
- If the learner writes in Chinese (they didn't know how to say it), put the natural English for it in "correction.better", then continue the chat as if they'd said it.
- Output ONLY JSON: {"reply":"your English reply","reply_zh":"繁中翻譯","correction":null | {"better":"","note_zh":"簡短說明"}}`);

/** 開一段新對話，回傳對話 id */
function startChat(topic, seedSentence, label) {
  chat = { id: uid(), label: label || topic || '自由聊天', topic: topic || '', messages: [], view: [], created: Date.now() };
  saveChat(chat);
  showTab('chat');
  const opener = `[Start the conversation now with a natural opening line${seedSentence ? `, steering toward a situation where I would naturally say "${seedSentence}"` : ''}. Return the JSON.]`;
  chatSend(opener, { hidden: true });
  return chat.id;
}
function openChat(id) {
  const c = chatsAll().find(x => x.id === id);
  if (!c) return toast('這段對話已經刪除了');
  chat = c; showTab('chat');
}
function leaveChat() { stopSpeak(); stopListen(); chat = null; renderChatView(); }
function renderChatView() {
  const open = !!chat;
  $('#chatStart').classList.toggle('hidden', open);
  $('#chatListWrap').classList.toggle('hidden', open);
  $('#chatBox').classList.toggle('hidden', !open);
  if (!open) return renderChatList();
  $('#chatTopicLabel').textContent = chat.label;
  ensureComposer();
  const log = $('#chatLog'); log.innerHTML = '';
  chat.view.forEach(v => log.appendChild(viewEl(v)));
  if (chat.pending) { const w = document.createElement('div'); w.className = 'wait'; w.innerHTML = spinner('Sam 正在回覆…'); log.appendChild(w); }
  setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
}
function renderChatList() {
  const list = chatsAll();
  $('#chatList').innerHTML = list.length ? list.map(c => {
    const lastAi = [...c.view].reverse().find(v => v.t === 'ai');
    const turns = c.view.filter(v => v.t === 'me').length;
    return `<div class="card list-item" data-chatid="${c.id}">
      <div class="li-main"><div class="li-title">${esc(c.label)}</div>
      <div class="small muted">${esc(lastAi?.reply || '')}</div></div>
      <div class="li-side"><span class="small muted">${fmtTime(c.updated || c.created)}・${turns} 句</span>
      <button class="icon-btn" data-chatdel="${c.id}" title="刪除">🗑</button></div></div>`;
  }).join('') : `<p class="small muted center">還沒有對話紀錄。</p>`;
}
$('#chatList').addEventListener('click', e => {
  const del = e.target.closest('[data-chatdel]');
  if (del) {
    const c = chatsAll().find(x => x.id === del.dataset.chatdel);
    if (c && confirm(`刪除「${c.label}」這段對話？`)) { store.set('chats', chatsAll().filter(x => x.id !== c.id)); renderChatList(); }
    return;
  }
  const it = e.target.closest('[data-chatid]');
  if (it) openChat(it.dataset.chatid);
});
function viewEl(v) {
  const el = document.createElement('div');
  if (v.t === 'me') { el.className = 'bubble me'; el.textContent = v.text; }
  else if (v.t === 'fix') { el.className = 'fix'; el.innerHTML = `<b>更自然的說法</b>${sentenceLine(v.better, v.note)}`; }
  else {
    el.className = 'bubble ai';
    el.innerHTML = `<div class="en">${esc(v.reply)}</div><div class="zh hidden">${esc(v.zh)}</div>
      <div class="tools"><button class="icon-btn" data-say="${esc(v.reply)}">🔊</button>
      <button class="icon-btn" data-showzh>中</button>
      <button class="icon-btn" data-shadow="${esc(v.reply)}" data-zh="${esc(v.zh)}">🎤</button>
      <button class="icon-btn" data-favline="${esc(v.reply)}" data-zh="${esc(v.zh)}">${isFav(v.reply) ? '★' : '☆'}</button></div>`;
    el.querySelector('[data-showzh]').onclick = () => el.querySelector('.zh').classList.toggle('hidden');
  }
  return el;
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
    idleLabel: '🎤 用英文回答', recLabel: '⏹ 說完了，點我送出',
    onInterim: t => { $('#cText').value = t; },
    onDone: t => { $('#cText').value = t; if (S.autoSend) sendTyped(); }
  });
  micButton($('#cHelp'), 'zh-TW', {
    idleLabel: '🀄 中文求救', recLabel: '⏹ 說完了',
    onInterim: t => { $('#cText').value = t; },
    onDone: t => { $('#cText').value = t; if (S.autoSend) sendTyped(); }
  });
  $('#cSend').onclick = sendTyped;
  $('#cText').addEventListener('keydown', e => { if (e.key === 'Enter') sendTyped(); });
}
function sendTyped() {
  const t = $('#cText').value.trim(); if (!t || !chat || chat.pending) return;
  $('#cText').value = ''; chatSend(t);
}
async function chatSend(text, { hidden = false } = {}) {
  const c = chat; // 回覆回來時，就算已經切到別的畫面，也存回這段對話
  const visible = () => chat === c && curTab === 'chat';
  const log = $('#chatLog');
  if (!hidden) { const v = { t: 'me', text }; c.view.push(v); log.appendChild(viewEl(v)); }
  c.messages.push({ role: 'user', content: text });
  c.pending = true; saveChat(c);
  const wait = document.createElement('div'); wait.className = 'wait'; wait.innerHTML = spinner('Sam 正在回覆…'); log.appendChild(wait);
  wait.scrollIntoView({ behavior: 'smooth', block: 'end' });
  try {
    const raw = await claude(CHAT_RULES(c.topic), c.messages.slice(-30), 2000);
    let j; try { j = parseJSON(raw); } catch { j = { reply: raw, reply_zh: '', correction: null }; }
    c.messages.push({ role: 'assistant', content: JSON.stringify(j) });
    const add = [];
    if (j.correction && j.correction.better && !hidden) add.push({ t: 'fix', better: j.correction.better, note: j.correction.note_zh || '' });
    add.push({ t: 'ai', reply: j.reply, zh: j.reply_zh || '' });
    c.view.push(...add);
    delete c.pending; saveChat(c);
    if (!visible()) return;
    $$('#chatLog .wait').forEach(w => w.remove());
    add.forEach(v => log.appendChild(viewEl(v)));
    log.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end' });
    if (S.autoplay) speak(j.reply);
  } catch (e) {
    // 失敗：把這句撤回，文字放回輸入框方便重送
    c.messages.pop();
    if (!hidden) c.view.pop();
    delete c.pending; saveChat(c);
    if (!visible()) return;
    renderChatView();
    if (!hidden && $('#cText')) $('#cText').value = text;
    const err = document.createElement('div'); err.className = 'card err'; err.textContent = e.message;
    $('#chatLog').appendChild(err);
    if (hidden) { // 開場白失敗：給一個重試按鈕
      const b = document.createElement('button'); b.className = 'btn ghost full'; b.textContent = '重試';
      b.onclick = () => { err.remove(); b.remove(); chatSend(text, { hidden: true }); };
      $('#chatLog').appendChild(b);
    }
  }
}
$('#btnStartChat').onclick = () => { startChat($('#chatTopic').value.trim()); $('#chatTopic').value = ''; };
$('#btnChatBack').onclick = leaveChat;

/* ---------- 情境練習（簡報、會議…） ----------
 * scenes（localStorage）：[{id, name, role, files:[{id,name,kind,size}], items:[...], created, updated}]
 * 檔案內容存在 IndexedDB 'files'：PDF 存 base64（直接交給 Claude 讀，掃描檔也可以），
 * Word / PowerPoint 在手機上先解壓縮取出文字（含投影片備忘稿）。 */
const scenes = () => store.get('scenes', []);
const saveScenes = l => store.set('scenes', l);
const getScene = id => scenes().find(x => x.id === id);
function putScene(sc) { sc.updated = Date.now(); saveScenes(scenes().map(x => x.id === sc.id ? sc : x)); }
let sceneOpen = null, scCat = 'speech', scFilter = 'all';
const SCENE_CATS = {
  speech: { label: '上台句', icon: '🎤', hint: '依你的資料，寫成上台可以直接講的句子' },
  terms: { label: '名詞重點', icon: '📖', hint: '專有名詞、方法、重要結果，用一兩句英文講清楚' },
  qa: { label: '預測問答', icon: '❓', hint: '聽眾可能問的問題，加上有深度的回答' },
  phrases: { label: '開場轉場', icon: '🔀', hint: '開場、換段、帶圖、結尾、聽不懂問題時的說法' }
};

/* --- 讀檔 --- */
async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let e = buf.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error(`「${file.name}」不是有效的 Office 檔案`);
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const entries = {}, dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    entries[dec.decode(buf.subarray(p + 46, p + 46 + nlen))] = { method, csize, off };
    p += 46 + nlen + xlen + clen;
  }
  const text = async name => {
    const en = entries[name]; if (!en) return null;
    const start = en.off + 30 + dv.getUint16(en.off + 26, true) + dv.getUint16(en.off + 28, true);
    const data = buf.subarray(start, start + en.csize);
    if (en.method === 0) return dec.decode(data);
    return await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  };
  return { names: Object.keys(entries), text };
}
const xmlDoc = s => new DOMParser().parseFromString(s, 'application/xml');
/** 取出 XML 裡每個段落（tag 為 w:p 或 a:p）的文字 */
function xmlParas(xml, pTag, tTag) {
  const d = xmlDoc(xml);
  return [...d.getElementsByTagName(pTag)].map(p => [...p.getElementsByTagName(tTag)].map(t => t.textContent).join('')).filter(t => t.trim());
}
async function docxText(file) {
  const z = await readZip(file);
  const xml = await z.text('word/document.xml');
  if (!xml) throw new Error(`「${file.name}」讀不到內容`);
  return xmlParas(xml, 'w:p', 'w:t').join('\n');
}
async function pptxText(file) {
  const z = await readZip(file);
  const slides = z.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    const body = xmlParas(await z.text(slides[i]), 'a:p', 'a:t').join('\n');
    let notes = '';
    const rels = await z.text(slides[i].replace('slides/', 'slides/_rels/') + '.rels');
    const m = rels && rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/);
    if (m) {
      const nx = await z.text('ppt/notesSlides/' + m[1]);
      if (nx) notes = xmlParas(nx, 'a:p', 'a:t').filter(t => !/^\d+$/.test(t.trim())).join('\n');
    }
    out.push(`--- Slide ${i + 1} ---\n${body}${notes ? `\n[Speaker notes]\n${notes}` : ''}`);
  }
  if (!out.length) throw new Error(`「${file.name}」讀不到投影片`);
  return out.join('\n\n');
}
const fileToB64 = file => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(file);
});
/** 讀一個檔案、存進 IndexedDB，回傳簡短資訊 */
async function ingestFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let kind, data;
  if (ext === 'pdf') {
    if (file.size > 25e6) throw new Error(`「${file.name}」超過 25 MB，請先壓縮或只留需要的頁面`);
    kind = 'pdf'; data = await fileToB64(file);
  } else if (ext === 'docx') { kind = 'text'; data = await docxText(file); }
  else if (ext === 'pptx') { kind = 'text'; data = await pptxText(file); }
  else if (ext === 'txt' || ext === 'md') { kind = 'text'; data = await file.text(); }
  else if (ext === 'doc' || ext === 'ppt') throw new Error(`「${file.name}」是舊版格式，請在電腦上另存成 .${ext}x 再上傳`);
  else throw new Error(`「${file.name}」不支援，請用 PDF、.docx、.pptx 或 .txt`);
  if (kind === 'text') data = data.slice(0, 200000);
  const id = uid();
  await idbPut('files', id, { name: file.name, kind, data });
  return { id, name: file.name, kind, size: kind === 'pdf' ? file.size : data.length };
}
async function ingestFiles(fileList, statusEl) {
  const metas = [], errs = [];
  const arr = [...fileList];
  for (let i = 0; i < arr.length; i++) {
    if (statusEl) statusEl.innerHTML = spinner(`讀取檔案 ${i + 1} / ${arr.length}：${arr[i].name}`);
    try { metas.push(await ingestFile(arr[i])); } catch (e) { errs.push(e.message); }
  }
  if (statusEl) statusEl.innerHTML = errs.length ? `<p class="err small">${esc(errs.join('\n'))}</p>` : '';
  if (errs.length) toast(errs.join('；'), 5000);
  return metas;
}

/* --- 情境清單 --- */
function renderSceneView() {
  const sc = sceneOpen && getScene(sceneOpen);
  if (!sc) sceneOpen = null;
  $('#sceneListView').classList.toggle('hidden', !!sc);
  $('#sceneDetail').classList.toggle('hidden', !sc);
  if (sc) renderSceneDetail(sc); else renderSceneList();
}
function renderSceneList() {
  const l = scenes();
  $('#sceneList').innerHTML = l.length ? l.map(sc => `
    <div class="card list-item" data-scid="${sc.id}">
      <div class="li-main"><div class="li-title">${esc(sc.name)}</div>
      <div class="small muted">${esc(sc.role || '')}</div>
      <div class="small muted">📎 ${sc.files.length} 個檔案・${sc.items.length} 則內容</div></div>
      <div class="li-side"><span class="small muted">${fmtTime(sc.updated || sc.created)}</span>
      <button class="icon-btn" data-scdel="${sc.id}" title="刪除">🗑</button></div>
    </div>`).join('') : `<p class="small muted center">還沒有情境。上面填好身分、上傳講稿或投影片，就能產生專屬的英文句子。</p>`;
}
$('#sceneList').addEventListener('click', async e => {
  const del = e.target.closest('[data-scdel]');
  if (del) {
    const sc = getScene(del.dataset.scdel);
    if (sc && confirm(`刪除情境「${sc.name}」和裡面的 ${sc.items.length} 則內容？（已加入清單的句子會保留）`)) {
      for (const f of sc.files) await idbDel('files', f.id);
      saveScenes(scenes().filter(x => x.id !== sc.id)); renderSceneList();
    }
    return;
  }
  const it = e.target.closest('[data-scid]');
  if (it) openScene(it.dataset.scid);
});
$('#btnNewScene').onclick = async () => {
  const files = $('#scFiles').files;
  const role = $('#scRole').value.trim();
  let name = $('#scName').value.trim() || (files[0] ? files[0].name.replace(/\.[^.]+$/, '') : '');
  if (!name) return toast('請輸入情境名稱');
  if (!role && !files.length) return toast('請描述你的身分與情境，或上傳資料');
  const btn = $('#btnNewScene'); btn.disabled = true;
  try {
    const metas = await ingestFiles(files, $('#scNewStatus'));
    const sc = { id: uid(), name, role, files: metas, items: [], created: Date.now(), updated: Date.now() };
    saveScenes([sc, ...scenes()]);
    $('#scName').value = ''; $('#scRole').value = ''; $('#scFiles').value = '';
    openScene(sc.id);
  } finally { btn.disabled = false; }
};
function openScene(id) { sceneOpen = id; scFilter = 'all'; if (curTab !== 'scene') showTab('scene'); else renderSceneView(); window.scrollTo(0, 0); }
function closeScene() { sceneOpen = null; renderSceneView(); }

/* --- 情境內容 --- */
function sceneItemPayload(it) {
  if (it.cat === 'qa') return { title: it.q, note: '預測問答', sentences: [{ en: it.q, zh: it.q_zh || '' }, { en: it.a, zh: it.a_zh || '' }] };
  if (it.cat === 'terms') return { title: it.en, note: it.term || '', sentences: [{ en: it.en, zh: it.zh || '' }] };
  return { title: it.en, note: it.note_zh || '', sentences: [{ en: it.en, zh: it.zh || '' }] };
}
function sceneItemHTML(it) {
  const c = SCENE_CATS[it.cat] || {};
  const head = `<div class="row between sc-head"><span><span class="tag">${c.icon || ''} ${esc(c.label || it.cat)}</span>${it.term ? `<b>${esc(it.term)}</b>` : ''}</span>
    <span><button class="icon-btn" data-sfav="${it.id}" title="加入清單">${isFav(sceneItemPayload(it).title) ? '★' : '☆'}</button>
    <button class="icon-btn" data-sdel="${it.id}" title="刪除">🗑</button></span></div>`;
  const body = it.cat === 'qa'
    ? `<div class="qa-label">Q</div>${sentenceLine(it.q, it.q_zh, { fav: false })}<div class="qa-label a">A</div>${sentenceLine(it.a, it.a_zh, { fav: false })}`
    : sentenceLine(it.en, it.zh, { fav: false });
  return `<div class="card sc-item" data-sitem="${it.id}">${head}${body}${it.note_zh ? `<div class="small muted">📍 ${esc(it.note_zh)}</div>` : ''}</div>`;
}
function filteredItems(sc) { return scFilter === 'all' ? sc.items : sc.items.filter(i => i.cat === scFilter); }
function renderSceneDetail(sc) {
  const cnt = k => sc.items.filter(i => i.cat === k).length;
  const items = filteredItems(sc);
  $('#sceneDetail').innerHTML = `
    <div class="row between"><button id="scBack" class="btn tiny ghost">← 情境清單</button><button id="scEdit" class="btn tiny ghost">✏️ 編輯名稱與描述</button></div>
    <div class="card">
      <h3>${esc(sc.name)}</h3>
      <p class="small muted" style="white-space:pre-wrap">${esc(sc.role || '（沒有描述）')}</p>
      <div class="files">${sc.files.map(f => `<span class="chunk">${f.kind === 'pdf' ? '📕' : '📄'} ${esc(f.name)} <button class="icon-btn tiny-x" data-fdel="${f.id}">✕</button></span>`).join('') || '<span class="small muted">沒有上傳資料</span>'}</div>
      <label class="btn tiny ghost" style="margin-top:8px">＋ 加入檔案<input id="scMoreFiles" type="file" multiple accept=".pdf,.docx,.pptx,.txt,.md" class="hidden"></label>
      <div id="scFileStatus"></div>
    </div>
    <div class="card">
      <b>產生內容</b>
      <div class="cat-pick">${Object.entries(SCENE_CATS).map(([k, c]) => `<button class="lchip ${k === scCat ? 'on' : ''}" data-scat="${k}">${c.icon} ${c.label}</button>`).join('')}</div>
      <p class="small muted">${esc(SCENE_CATS[scCat].hint)}</p>
      <input id="scFocus" type="text" placeholder="聚焦在…（可留白，例如：研究方法、第 5 張投影片、研究限制）">
      <div class="row"><select id="scN" class="inline-select"><option>5</option><option selected>10</option><option>15</option></select>
        <button id="scGen" class="btn primary grow">✨ 產生</button></div>
      <div id="scGenStatus"></div>
    </div>
    <div class="list-chips">${[['all', '全部', sc.items.length], ...Object.entries(SCENE_CATS).map(([k, c]) => [k, c.label, cnt(k)])]
      .map(([k, l, n]) => `<button class="lchip ${k === scFilter ? 'on' : ''}" data-sfilter="${k}">${l} <span>${n}</span></button>`).join('')}</div>
    ${items.length ? `<button id="scBatch" class="btn ghost full">☆ 把這 ${items.length} 則全部加入清單…</button>` : ''}
    <div id="scItems">${items.map(sceneItemHTML).join('') || `<p class="small muted center">還沒有內容，選一個類型按「產生」。</p>`}</div>`;
  $('#scBack').onclick = closeScene;
  $('#scEdit').onclick = () => {
    const name = prompt('情境名稱', sc.name); if (name == null) return;
    const role = prompt('你的身分與情境', sc.role || ''); if (role == null) return;
    sc.name = name.trim() || sc.name; sc.role = role.trim(); putScene(sc); renderSceneDetail(sc);
  };
  $('#scMoreFiles').onchange = async e => {
    const metas = await ingestFiles(e.target.files, $('#scFileStatus'));
    const cur = getScene(sc.id); cur.files.push(...metas); putScene(cur); renderSceneDetail(cur);
  };
  $('#scGen').onclick = () => generateScene(sc.id);
  $('#scBatch') && ($('#scBatch').onclick = () => openListPicker(filteredItems(getScene(sc.id)).map(sceneItemPayload), null, { batch: true }));
}
$('#sceneDetail').addEventListener('click', async e => {
  const sc = sceneOpen && getScene(sceneOpen); if (!sc) return;
  const t = e.target;
  if (t.closest('[data-scat]')) { scCat = t.closest('[data-scat]').dataset.scat; return renderSceneDetail(sc); }
  if (t.closest('[data-sfilter]')) { scFilter = t.closest('[data-sfilter]').dataset.sfilter; return renderSceneDetail(sc); }
  const fd = t.closest('[data-fdel]');
  if (fd) {
    const f = sc.files.find(x => x.id === fd.dataset.fdel);
    if (f && confirm(`移除檔案「${f.name}」？`)) { await idbDel('files', f.id); sc.files = sc.files.filter(x => x.id !== f.id); putScene(sc); renderSceneDetail(sc); }
    return;
  }
  const sf = t.closest('[data-sfav]');
  if (sf) { const it = sc.items.find(x => x.id === sf.dataset.sfav); if (it) openListPicker(sceneItemPayload(it), sf); return; }
  const sd = t.closest('[data-sdel]');
  if (sd) { sc.items = sc.items.filter(x => x.id !== sd.dataset.sdel); putScene(sc); sd.closest('.sc-item').remove(); }
});

async function sceneBlocks(sc) {
  const blocks = [];
  for (const f of sc.files) {
    const d = await idbGet('files', f.id); if (!d) continue;
    blocks.push(d.kind === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.data }, title: f.name }
      : { type: 'document', source: { type: 'text', media_type: 'text/plain', data: d.data }, title: f.name });
  }
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }; // 同一份資料連續生成時比較省
  return blocks;
}
function scenePrompt(cat, n, focus, existing) {
  const ask = {
    speech: `Write ${n} sentences I can say on stage when presenting this material, following the flow of the talk (background, aims, methods, results, implications). Each under 30 words, easy to say out loud.
JSON: {"items":[{"en":"","zh":"繁中翻譯","note_zh":"用在哪一段，例如：研究動機、第 5 張投影片"}]}`,
    terms: `Pick ${n} key terms, methods, or key findings from the material that I may need to explain, and give a 1–2 sentence plain-English explanation I could say out loud (for example while answering a question).
JSON: {"items":[{"term":"the term or key point","en":"spoken explanation","zh":"繁中翻譯"}]}`,
    qa: `Predict ${n} questions the audience or reviewers are likely to ask after this talk (clarification, methods, data, limitations, implications, comparisons, future work, and a couple of tricky ones). For each, write a thoughtful answer I can say: 2–4 sentences, under 70 words, grounded in the material, honest about limitations, showing depth.
JSON: {"items":[{"q":"","q_zh":"","a":"","a_zh":""}]}`,
    phrases: `Write ${n} useful phrases for running this talk smoothly, tailored to its content: opening and self-introduction, transitions between sections and slides, pointing at figures, wrapping up, inviting questions, buying time, and handling a question I didn't catch or can't fully answer.
JSON: {"items":[{"en":"","zh":"繁中翻譯","note_zh":"使用時機"}]}`
  }[cat];
  return `${ask}
${focus ? `Focus this batch on: ${focus}\n` : ''}${existing.length ? `Do not repeat or closely paraphrase these I already have: ${JSON.stringify(existing.slice(-80))}\n` : ''}Return ONLY the JSON.`;
}
async function generateScene(id) {
  const sc = getScene(id); if (!sc) return;
  const cat = scCat, n = +$('#scN').value || 10, focus = $('#scFocus').value.trim();
  const st = $('#scGenStatus'), btn = $('#scGen');
  btn.disabled = true; st.innerHTML = spinner(`正在產生 ${n} 則「${SCENE_CATS[cat].label}」…（有 PDF 時會比較久）`);
  try {
    const sys = systemPrompt(`The learner is preparing to speak English in this situation (described in Chinese): ${sc.role || '(no description)'}
The attached documents are the learner's own materials (slides, script, paper, Q&A notes). Ground every fact in them; never invent numbers, results or claims that are not in the materials. If the materials don't cover something, keep it general.
Write English the learner can actually say out loud: clear, natural spoken academic/professional English, not written-paper style.`);
    const existing = sc.items.filter(i => i.cat === cat).map(i => i.en || i.q);
    const content = [...await sceneBlocks(sc), { type: 'text', text: scenePrompt(cat, n, focus, existing) }];
    const txt = await claude(sys, [{ role: 'user', content }], cat === 'qa' ? 10000 : 6000);
    const j = parseJSON(txt);
    const now = Date.now();
    const add = (j.items || []).filter(x => x && (x.en || (x.q && x.a))).map((x, k) => ({ ...x, id: uid() + k, cat, created: now }));
    if (!add.length) throw new Error('沒有產生內容，請再試一次');
    const cur = getScene(id); cur.items = [...add, ...cur.items]; putScene(cur);
    scFilter = cat;
    if (sceneOpen === id && curTab === 'scene') { renderSceneDetail(cur); toast(`新增 ${add.length} 則`); }
  } catch (e) {
    if (sceneOpen === id && curTab === 'scene') { const s2 = $('#scGenStatus'); if (s2) s2.innerHTML = `<p class="err small">${esc(e.message)}</p>`; }
  } finally { const b = $('#scGen'); if (b) b.disabled = false; }
}

/* ---------- 最愛與自訂清單 ----------
 * lists：[{id, name}]；favs 每筆有 listId。同一句可以放在多個清單裡（每個清單各一筆）。 */
const DEFAULT_LIST = { id: 'default', name: '我的最愛' };
function lists() {
  let l = store.get('lists', null);
  if (!l || !l.length) { l = [DEFAULT_LIST]; store.set('lists', l); }
  return l;
}
function favs() {
  const l = store.get('favs', []);
  if (l.some(f => !f.listId)) { l.forEach(f => { if (!f.listId) f.listId = 'default'; }); store.set('favs', l); } // 舊資料搬到預設清單
  return l;
}
const isFav = title => favs().some(f => f.title === title);
const inList = (title, listId) => favs().some(f => f.title === title && f.listId === listId);
let favCur = store.get('favCur', 'default');
const listName = id => (lists().find(l => l.id === id) || {}).name || '';
function newList(name) {
  name = (name || '').trim(); if (!name) return null;
  const ex = lists().find(l => l.name === name); if (ex) return ex.id;
  const l = { id: uid(), name };
  store.set('lists', [...lists(), l]);
  return l.id;
}
function addToList(item, listId) {
  const list = favs();
  if (list.some(f => f.title === item.title && f.listId === listId)) return false;
  list.unshift({ id: uid(), created: Date.now(), selected: true, ...item, listId });
  store.set('favs', list); return true;
}
function removeFromList(title, listId) { store.set('favs', favs().filter(f => !(f.title === title && f.listId === listId))); }

/* 清單選擇器：
 * openListPicker(item, btn)：單句，每個清單一個勾選框，勾＝加入、取消＝移除
 * openListPicker(items, null, {batch:true})：一批句子，點清單名稱就全部加入 */
let picker = null;
function openListPicker(payload, btn, { batch = false } = {}) {
  picker = { payload, btn, batch };
  $('#lsTitle').textContent = batch ? `把 ${payload.length} 項加入清單` : '加入清單';
  $('#lsText').textContent = batch ? '點選要加入的清單' : payload.title;
  renderPicker();
  $('#listSheet').classList.remove('hidden');
}
function renderPicker() {
  const { payload, batch } = picker;
  $('#lsLists').innerHTML = lists().map(l => {
    const n = favs().filter(f => f.listId === l.id).length;
    return batch
      ? `<button class="btn ghost full ls-row" data-lsbatch="${l.id}">📂 ${esc(l.name)} <span class="small muted">（${n}）</span></button>`
      : `<label class="ls-row card"><input type="checkbox" data-lsid="${l.id}" ${inList(payload.title, l.id) ? 'checked' : ''}> ${esc(l.name)} <span class="small muted">（${n}）</span></label>`;
  }).join('');
}
$('#lsLists').addEventListener('change', e => {
  const cb = e.target.closest('[data-lsid]'); if (!cb) return;
  const id = cb.dataset.lsid;
  if (cb.checked) { addToList(picker.payload, id); toast(`已加入「${listName(id)}」`, 1200); }
  else { removeFromList(picker.payload.title, id); toast(`已從「${listName(id)}」移除`, 1200); }
});
$('#lsLists').addEventListener('click', e => {
  const b = e.target.closest('[data-lsbatch]'); if (!b) return;
  const id = b.dataset.lsbatch;
  const n = picker.payload.filter(it => addToList(it, id)).length;
  toast(`已加入「${listName(id)}」${n} 項` + (n < picker.payload.length ? `（${picker.payload.length - n} 項原本就在）` : ''));
  closeSheet($('#listSheet'));
});
$('#lsAdd').onclick = () => {
  const id = newList($('#lsNew').value);
  if (!id) return toast('請輸入清單名稱');
  $('#lsNew').value = '';
  if (!picker.batch) { addToList(picker.payload, id); toast(`已建立並加入「${listName(id)}」`); }
  renderPicker();
};
function pickerClosed() {
  if (!picker) return;
  const { btn, payload, batch } = picker; picker = null;
  if (btn && !batch) btn.textContent = isFav(payload.title) ? '★' : '☆';
  if (curTab === 'fav') renderFavs();
}

/* 最愛頁 */
function curListItems() { return favs().filter(f => f.listId === favCur); }
function renderFavs() {
  if (!lists().some(l => l.id === favCur)) favCur = 'default';
  $('#listChips').innerHTML = lists().map(l =>
    `<button class="lchip ${l.id === favCur ? 'on' : ''}" data-lchip="${l.id}">${esc(l.name)} <span>${favs().filter(f => f.listId === l.id).length}</span></button>`).join('')
    + `<button class="lchip add" data-lnew>＋ 新清單</button>`;
  $('#btnDelList').classList.toggle('hidden', favCur === 'default');
  const list = curListItems();
  renderFavCount();
  $('#favSelectAll').checked = list.length > 0 && list.every(f => f.selected);
  const others = lists().filter(l => l.id !== favCur);
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
        <div class="row">
          ${others.length ? `<select class="inline-select" data-move><option value="">移到…</option>${others.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>` : ''}
          <button class="btn tiny ghost" data-lessonfav>📚 擴充成小課程</button>
          <button class="btn tiny ghost" data-del>🗑 刪除</button></div>
      </div>
    </div>`).join('') : `<div class="card muted">這個清單還是空的。在今日片語、我想說、對話、情境練習中按 ☆，就可以選擇加到這個清單。</div>`;
}
$('#listChips').addEventListener('click', e => {
  const c = e.target.closest('[data-lchip]');
  if (c) { favCur = c.dataset.lchip; store.set('favCur', favCur); return renderFavs(); }
  if (e.target.closest('[data-lnew]')) {
    const id = newList(prompt('新清單名稱（例如：AFAS 簡報、ICCAT 會議）') || '');
    if (id) { favCur = id; store.set('favCur', id); renderFavs(); }
  }
});
$('#btnRenameList').onclick = () => {
  const name = (prompt('清單新名稱', listName(favCur)) || '').trim(); if (!name) return;
  store.set('lists', lists().map(l => l.id === favCur ? { ...l, name } : l)); renderFavs();
};
$('#btnDelList').onclick = () => {
  if (favCur === 'default') return;
  const n = curListItems().length;
  if (!confirm(`刪除清單「${listName(favCur)}」${n ? `和裡面的 ${n} 項` : ''}？`)) return;
  store.set('favs', favs().filter(f => f.listId !== favCur));
  store.set('lists', lists().filter(l => l.id !== favCur));
  favCur = 'default'; store.set('favCur', favCur); renderFavs();
};
$('#favList').addEventListener('click', e => {
  const card = e.target.closest('[data-id]'); if (!card) return;
  const id = card.dataset.id, list = favs(), f = list.find(x => x.id === id);
  if (e.target.closest('[data-toggle]')) card.querySelector('.fav-body').classList.toggle('hidden');
  else if (e.target.closest('[data-sel]')) { f.selected = e.target.checked; store.set('favs', list); renderFavCount(); }
  else if (e.target.closest('[data-del]')) { if (confirm('刪除「' + f.title + '」？')) { store.set('favs', list.filter(x => x.id !== id)); renderFavs(); } }
  else if (e.target.closest('[data-lessonfav]')) makeLesson(f.sentences[0].en, f.sentences[0].zh, e.target);
});
$('#favList').addEventListener('change', e => {
  const sel = e.target.closest('[data-move]'); if (!sel || !sel.value) return;
  const id = sel.closest('[data-id]').dataset.id, list = favs(), f = list.find(x => x.id === id);
  if (list.some(x => x.title === f.title && x.listId === sel.value)) store.set('favs', list.filter(x => x.id !== id));
  else { f.listId = sel.value; store.set('favs', list); }
  toast(`已移到「${listName(sel.value)}」`); renderFavs();
});
function renderFavCount() {
  const list = curListItems(), sel = list.filter(f => f.selected);
  $('#favCount').textContent = `共 ${list.length} 項，已選 ${sel.length} 項（${sel.reduce((a, f) => a + f.sentences.length, 0)} 句）`;
}
$('#favSelectAll').onchange = e => {
  const l = favs(); l.forEach(f => { if (f.listId === favCur) f.selected = e.target.checked; }); store.set('favs', l); renderFavs();
};

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
  let items = curListItems().filter(f => f.selected);
  let sents = items.flatMap(f => f.sentences.filter(s => s.en));
  if (!sents.length) return toast('請先在這個清單裡勾選要聽的項目');
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
    setRateOn(plAudio, S.rate);
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
plAudio.addEventListener('play', () => setRateOn(plAudio, S.rate));
$('#plRate').onchange = e => setRate(+e.target.value);
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
  $('#appVersion').textContent = APP_VERSION;
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
$('#btnSaveSettings').onclick = () => { S = readSettingsForm(); store.set('settings', S); renderRate(); toast('已儲存'); };
$('#btnTestVoice').onclick = async () => {
  const keep = S; S = readSettingsForm(); // 用表單上尚未儲存的值試聽
  try { await speak("Hey, how's it going? Let me get back to you on that."); if (S.ttsKey) await speak('這是中文語音測試。', { lang: 'zh' }); }
  finally { S = keep; }
};
$('#btnExport').onclick = () => {
  const data = { app: 'sayit', version: APP_VERSION, exported: new Date().toISOString(), favs: favs(), history: store.get('history', []),
    express: exRecs(), chats: chatsAll(), lists: lists(), scenes: scenes(),
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
    const mergeById = (cur, inc) => { const ids = new Set(cur.map(x => x.id)); return cur.concat((inc || []).filter(x => !ids.has(x.id))); };
    saveExRecs(mergeById(exRecs(), d.express));
    store.set('chats', mergeById(chatsAll(), d.chats));
    store.set('lists', mergeById(lists(), d.lists));
    saveScenes(mergeById(scenes(), d.scenes));
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
renderRate();
showTab(S.claudeKey ? 'daily' : 'settings');
