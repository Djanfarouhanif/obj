// =========================================================================
// CONFIG
// =========================================================================
const API = '/api';

// Base de mots (words.json) : lemmes francais issus de Lexique 3.83.
// Format compact : { w: [mots], t: [bitmask], s: [nb syllabes] }
// bitmask : 1 = nom, 2 = verbe, 4 = adjectif, 8 = adverbe, 16 = mot courant
let WORDS = null;
const T_NOM = 1, T_VER = 2, T_ADJ = 4, T_ADV = 8, T_COURANT = 16;

// =========================================================================
// ETAT & API
// =========================================================================
let state = { version: 2, startDate: todayISO(), completions: [], progress: {}, phrases: [], ideas: [], twisters: {} };
let currentTab = 'words';

function todayISO() { return fmt(new Date()); }
function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// --- Couche reseau bas niveau : distingue "hors-ligne" (fetch echoue) de "erreur serveur" ---
async function apiFetch(path, opts) {
  let r;
  try { r = await fetch(API + path, opts); }
  catch (e) { const err = new Error('offline'); err.offline = true; throw err; }
  if (!r.ok) { const err = new Error('http ' + r.status); err.status = r.status; throw err; }
  return r.json().catch(() => ({}));
}

function apiGet() { return apiFetch('/data'); }
function apiReset() {
  // Efface tout : phrases et idees comprises.
  return apiFetch('/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 2, startDate: todayISO(), completions: [], progress: {}, phrases: [], ideas: [], twisters: {} })
  });
}

// --- Phrases / citations (lecture) ---
function apiAddPhrase(id, text) {
  return apiFetch('/phrases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) });
}
function apiReadPhrase(id, date) {
  return apiFetch('/phrases/' + encodeURIComponent(id) + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) });
}
function apiDeletePhrase(id) { return apiFetch('/phrases/' + encodeURIComponent(id), { method: 'DELETE' }); }

// --- Virelangue du jour ---
function apiReadTwister(date) {
  return apiFetch('/twisters/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) });
}

// --- Idees / notes ---
function apiAddIdea(id, text, createdAt) {
  return apiFetch('/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text, createdAt }) });
}
function apiSetIdea(id, pct) {
  return apiFetch('/ideas/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct }) });
}
function apiDeleteIdea(id) { return apiFetch('/ideas/' + encodeURIComponent(id), { method: 'DELETE' }); }

// =========================================================================
// PERSISTANCE LOCALE & SYNCHRONISATION (offline-first)
// =========================================================================
const LS_STATE = 'cdp.state';
const LS_QUEUE = 'cdp.queue';
const LS_WORDOPTS = 'cdp.wordopts';

let queue = [];
let flushing = false;

function saveLocalState() { try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch (e) {} }
function loadLocalState() { try { const s = localStorage.getItem(LS_STATE); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function loadQueue() { try { const q = localStorage.getItem(LS_QUEUE); queue = q ? JSON.parse(q) : []; } catch (e) { queue = []; } }
function saveQueue() { try { localStorage.setItem(LS_QUEUE, JSON.stringify(queue)); } catch (e) {} }
function enqueue(op) { queue.push(op); saveQueue(); }

// Envoie une operation au serveur
function sendOp(op) {
  switch (op.type) {
    case 'reset': return apiReset();
    case 'addPhrase': return apiAddPhrase(op.id, op.text);
    case 'readPhrase': return apiReadPhrase(op.id, op.date);
    case 'deletePhrase': return apiDeletePhrase(op.id);
    case 'readTwister': return apiReadTwister(op.date);
    case 'addIdea': return apiAddIdea(op.id, op.text, op.createdAt);
    case 'setIdea': return apiSetIdea(op.id, op.pct);
    case 'deleteIdea': return apiDeleteIdea(op.id);
    default: return Promise.resolve();
  }
}

// Pousse la file d'attente vers le serveur (envoi seulement, AUCUN "pull").
// L'etat local reste la source de verite pendant la session.
async function flushQueue() {
  if (flushing) return;
  if (!navigator.onLine) { updateSyncBadge(); return; }
  flushing = true;
  updateSyncBadge();
  try {
    while (queue.length) {
      const op = queue[0];
      try {
        await sendOp(op);
        queue.shift(); saveQueue();
      } catch (e) {
        if (e.offline) break;            // toujours hors-ligne : on garde la file pour plus tard
        queue.shift(); saveQueue();      // erreur serveur (4xx) : on abandonne cet op pour ne pas bloquer
      }
    }
  } finally {
    flushing = false;
    updateSyncBadge();
  }
}

// Recupere l'etat du serveur et ECRASE le local. A n'appeler QU'au demarrage
// et a la reconnexion — jamais apres une simple action.
async function pullFromServer() {
  if (!navigator.onLine || queue.length) return;
  try {
    state = await apiGet();
    saveLocalState();
    if (currentTab === 'lecture') renderLecture();
    if (currentTab === 'twister') renderTwister();
    if (currentTab === 'ideas') renderIdeas();
    if (currentTab === 'settings') renderSettings();
  } catch (e) { /* hors-ligne : on garde l'etat local */ }
}

// Indicateur de synchronisation dans l'en-tete
function updateSyncBadge() {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (!navigator.onLine) {
    const n = queue.length;
    el.textContent = n > 0 ? ('Hors-ligne · ' + n) : 'Hors-ligne';
    el.className = 'ml-auto text-[10px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-100 px-2 py-1 rounded-full';
  } else {
    el.textContent = 'En ligne';
    el.className = 'ml-auto text-[10px] font-semibold uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full';
  }
}

// =========================================================================
// ONGLET 1 : GENERATEUR DE MOTS
// =========================================================================
const WORD_DEFAULTS = { count: 1, type: 0, minLen: 0, maxLen: 0, starts: '', ends: '', syll: 0, common: false };
let wordOpts = { ...WORD_DEFAULTS };
let matches = [];        // indices des mots correspondant aux filtres
let drawn = [];          // indices des mots actuellement affiches
let wordsBuilt = false;  // la coquille du generateur est-elle deja construite ?

function loadWordOpts() {
  try {
    const raw = localStorage.getItem(LS_WORDOPTS);
    if (raw) wordOpts = { ...WORD_DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {}
}
function saveWordOpts() { try { localStorage.setItem(LS_WORDOPTS, JSON.stringify(wordOpts)); } catch (e) {} }

async function loadWords() {
  const r = await fetch('./words.json');
  if (!r.ok) throw new Error('words.json');
  WORDS = await r.json();
}

// Enleve les accents : taper "e" trouve aussi "ecole" et "elephant"
function deaccent(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function typeLabel(t) {
  const l = [];
  if (t & T_NOM) l.push('nom');
  if (t & T_VER) l.push('verbe');
  if (t & T_ADJ) l.push('adjectif');
  if (t & T_ADV) l.push('adverbe');
  return l.join(' · ');
}

// Recalcule la liste des mots qui passent les filtres
function computeMatches() {
  matches = [];
  if (!WORDS) return;
  const { type, minLen, maxLen, syll, common } = wordOpts;
  const st = deaccent(wordOpts.starts.trim());
  const en = deaccent(wordOpts.ends.trim());
  const n = WORDS.w.length;
  for (let i = 0; i < n; i++) {
    const t = WORDS.t[i];
    if (type && !(t & type)) continue;
    if (common && !(t & T_COURANT)) continue;
    const w = WORDS.w[i];
    if (minLen && w.length < minLen) continue;
    if (maxLen && w.length > maxLen) continue;
    if (syll) {
      const s = WORDS.s[i];
      if (syll === 5 ? s < 5 : s !== syll) continue;
    }
    if (st || en) {
      const d = deaccent(w);
      if (st && !d.startsWith(st)) continue;
      if (en && !d.endsWith(en)) continue;
    }
    matches.push(i);
  }
}

// Tire `count` mots distincts au hasard parmi les correspondances
function drawWords() {
  const k = Math.min(wordOpts.count, matches.length);
  const pool = matches.slice();
  drawn = [];
  for (let i = 0; i < k; i++) {
    const j = Math.floor(Math.random() * pool.length);
    drawn.push(pool[j]);
    pool.splice(j, 1);
  }
}

function wordCardsHtml() {
  if (!WORDS) {
    return '<p class="text-center text-slate-400 py-10 text-sm">Chargement des mots…</p>';
  }
  if (!matches.length) {
    return '<p class="text-center text-slate-400 py-10 text-sm">Aucun mot ne correspond a ces filtres.<br>Assouplis-les puis reessaie.</p>';
  }
  if (!drawn.length) {
    return '<p class="text-center text-slate-400 py-10 text-sm">Appuie sur <span class="font-semibold text-accent2">Generer</span> pour tirer un mot au hasard.</p>';
  }
  const big = drawn.length === 1;
  return `<div class="${big ? '' : 'grid grid-cols-2 gap-2'}">` + drawn.map((i) => {
    const w = WORDS.w[i], s = WORDS.s[i];
    return `
      <button data-word="${escapeHtml(w)}" class="word-card w-full text-center rounded-2xl border border-emerald-100 bg-emerald-50 ${big ? 'py-8 px-4' : 'py-4 px-2'} active:scale-95 transition-transform">
        <span class="block font-display font-bold text-slate-900 break-words ${big ? 'text-4xl' : 'text-lg'}">${escapeHtml(w)}</span>
        <span class="block mt-2 text-[11px] text-accent2">${typeLabel(WORDS.t[i])} · ${s} syllabe${s > 1 ? 's' : ''}</span>
      </button>`;
  }).join('') + '</div>';
}

// Met a jour uniquement les parties dynamiques : on ne reconstruit pas les
// champs de filtre, donc on ne perd jamais le focus pendant la saisie.
function refreshWords() {
  const res = document.getElementById('wordResults');
  if (res) res.innerHTML = wordCardsHtml();
  const cnt = document.getElementById('matchCount');
  if (cnt) {
    cnt.textContent = WORDS
      ? matches.length.toLocaleString('fr-FR') + ' mot' + (matches.length > 1 ? 's' : '') + ' disponible' + (matches.length > 1 ? 's' : '')
      : 'chargement…';
  }
  const copyBtn = document.getElementById('copyWordsBtn');
  if (copyBtn) copyBtn.classList.toggle('hidden', drawn.length === 0);
  document.querySelectorAll('.word-card').forEach((b) => {
    b.addEventListener('click', () => copyText(b.dataset.word, 'Mot copie : ' + b.dataset.word));
  });
}

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch (e) { toast('Copie impossible sur cet appareil.'); }
}

const TYPE_CHOICES = [
  { v: 0, label: 'Tous' },
  { v: T_NOM, label: 'Nom' },
  { v: T_VER, label: 'Verbe' },
  { v: T_ADJ, label: 'Adjectif' },
  { v: T_ADV, label: 'Adverbe' }
];
const SYLL_CHOICES = [
  { v: 0, label: 'Toutes' }, { v: 1, label: '1' }, { v: 2, label: '2' },
  { v: 3, label: '3' }, { v: 4, label: '4' }, { v: 5, label: '5+' }
];

function chipsHtml(name, choices, current) {
  return choices.map((c) => `
    <button data-${name}="${c.v}" class="${name}-chip flex-shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors
      ${c.v === current ? 'bg-accent2 border-accent2 text-white font-semibold' : 'bg-white border-slate-200 text-slate-600'}">${c.label}</button>`).join('');
}

function renderWords() {
  if (wordsBuilt) { refreshWords(); return; }
  wordsBuilt = true;

  document.getElementById('view-words').innerHTML = `
    <div class="fade-up mt-2">

      <div id="wordResults" class="min-h-[9rem]">${wordCardsHtml()}</div>

      <button id="generateBtn" class="mt-4 w-full py-4 rounded-2xl bg-gradient-to-r from-accent to-accent2 text-white font-display font-bold text-lg active:scale-95 transition-transform">
        Generer 🎲
      </button>
      <button id="copyWordsBtn" class="mt-2 w-full py-2 rounded-xl border border-slate-200 text-slate-500 text-sm hidden">Copier</button>

      <div class="mt-6 bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
        <div class="flex items-center justify-between">
          <p class="font-display font-semibold text-slate-900">Nombre de mots</p>
          <div class="flex items-center gap-3">
            <button id="countMinus" class="w-9 h-9 rounded-full border border-slate-200 text-slate-600 text-xl leading-none active:bg-slate-50" aria-label="Moins">&minus;</button>
            <span id="countValue" class="font-display font-bold text-xl w-8 text-center text-accent2">${wordOpts.count}</span>
            <button id="countPlus" class="w-9 h-9 rounded-full border border-slate-200 text-slate-600 text-xl leading-none active:bg-slate-50" aria-label="Plus">+</button>
          </div>
        </div>

        <p class="mt-4 text-xs uppercase tracking-wider text-slate-400 font-bold">Type de mot</p>
        <div id="typeChips" class="mt-2 flex gap-2 overflow-x-auto no-scrollbar"></div>

        <p class="mt-4 text-xs uppercase tracking-wider text-slate-400 font-bold">Syllabes</p>
        <div id="syllChips" class="mt-2 flex gap-2 overflow-x-auto no-scrollbar"></div>

        <details class="mt-4">
          <summary class="text-sm text-slate-500 cursor-pointer select-none">Filtres avances</summary>

          <div class="mt-3 grid grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs text-slate-500">Commence par</span>
              <input id="startsInput" type="text" maxlength="6" value="${escapeHtml(wordOpts.starts)}" placeholder="ex : bo"
                class="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:border-accent" />
            </label>
            <label class="block">
              <span class="text-xs text-slate-500">Finit par</span>
              <input id="endsInput" type="text" maxlength="6" value="${escapeHtml(wordOpts.ends)}" placeholder="ex : tion"
                class="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:border-accent" />
            </label>
            <label class="block">
              <span class="text-xs text-slate-500">Lettres min.</span>
              <input id="minLenInput" type="number" min="2" max="20" value="${wordOpts.minLen || ''}" placeholder="—"
                class="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:border-accent" />
            </label>
            <label class="block">
              <span class="text-xs text-slate-500">Lettres max.</span>
              <input id="maxLenInput" type="number" min="2" max="20" value="${wordOpts.maxLen || ''}" placeholder="—"
                class="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:border-accent" />
            </label>
          </div>

          <div class="mt-4 flex items-center justify-between gap-3">
            <div>
              <p class="text-sm text-slate-700 font-medium">Mots courants seulement</p>
              <p class="text-xs text-slate-500 mt-0.5">Ecarte les mots rares et techniques.</p>
            </div>
            <button id="commonToggle" role="switch" aria-checked="${wordOpts.common}"
              class="flex-shrink-0 relative w-12 h-7 rounded-full transition-colors ${wordOpts.common ? 'bg-emerald-500' : 'bg-slate-300'}">
              <span class="absolute top-0.5 ${wordOpts.common ? 'left-[22px]' : 'left-0.5'} w-6 h-6 rounded-full bg-white shadow transition-all"></span>
            </button>
          </div>

          <button id="resetFiltersBtn" class="mt-4 text-xs text-slate-400 underline">Reinitialiser les filtres</button>
        </details>

        <p class="mt-4 text-center text-xs text-slate-400"><span id="matchCount">…</span></p>
      </div>

    </div>
  `;

  document.getElementById('generateBtn').addEventListener('click', () => {
    if (!WORDS) return;
    drawWords();
    refreshWords();
  });
  document.getElementById('copyWordsBtn').addEventListener('click', () => {
    copyText(drawn.map((i) => WORDS.w[i]).join(', '), 'Mots copies !');
  });

  const setCount = (n) => {
    wordOpts.count = Math.max(1, Math.min(20, n));
    document.getElementById('countValue').textContent = wordOpts.count;
    saveWordOpts();
  };
  document.getElementById('countMinus').addEventListener('click', () => setCount(wordOpts.count - 1));
  document.getElementById('countPlus').addEventListener('click', () => setCount(wordOpts.count + 1));

  // Les "chips" sont redessinees a chaque choix : on redessine puis on rebranche.
  const paintChips = (name, choices) => {
    const box = document.getElementById(name + 'Chips');
    box.innerHTML = chipsHtml(name, choices, wordOpts[name]);
    box.querySelectorAll('.' + name + '-chip').forEach((b) => {
      b.addEventListener('click', () => {
        wordOpts[name] = Number(b.dataset[name]);
        saveWordOpts();
        paintChips(name, choices);
        onFilterChange();
      });
    });
  };
  paintChips('type', TYPE_CHOICES);
  paintChips('syll', SYLL_CHOICES);

  const bindText = (id, key) => {
    document.getElementById(id).addEventListener('input', (e) => {
      wordOpts[key] = e.target.value;
      saveWordOpts();
      onFilterChange();
    });
  };
  bindText('startsInput', 'starts');
  bindText('endsInput', 'ends');

  const bindNum = (id, key) => {
    document.getElementById(id).addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      wordOpts[key] = Number.isFinite(v) ? Math.max(0, Math.min(20, v)) : 0;
      saveWordOpts();
      onFilterChange();
    });
  };
  bindNum('minLenInput', 'minLen');
  bindNum('maxLenInput', 'maxLen');

  document.getElementById('commonToggle').addEventListener('click', (e) => {
    wordOpts.common = !wordOpts.common;
    saveWordOpts();
    const btn = e.currentTarget;
    btn.setAttribute('aria-checked', String(wordOpts.common));
    btn.className = `flex-shrink-0 relative w-12 h-7 rounded-full transition-colors ${wordOpts.common ? 'bg-emerald-500' : 'bg-slate-300'}`;
    btn.querySelector('span').className = `absolute top-0.5 ${wordOpts.common ? 'left-[22px]' : 'left-0.5'} w-6 h-6 rounded-full bg-white shadow transition-all`;
    onFilterChange();
  });

  document.getElementById('resetFiltersBtn').addEventListener('click', () => {
    wordOpts = { ...WORD_DEFAULTS };
    saveWordOpts();
    wordsBuilt = false;
    renderWords();
    toast('Filtres reinitialises.');
  });

  onFilterChange();
}

// Un filtre a change : on recalcule les correspondances et on vide le tirage.
function onFilterChange() {
  computeMatches();
  drawn = [];
  refreshWords();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =========================================================================
// IDEES : actions local-first
// =========================================================================
const IDEA_STEP = 10; // +10% par clic

function ideaColor(pct) {
  if (pct <= 0) return '#94a3b8';            // gris : pas commencee
  const hue = 140 - (140 * pct / 100);        // 140 vert -> 0 rouge
  return `hsl(${Math.round(hue)}, 72%, 42%)`;
}

function addIdea(text) {
  text = (text || '').trim();
  if (!text) return;
  const id = 'i' + Date.now() + Math.floor(Math.random() * 1000);
  const createdAt = new Date().toISOString();
  if (!Array.isArray(state.ideas)) state.ideas = [];
  state.ideas.unshift({ id, text, pct: 0, createdAt });
  enqueue({ type: 'addIdea', id, text, createdAt });
  saveLocalState();
  renderIdeas();
  flushQueue();
}

function bumpIdea(id) {
  const it = (state.ideas || []).find((x) => x.id === id);
  if (!it) return;
  it.pct = Math.min(100, (it.pct || 0) + IDEA_STEP);
  enqueue({ type: 'setIdea', id, pct: it.pct });
  if (it.pct === 100) toast('Idee a 100% 🎯');
  saveLocalState();
  renderIdeas();
  flushQueue();
}

function resetIdea(id) {
  const it = (state.ideas || []).find((x) => x.id === id);
  if (!it) return;
  it.pct = 0;
  enqueue({ type: 'setIdea', id, pct: 0 });
  saveLocalState();
  renderIdeas();
  flushQueue();
}

function deleteIdea(id) {
  if (!confirm('Supprimer cette idee ?')) return;
  state.ideas = (state.ideas || []).filter((x) => x.id !== id);
  enqueue({ type: 'deleteIdea', id });
  saveLocalState();
  renderIdeas();
  flushQueue();
}

// =========================================================================
// LECTURE : actions local-first
// =========================================================================
function phraseTotal(ph) { return Object.values(ph.reads || {}).reduce((a, b) => a + b, 0); }
function phraseToday(ph) { return (ph.reads || {})[todayISO()] || 0; }

function addPhrase(text) {
  text = (text || '').trim();
  if (!text) return;
  const id = 'p' + Date.now() + Math.floor(Math.random() * 1000);
  if (!Array.isArray(state.phrases)) state.phrases = [];
  state.phrases.push({ id, text, reads: {} });
  enqueue({ type: 'addPhrase', id, text });
  saveLocalState();
  renderLecture();
  flushQueue();
}

function readPhrase(id) {
  const ph = (state.phrases || []).find((p) => p.id === id);
  if (!ph) return;
  const d = todayISO();
  ph.reads[d] = (ph.reads[d] || 0) + 1;
  enqueue({ type: 'readPhrase', id, date: d });
  saveLocalState();
  renderLecture();
  flushQueue();
}

function deletePhrase(id) {
  if (!confirm('Supprimer cette phrase et toutes ses statistiques ?')) return;
  state.phrases = (state.phrases || []).filter((p) => p.id !== id);
  enqueue({ type: 'deletePhrase', id });
  saveLocalState();
  renderLecture();
  flushQueue();
}

// =========================================================================
// ONGLET : LECTURE (phrases / citations + courbe d'evolution)
// =========================================================================

// Courbe cumulee des lectures sur `days` jours (SVG inline, etire en largeur).
function readsSparkline(reads, days) {
  const today = new Date();
  const startIso = fmt(addDays(today, -(days - 1)));
  let base = 0;
  for (const k in reads) { if (k < startIso) base += reads[k]; }
  const series = [];
  let cum = base;
  for (let i = days - 1; i >= 0; i--) {
    cum += reads[fmt(addDays(today, -i))] || 0;
    series.push(cum);
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = (max - min) || 1;
  const w = 300, h = 48, pad = 4;
  const pts = series.map((v, i) => {
    const x = pad + (i / (series.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const flat = max === min;
  return `<svg viewBox="0 0 ${w} ${h}" class="w-full h-12" preserveAspectRatio="none">
    <polyline fill="none" stroke="${flat ? '#cbd5e1' : '#0e9f6e'}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round" points="${pts}" /></svg>`;
}

function renderLecture() {
  const phrases = state.phrases || [];
  const totalReads = phrases.reduce((a, p) => a + phraseTotal(p), 0);
  const readToday = phrases.reduce((a, p) => a + phraseToday(p), 0);

  const cards = phrases.map((p) => {
    const total = phraseTotal(p);
    const today = phraseToday(p);
    return `
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <button data-read="${p.id}" class="phrase-read w-full text-left p-4 active:bg-emerald-50 transition-colors">
          <p class="text-[15px] leading-snug text-slate-800">${escapeHtml(p.text)}</p>
          <p class="mt-2 text-xs text-accent2 font-semibold">Tape pour compter une lecture +1</p>
        </button>
        <div class="px-4">${readsSparkline(p.reads, 30)}</div>
        <div class="flex items-center justify-between px-4 py-3 border-t border-slate-100">
          <div class="flex gap-4 text-sm">
            <span class="text-slate-500">Aujourd'hui : <b class="text-slate-800">${today}</b></span>
            <span class="text-slate-500">Total : <b class="text-accent2">${total}</b></span>
          </div>
          <button data-del="${p.id}" class="phrase-del text-slate-300 hover:text-red-500 text-lg leading-none" aria-label="Supprimer">✕</button>
        </div>
      </div>`;
  }).join('');

  document.getElementById('view-lecture').innerHTML = `
    <div class="fade-up mt-2">
      <h3 class="font-display font-semibold text-lg text-slate-900">Mes phrases a apprendre</h3>
      <p class="text-sm text-slate-500 mt-1">Ajoute des phrases, tape dessus a chaque lecture, et suis ta courbe d'apprentissage.</p>

      <div class="mt-4 flex gap-2">
        <input id="phraseInput" type="text" maxlength="1000" placeholder="Ecris une phrase ou citation a memoriser…"
          class="flex-1 px-3 py-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-800 focus:outline-none focus:border-accent" />
        <button id="addPhraseBtn" class="px-4 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white font-semibold text-sm active:scale-95 transition-transform">Ajouter</button>
      </div>

      <div class="mt-4 grid grid-cols-2 gap-3">
        <div class="bg-white rounded-2xl p-4 border border-slate-200 text-center shadow-sm">
          <p class="font-display text-2xl font-bold text-accent2">${readToday}</p>
          <p class="text-xs text-slate-500 mt-1">Lectures aujourd'hui</p>
        </div>
        <div class="bg-white rounded-2xl p-4 border border-slate-200 text-center shadow-sm">
          <p class="font-display text-2xl font-bold text-accent2">${totalReads}</p>
          <p class="text-xs text-slate-500 mt-1">Lectures au total</p>
        </div>
      </div>

      <div class="mt-5 space-y-3">
        ${phrases.length ? cards : '<p class="text-center text-slate-400 py-12 text-sm">Aucune phrase pour le moment. Ajoute ta premiere ci-dessus.</p>'}
      </div>
    </div>
  `;

  const input = document.getElementById('phraseInput');
  const add = () => { addPhrase(input.value); };
  document.getElementById('addPhraseBtn').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  document.querySelectorAll('.phrase-read').forEach((b) => {
    b.addEventListener('click', () => readPhrase(b.dataset.read));
  });
  document.querySelectorAll('.phrase-del').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); deletePhrase(b.dataset.del); });
  });
}

// =========================================================================
// ONGLET : VIRELANGUE DU JOUR
// =========================================================================
const TWISTERS = [
  "Les chaussettes de l'archiduchesse sont-elles sèches, archi-sèches ?",
  "Un chasseur sachant chasser doit savoir chasser sans son chien.",
  "Si six scies scient six cyprès, six cent six scies scient six cent six cyprès.",
  "Ton thé t'a-t-il ôté ta toux ?",
  "Je veux et j'exige d'exquises excuses.",
  "Didon dîna, dit-on, du dos d'un dodu dindon.",
  "Trois tortues trottaient sur un trottoir très étroit.",
  "Suis-je bien chez ce cher Serge ?",
  "As-tu vu le vert ver allant vers le verre en verre vert ?",
  "Combien sont ces six saucissons-ci ? Ces six saucissons-ci sont six sous.",
  "Natacha n'attacha pas son chat Pacha qui s'échappa.",
  "Un généreux déjeuner régénérerait des généraux dégénérés.",
  "Fruits frais, fruits frits, fruits cuits, fruits crus.",
  "Seize jacinthes sèchent dans seize sachets secs.",
  "Pauvre petit pêcheur, prends patience pour pouvoir prendre plusieurs petits poissons.",
  "Le cricri de la crique crie son cri cru et critique car il craint que l'escroc ne le croque et ne le craque.",
  "Petit pot de beurre, quand te dépetitpotdebeurreriseras-tu ?",
  "Ces cerises sont si sûres qu'on ne sait pas si c'en sont.",
  "La pie niche haut, l'oie niche bas. Où l'hibou niche-t-il ? L'hibou niche ni haut ni bas.",
  "Rat vit riz, rat mit patte à ras de riz, riz cuit patte à rat.",
  "Le mur murant Paris rend Paris murmurant.",
  "Il était une fois un homme de foi qui vendait du foie dans la ville de Foix. Il dit : ma foi, c'est la dernière fois que je vends du foie dans la ville de Foix.",
  "Je dis que tu l'as dit à Didi ce que j'ai dit jeudi.",
  "Les poules couvent souvent au couvent.",
  "Qu'a bu l'âne au lac ? L'âne au lac a bu l'eau.",
  "Un plein plat de blé pilé.",
  "L'assassin sur son sein suçait son sang sans cesse.",
  "Chez les Papous, il y a des Papous papas et des Papous pas papas, des Papous à poux et des Papous pas à poux.",
  "Trois gros rats gris dans trois gros trous ronds rongent trois gros croûtons ronds.",
  "Zazie causait avec sa cousine en cousant.",
  "Si ton tonton tond ton tonton, ton tonton sera tondu.",
  "Le fisc fixe exprès chaque taxe fixe excessive exclusivement au luxe et à l'exquis.",
  "Pour qui sont ces serpents qui sifflent sur vos têtes ?",
  "Un pâtissier qui pâtissait chez un tapissier qui tapissait dit un jour au tapissier : vaut-il mieux pâtisser chez un tapissier ou tapisser chez un pâtissier ?",
  "Cinq gros rats grillent dans la grosse graisse grasse.",
  "Poisson sans boisson est poison.",
  "Douze douches douces.",
  "Panier, piano, panier, piano, panier, piano.",
  "Gros gras grain d'orge, quand te dégrosgrasgraindorgeriseras-tu ?",
  "Je suis ce que je suis, et si je suis ce que je suis, qu'est-ce que je suis ?",
  "Tas de riz, tas de rats. Tas de riz tentant, tas de rats tentés.",
  "Un dragon gradé dégrade un gradé dragon.",
  "Lulu lit l'illustré.",
  "Cinq chiens chassent six chats.",
  "Pruneau cuit, pruneau cru, pruneau cuit, pruneau cru.",
  "Blanc bonnet et bonnet blanc, bonnet blanc et blanc bonnet."
];
const TWISTER_GOAL = 3; // lentement, normalement, vite

let twisterOffset = 0;  // 0 = virelangue du jour ; sinon, entrainement libre

function twisterReads() { return state.twisters || (state.twisters = {}); }

// Index du virelangue du jour : change a minuit (heure locale), meme sur tous les appareils.
function twisterIndexFor(date) {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return day % TWISTERS.length;
}

// Jours consecutifs avec au moins une lecture (aujourd'hui non lu ne casse pas la serie).
function twisterStreak() {
  const reads = twisterReads();
  let d = new Date();
  if (!reads[fmt(d)]) d = addDays(d, -1);
  let n = 0;
  while (reads[fmt(d)]) { n++; d = addDays(d, -1); }
  return n;
}

function readTwister() {
  const d = todayISO();
  const reads = twisterReads();
  reads[d] = (reads[d] || 0) + 1;
  enqueue({ type: 'readTwister', date: d });
  if (reads[d] === TWISTER_GOAL) toast('Virelangue du jour valide 🎯');
  saveLocalState();
  renderTwister();
  flushQueue();
}

function renderTwister() {
  const reads = twisterReads();
  const now = new Date();
  const todayIdx = twisterIndexFor(now);
  const idx = (todayIdx + twisterOffset) % TWISTERS.length;
  const isDaily = twisterOffset === 0;
  const today = reads[todayISO()] || 0;
  const total = Object.values(reads).reduce((a, b) => a + b, 0);
  const streak = twisterStreak();
  const steps = ['Lentement', 'Normalement', 'Vite'];

  const stepsHtml = steps.map((label, i) => {
    const done = today > i;
    return `
      <div class="flex-1 text-center">
        <div class="mx-auto w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold
          ${done ? 'bg-accent2 text-white' : 'bg-slate-100 text-slate-400'}">${done ? '✓' : i + 1}</div>
        <p class="mt-1 text-[11px] ${done ? 'text-accent2 font-semibold' : 'text-slate-400'}">${label}</p>
      </div>`;
  }).join('');

  // Les 7 derniers jours
  const weekHtml = Array.from({ length: 7 }, (_, k) => {
    const d = addDays(now, k - 6);
    const n = reads[fmt(d)] || 0;
    const day = d.toLocaleDateString('fr-FR', { weekday: 'narrow' });
    const cls = n >= TWISTER_GOAL ? 'bg-accent2' : n > 0 ? 'bg-emerald-200' : 'bg-slate-100';
    return `
      <div class="flex-1 text-center">
        <div class="mx-auto w-6 h-6 rounded-md ${cls}" title="${fmt(d)} : ${n} lecture(s)"></div>
        <p class="mt-1 text-[10px] uppercase text-slate-400">${day}</p>
      </div>`;
  }).join('');

  const dateLabel = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  document.getElementById('view-twister').innerHTML = `
    <div class="fade-up mt-2">
      <p class="text-xs uppercase tracking-wider text-accent2 font-bold">${isDaily ? 'Virelangue du jour' : 'Entrainement libre'}</p>
      <p class="text-sm text-slate-500 capitalize">${dateLabel}</p>

      <button id="twisterRead" class="mt-4 w-full text-left rounded-2xl border border-emerald-100 bg-emerald-50 p-5 active:scale-[.98] transition-transform">
        <p class="font-display font-bold text-2xl leading-snug text-slate-900">${escapeHtml(TWISTERS[idx])}</p>
        <p class="mt-3 text-xs text-accent2 font-semibold">Tape apres chaque lecture a voix haute +1</p>
      </button>

      <div class="mt-4 bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
        <p class="text-sm text-slate-600">Lis-le 3 fois, de plus en plus vite, en articulant chaque syllabe.</p>
        <div class="mt-3 flex">${stepsHtml}</div>
      </div>

      <div class="mt-4 grid grid-cols-3 gap-3">
        <div class="bg-white rounded-2xl p-3 border border-slate-200 text-center shadow-sm">
          <p class="font-display text-2xl font-bold text-accent2">${today}</p>
          <p class="text-[11px] text-slate-500 mt-1">Aujourd'hui</p>
        </div>
        <div class="bg-white rounded-2xl p-3 border border-slate-200 text-center shadow-sm">
          <p class="font-display text-2xl font-bold text-accent2">${streak}</p>
          <p class="text-[11px] text-slate-500 mt-1">Jour${streak > 1 ? 's' : ''} d'affilee</p>
        </div>
        <div class="bg-white rounded-2xl p-3 border border-slate-200 text-center shadow-sm">
          <p class="font-display text-2xl font-bold text-accent2">${total}</p>
          <p class="text-[11px] text-slate-500 mt-1">Au total</p>
        </div>
      </div>

      <div class="mt-4 bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
        <p class="text-xs uppercase tracking-wider text-slate-400 font-bold">7 derniers jours</p>
        <div class="mt-3 flex">${weekHtml}</div>
      </div>

      <div class="mt-4 flex gap-2">
        <button id="twisterNext" class="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 text-sm active:bg-slate-50">Un autre pour s'entrainer</button>
        ${isDaily ? '' : '<button id="twisterBack" class="flex-1 py-3 rounded-xl border border-emerald-200 text-accent2 text-sm font-semibold active:bg-emerald-50">Revenir au jour</button>'}
      </div>
    </div>
  `;

  document.getElementById('twisterRead').addEventListener('click', readTwister);
  document.getElementById('twisterNext').addEventListener('click', () => {
    twisterOffset = (twisterOffset + 1) % TWISTERS.length;
    renderTwister();
  });
  const back = document.getElementById('twisterBack');
  if (back) back.addEventListener('click', () => { twisterOffset = 0; renderTwister(); });
}

// =========================================================================
// ONGLET : IDEES (notes avec pourcentage de progression)
// =========================================================================
function renderIdeas() {
  const ideas = state.ideas || [];

  const cards = ideas.map((it) => {
    const pct = it.pct || 0;
    const color = ideaColor(pct);
    const done = pct >= 100;
    const date = it.createdAt ? new Date(it.createdAt).toLocaleDateString('fr-FR') : '';
    return `
      <div class="bg-white rounded-2xl border ${done ? 'border-emerald-300' : 'border-slate-200'} shadow-sm overflow-hidden">
        <button data-bump="${it.id}" class="idea-bump w-full text-left p-4 active:bg-slate-50 transition-colors">
          <div class="flex items-start gap-3">
            <p class="flex-1 text-[15px] leading-snug text-slate-800 whitespace-pre-wrap">${escapeHtml(it.text)}</p>
            <span class="flex-shrink-0 font-display font-bold text-lg" style="color:${color}">${pct}%</span>
          </div>
          <div class="mt-3 w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300" style="width:${pct}%;background:${color}"></div>
          </div>
          <p class="mt-2 text-xs text-slate-400">${done ? '🎯 Objectif atteint' : 'Tape pour avancer (+' + IDEA_STEP + '%)'}${date ? ' · ' + date : ''}</p>
        </button>
        <div class="flex items-center justify-end gap-3 px-4 py-2 border-t border-slate-100 text-xs">
          <button data-reset="${it.id}" class="idea-reset text-slate-400 hover:text-slate-700">Remettre a 0</button>
          <button data-del="${it.id}" class="idea-del text-slate-300 hover:text-red-500 text-lg leading-none" aria-label="Supprimer">✕</button>
        </div>
      </div>`;
  }).join('');

  document.getElementById('view-ideas').innerHTML = `
    <div class="fade-up mt-2">
      <h3 class="font-display font-semibold text-lg text-slate-900">Mes idees</h3>
      <p class="text-sm text-slate-500 mt-1">Note tes idees, puis tape dessus pour faire monter leur avancement.</p>

      <div class="mt-4 flex gap-2">
        <input id="ideaInput" type="text" maxlength="2000" placeholder="Note une idee, une pensee…"
          class="flex-1 px-3 py-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-800 focus:outline-none focus:border-accent" />
        <button id="addIdeaBtn" class="px-4 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white font-semibold text-sm active:scale-95 transition-transform">Ajouter</button>
      </div>

      <div class="mt-5 space-y-3">
        ${ideas.length ? cards : '<p class="text-center text-slate-400 py-12 text-sm">Aucune idee pour le moment. Note ta premiere ci-dessus.</p>'}
      </div>
    </div>
  `;

  const input = document.getElementById('ideaInput');
  const add = () => { addIdea(input.value); };
  document.getElementById('addIdeaBtn').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  document.querySelectorAll('.idea-bump').forEach((b) => {
    b.addEventListener('click', () => bumpIdea(b.dataset.bump));
  });
  document.querySelectorAll('.idea-reset').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); resetIdea(b.dataset.reset); });
  });
  document.querySelectorAll('.idea-del').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); deleteIdea(b.dataset.del); });
  });
}

// =========================================================================
// ONGLET : PARAMETRES
// =========================================================================
function renderSettings() {
  const nbWords = WORDS ? WORDS.w.length.toLocaleString('fr-FR') : '…';
  document.getElementById('view-settings').innerHTML = `
    <div class="fade-up mt-2">

      <div class="bg-emerald-50 rounded-2xl p-4 border border-emerald-100">
        <p class="text-xs uppercase tracking-wider text-accent2 font-bold">Base de mots</p>
        <h2 class="font-display text-xl font-bold mt-1 text-slate-900">${nbWords} mots francais</h2>
        <p class="mt-1 text-sm text-slate-600">Noms, verbes, adjectifs et adverbes, disponibles hors-ligne. Source : Lexique 3.83 (lexique.org).</p>
      </div>

      <div class="mt-6 bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
        <p class="font-display font-semibold text-slate-900">Mes donnees</p>
        <p class="text-xs text-slate-500 mt-1">${(state.phrases || []).length} phrase(s) · ${(state.ideas || []).length} idee(s)</p>
        <button id="resetDataBtn" class="mt-3 w-full py-3 rounded-xl bg-slate-800 text-white font-semibold text-sm active:scale-95 transition-transform">
          Effacer toutes mes donnees
        </button>
      </div>

      <p class="mt-6 text-center text-[11px] text-slate-400">Copilote de Parole · ta voix, ton rythme.</p>
    </div>
  `;

  document.getElementById('resetDataBtn').addEventListener('click', () => {
    if (!confirm('Effacer tes phrases, tes idees et ton historique de virelangues ? Cette action est definitive.')) return;
    state = { version: 2, startDate: todayISO(), completions: [], progress: {}, phrases: [], ideas: [], twisters: {} };
    saveLocalState();
    enqueue({ type: 'reset' });
    toast('Donnees effacees.');
    renderSettings();
    flushQueue();
  });
}

// =========================================================================
// NAVIGATION
// =========================================================================
const TABS = ['words', 'lecture', 'twister', 'ideas', 'settings'];

function switchTab(tab) {
  currentTab = tab;
  TABS.forEach((t) => {
    document.getElementById('view-' + t).classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('text-accent2', active);
    b.classList.toggle('text-slate-400', !active);
  });
  if (tab === 'words') renderWords();
  if (tab === 'lecture') renderLecture();
  if (tab === 'twister') renderTwister();
  if (tab === 'ideas') renderIdeas();
  if (tab === 'settings') renderSettings();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.querySelector('div').textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// =========================================================================
// INIT
// =========================================================================
async function init() {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // 1) Affichage immediat depuis le cache local (fonctionne hors-ligne)
  loadQueue();
  loadWordOpts();
  const ls = loadLocalState();
  if (ls) state = ls;
  document.getElementById('loader').remove();
  switchTab('words');
  updateSyncBadge();

  // 2) Base de mots (fichier statique, mis en cache par le Service Worker)
  try {
    await loadWords();
    computeMatches();
    drawWords();          // un premier mot des l'ouverture
    refreshWords();
  } catch (e) {
    const res = document.getElementById('wordResults');
    if (res) res.innerHTML = '<p class="text-center text-slate-400 py-10 text-sm">Base de mots indisponible. Recharge la page une fois en ligne.</p>';
  }

  // 3) Au demarrage si en ligne : on envoie d'abord la file en attente,
  //    PUIS on tire l'etat du serveur (resync complet).
  if (navigator.onLine) {
    await flushQueue();
    await pullFromServer();
    updateSyncBadge();
  }

  // 4) A la reconnexion (hors-ligne -> en ligne) : meme sequence.
  window.addEventListener('online', async () => {
    updateSyncBadge();
    await flushQueue();
    await pullFromServer();
    updateSyncBadge();
  });
  window.addEventListener('offline', updateSyncBadge);
}

init();
