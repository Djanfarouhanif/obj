// =========================================================================
// CONFIG
// =========================================================================
const API = '/api';
const POINTS_PER_MISSION = 0.2;
const BASE_SCORE = 1.0;
const MAX_SCORE = 10.0;

// Contenu du programme (missions, themes, citations) charge depuis
// program.json via l API — AUCUNE donnee codee en dur dans ce fichier.
let MISSIONS = [];
let THEMES = {};
let CITATIONS = [];

// =========================================================================
// ETAT & API
// =========================================================================
let state = { version: 2, startDate: todayISO(), completions: [], progress: {} };
let chart = null;
let currentTab = 'today';
let customProgram = false;

function todayISO() { return fmt(new Date()); }
function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }

async function apiGet() {
  const r = await fetch(API + '/data');
  if (!r.ok) throw new Error('GET /data');
  return r.json();
}
async function apiDefaultProgram() {
  // program.json : programme par defaut, fichier statique
  const r = await fetch('./program.json');
  if (!r.ok) throw new Error('GET program.json');
  return r.json();
}
async function loadProgram() {
  // 1) programme personnalise (importe) ? 2) sinon, programme par defaut
  try {
    const r = await fetch(API + '/program');
    if (r.ok) { customProgram = true; return await r.json(); }
  } catch (e) { /* ignore, on retombe sur le defaut */ }
  customProgram = false;
  return apiDefaultProgram();
}
async function apiSaveProgram(obj) {
  const r = await fetch(API + '/program', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Import refuse.'); }
  return r.json();
}
async function apiDeleteProgram() {
  const r = await fetch(API + '/program', { method: 'DELETE' });
  if (!r.ok) throw new Error('DELETE /program');
  return r.json();
}

function applyProgram(p) {
  MISSIONS = p.missions || [];
  THEMES = p.themes || {};
  if (Array.isArray(p.citations) && p.citations.length) CITATIONS = p.citations;
}

function validProgramClient(p) {
  if (!p || typeof p !== 'object') return false;
  if (!Array.isArray(p.missions) || p.missions.length === 0) return false;
  return p.missions.every((m) =>
    m && typeof m.titre === 'string' &&
    Array.isArray(m.tasks) && m.tasks.length > 0 &&
    m.tasks.every((t) => typeof t === 'string')
  );
}
async function apiTaskOn(date, task) {
  const r = await fetch(API + '/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, task })
  });
  if (!r.ok) throw new Error('POST /progress');
  return r.json();
}
async function apiTaskOff(date, task) {
  const r = await fetch(API + '/progress/' + date + '/' + task, { method: 'DELETE' });
  if (!r.ok) throw new Error('DELETE /progress');
  return r.json();
}
async function apiComplete(date) {
  const r = await fetch(API + '/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date })
  });
  if (!r.ok) throw new Error('POST /completions');
  return r.json();
}
async function apiUncomplete(date) {
  const r = await fetch(API + '/completions/' + date, { method: 'DELETE' });
  if (!r.ok) throw new Error('DELETE /completions');
  return r.json();
}
async function apiReset() {
  const r = await fetch(API + '/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 2, startDate: todayISO(), completions: [], progress: {} })
  });
  if (!r.ok) throw new Error('PUT /data');
  return r.json();
}

// =========================================================================
// CALCULS DERIVES
// =========================================================================
function nbDone() { return state.completions.length; }
function score() { return Math.min(BASE_SCORE + POINTS_PER_MISSION * nbDone(), MAX_SCORE); }

// mission "du jour" = nb de journees completees AVANT aujourd'hui (stable apres validation)
function todaysMissionIndex() {
  const t = todayISO();
  const before = state.completions.filter((d) => d < t).length;
  return Math.min(before, MISSIONS.length - 1);
}

function todayChecks() { return state.progress[todayISO()] || []; }
function isTaskDone(i) { return todayChecks().includes(i); }
function allTasksDone(mission) { return mission.tasks.every((_, i) => isTaskDone(i)); }
function isDayComplete() { return state.completions.includes(todayISO()); }

function streak() {
  if (!state.completions.length) return 0;
  const set = new Set(state.completions);
  let cursor;
  if (set.has(todayISO())) cursor = new Date();
  else if (set.has(fmt(addDays(new Date(), -1)))) cursor = addDays(new Date(), -1);
  else return 0;
  let count = 0;
  while (set.has(fmt(cursor))) { count++; cursor = addDays(cursor, -1); }
  return count;
}

function citationOfDay() {
  if (!CITATIONS.length) return '';
  const idx = Math.abs(daysBetween(state.startDate, todayISO())) % CITATIONS.length;
  return CITATIONS[idx];
}

function curve30() {
  const labels = [], data = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = addDays(today, -i);
    const iso = fmt(d);
    const count = state.completions.filter((c) => c <= iso).length;
    labels.push(d.getDate() + '/' + (d.getMonth() + 1));
    data.push(Math.min(BASE_SCORE + POINTS_PER_MISSION * count, MAX_SCORE));
  }
  return { labels, data };
}

// =========================================================================
// ONGLET 1 : AUJOURD'HUI
// =========================================================================
function renderToday() {
  if (!MISSIONS.length) {
    document.getElementById('view-today').innerHTML =
      '<p class="text-center text-slate-400 py-20">Programme indisponible. Verifie le serveur puis recharge.</p>';
    return;
  }
  const s = score();
  const pct = ((s - BASE_SCORE) / (MAX_SCORE - BASE_SCORE)) * 100;
  const m = MISSIONS[todaysMissionIndex()];
  const dayNum = todaysMissionIndex() + 1;
  const doneCount = m.tasks.filter((_, i) => isTaskDone(i)).length;
  const total = m.tasks.length;
  const complete = isDayComplete();

  const R = 52, C = 2 * Math.PI * R;
  const offset = C * (1 - pct / 100);

  const tasksHtml = m.tasks.map((t, i) => {
    const done = isTaskDone(i);
    return `
      <button data-task="${i}" class="task-row w-full flex items-start gap-3 text-left p-3 rounded-xl border transition-colors
        ${done ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200 active:bg-slate-50'}">
        <span class="mt-0.5 flex-shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-colors
          ${done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300 text-transparent'}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        </span>
        <span class="text-[15px] leading-snug ${done ? 'text-emerald-700 line-through' : 'text-slate-700'}">${t}</span>
      </button>`;
  }).join('');

  document.getElementById('view-today').innerHTML = `
    <div class="fade-up flex flex-col items-center text-center mt-2">

      <div class="relative w-40 h-40">
        <svg class="w-40 h-40 -rotate-90" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="${R}" fill="none" stroke-width="10" class="ring-track" />
          <circle cx="60" cy="60" r="${R}" fill="none" stroke-width="10" class="ring-value"
            stroke="url(#grad)" stroke-dasharray="${C}" stroke-dashoffset="${offset}" />
          <defs><linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#f59e0b" /><stop offset="100%" stop-color="#ea580c" />
          </linearGradient></defs>
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          <span class="text-[10px] uppercase tracking-widest text-slate-400">Niveau</span>
          <span class="font-display text-4xl font-bold text-accent2">${s.toFixed(1)}</span>
          <span class="text-xs text-slate-400">/ 10</span>
        </div>
      </div>

      <p class="mt-3 text-sm text-slate-500">Jour ${dayNum} / ${MISSIONS.length} · ${m.phase}</p>

      <div class="mt-5 w-full bg-orange-50 rounded-2xl p-5 text-left border border-orange-100">
        <div class="flex items-center justify-between">
          <p class="text-xs uppercase tracking-wider text-accent2 font-bold">Mission du jour</p>
          <p class="text-xs font-semibold ${complete ? 'text-emerald-600' : 'text-slate-500'}">${doneCount}/${total} taches</p>
        </div>
        <h2 class="font-display text-2xl font-bold mt-1 text-slate-900">Mission ${dayNum} : ${m.titre}</h2>
        <div class="mt-3 w-full h-2 bg-orange-100 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-accent to-accent2 transition-all duration-500" style="width:${(doneCount/total)*100}%"></div>
        </div>
      </div>

      <div class="mt-4 w-full space-y-2">${tasksHtml}</div>

      <div class="mt-5 w-full">
        ${complete
          ? `<div class="w-full py-4 rounded-2xl bg-emerald-600 text-white font-display font-bold text-lg pop">Journee accomplie ✓</div>
             <button id="undoBtn" class="mt-3 text-xs text-slate-400 underline">Annuler la journee</button>`
          : `<div class="w-full py-4 rounded-2xl bg-slate-100 text-slate-400 font-display font-bold text-sm">Coche les ${total} taches pour valider la journee</div>`}
      </div>

      <div class="mt-8 w-full border-t border-slate-100 pt-5">
        <p class="text-sm italic text-slate-500 leading-relaxed">« ${citationOfDay()} »</p>
      </div>
    </div>
  `;

  document.querySelectorAll('.task-row').forEach((btn) => {
    btn.addEventListener('click', () => toggleTask(Number(btn.dataset.task), m));
  });
  const undo = document.getElementById('undoBtn');
  if (undo) undo.addEventListener('click', async () => {
    try { state = await apiUncomplete(todayISO()); renderAll(); }
    catch (e) { toast('Erreur reseau.'); }
  });
}

async function toggleTask(i, mission) {
  const date = todayISO();
  const wasComplete = isDayComplete();
  try {
    if (isTaskDone(i)) {
      state = await apiTaskOff(date, i);
      if (wasComplete) state = await apiUncomplete(date); // une tache decochee => journee non valide
    } else {
      state = await apiTaskOn(date, i);
      if (!wasComplete && allTasksDone(mission)) {
        state = await apiComplete(date);
        toast('Journee accomplie ! 🎉');
      }
    }
    renderAll();
  } catch (e) {
    toast('Erreur reseau, reessaie.');
  }
}

// =========================================================================
// ONGLET 2 : SEMAINE
// =========================================================================
function renderWeek() {
  if (!MISSIONS.length) return;
  const labels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const monday = addDays(now, -dow);
  const todayIso = todayISO();
  const set = new Set(state.completions);

  let validated = 0, cells = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const iso = fmt(d);
    let icon, ring;
    if (set.has(iso)) { validated++; icon = '✅'; ring = 'border-emerald-200 bg-emerald-50'; }
    else if (iso > todayIso) { icon = '❓'; ring = 'border-slate-200 bg-slate-50'; }
    else if (iso === todayIso) { icon = '⚪️'; ring = 'border-accent bg-orange-50'; }
    else { icon = '🔴'; ring = 'border-red-200 bg-red-50'; }
    cells += `
      <div class="flex flex-col items-center gap-1 rounded-xl border ${ring} py-3">
        <span class="text-xs text-slate-400">${labels[i]}</span>
        <span class="text-2xl">${icon}</span>
        <span class="text-[10px] text-slate-400">${d.getDate()}/${d.getMonth() + 1}</span>
      </div>`;
  }

  const theme = THEMES[MISSIONS[todaysMissionIndex()].phase] || '—';

  document.getElementById('view-week').innerHTML = `
    <div class="fade-up mt-2">
      <div class="bg-orange-50 rounded-2xl p-4 border border-orange-100">
        <p class="text-xs uppercase tracking-wider text-accent2 font-bold">Theme de la semaine</p>
        <h2 class="font-display text-2xl font-bold mt-1 text-slate-900">${theme}</h2>
      </div>

      <h3 class="font-display font-semibold text-lg mt-6 mb-3 text-slate-900">Semaine en cours</h3>
      <div class="grid grid-cols-7 gap-2">${cells}</div>

      <div class="mt-6 bg-white rounded-2xl p-5 border border-slate-200 text-center shadow-sm">
        <p class="text-sm text-slate-500">Taux de reussite</p>
        <p class="font-display text-3xl font-bold text-accent2 mt-1">${validated}/7 <span class="text-base text-slate-400">jours</span></p>
      </div>
    </div>
  `;
}

// =========================================================================
// ONGLET 3 : PROGRES
// =========================================================================
function renderProgress() {
  document.getElementById('view-progress').innerHTML = `
    <div class="fade-up mt-2">
      <h3 class="font-display font-semibold text-lg mb-3 text-slate-900">Evolution (30 jours)</h3>
      <div class="bg-white rounded-2xl p-3 border border-slate-200 shadow-sm">
        <canvas id="progressChart" height="200"></canvas>
      </div>

      <div class="grid grid-cols-2 gap-3 mt-5">
        <div class="bg-white rounded-2xl p-4 border border-slate-200 text-center shadow-sm">
          <p class="text-3xl">🔥</p>
          <p class="font-display text-3xl font-bold text-accent2 mt-1">${streak()}</p>
          <p class="text-xs text-slate-500 mt-1">Jours consecutifs</p>
        </div>
        <div class="bg-white rounded-2xl p-4 border border-slate-200 text-center shadow-sm">
          <p class="text-3xl">🏆</p>
          <p class="font-display text-3xl font-bold text-accent2 mt-1">${nbDone()}</p>
          <p class="text-xs text-slate-500 mt-1">Journees reussies</p>
        </div>
      </div>

      <div class="mt-6 text-center">
        <p class="text-sm text-slate-500">Niveau actuel : <span class="text-accent2 font-semibold">${score().toFixed(1)} / 10</span></p>
      </div>

      <!-- Import des objectifs -->
      <div class="mt-8 bg-white rounded-2xl p-4 border border-slate-200 shadow-sm text-left">
        <p class="font-display font-semibold text-slate-900">Mes objectifs</p>
        <p class="text-xs text-slate-500 mt-1">
          Programme actuel :
          <span class="font-semibold ${customProgram ? 'text-accent2' : 'text-slate-600'}">
            ${customProgram ? 'personnalise' : 'par defaut'}
          </span>
          · ${MISSIONS.length} jours
        </p>

        <input type="file" id="importFile" accept="application/json,.json" class="hidden" />
        <button id="pickFileBtn" class="mt-3 w-full py-3 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white font-semibold text-sm active:scale-95 transition-transform">
          Importer un fichier JSON
        </button>

        <details class="mt-3 group">
          <summary class="text-xs text-slate-500 cursor-pointer select-none">… ou coller le JSON</summary>
          <textarea id="pasteJson" rows="5" placeholder='{ "missions": [ { "titre": "...", "phase": "...", "tasks": ["..."] } ] }'
            class="mt-2 w-full text-xs font-mono p-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-700"></textarea>
          <button id="pasteImportBtn" class="mt-2 w-full py-2 rounded-lg bg-slate-800 text-white text-sm">Importer ce texte</button>
        </details>

        <div class="mt-3 flex items-center justify-between text-xs">
          <button id="tplBtn" class="text-slate-500 underline">Telecharger un modele</button>
          ${customProgram ? '<button id="revertBtn" class="text-slate-500 underline">Revenir au defaut</button>' : ''}
        </div>
      </div>

      <div class="mt-8 text-center">
        <button id="resetBtn" class="text-xs text-slate-400 underline">Reinitialiser ma progression</button>
      </div>
    </div>
  `;

  const { labels, data } = curve30();
  const ctx = document.getElementById('progressChart');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{
      label: 'Score', data,
      borderColor: '#ea580c',
      backgroundColor: (c) => {
        const { ctx, chartArea } = c.chart;
        if (!chartArea) return 'rgba(234,88,12,.12)';
        const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        g.addColorStop(0, 'rgba(245,158,11,.30)');
        g.addColorStop(1, 'rgba(245,158,11,0)');
        return g;
      },
      fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5
    }]},
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 1, max: 10, ticks: { color: '#94a3b8', stepSize: 1 }, grid: { color: 'rgba(148,163,184,.12)' } },
        x: { ticks: { color: '#94a3b8', maxTicksLimit: 6 }, grid: { display: false } }
      }
    }
  });

  document.getElementById('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reinitialiser toute ta progression ? Cette action est irreversible.')) return;
    try { state = await apiReset(); toast('Progression reinitialisee.'); renderAll(); }
    catch (e) { toast('Erreur reseau.'); }
  });

  // --- Import des objectifs ---
  const fileInput = document.getElementById('importFile');
  document.getElementById('pickFileBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    const text = await f.text();
    fileInput.value = '';
    importProgram(text);
  });
  document.getElementById('pasteImportBtn').addEventListener('click', () => {
    importProgram(document.getElementById('pasteJson').value);
  });
  document.getElementById('tplBtn').addEventListener('click', downloadTemplate);
  const revertBtn = document.getElementById('revertBtn');
  if (revertBtn) revertBtn.addEventListener('click', revertProgram);
}

async function importProgram(text) {
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { toast('JSON invalide (erreur de syntaxe).'); return; }
  if (!validProgramClient(obj)) {
    toast('Format invalide : il faut "missions": [{ titre, tasks: [...] }].');
    return;
  }
  try {
    const prog = await apiSaveProgram(obj);
    applyProgram(prog);
    customProgram = true;
    toast('Objectifs importes ! ' + prog.missions.length + ' jours.');
    renderAll();
    renderProgress();
  } catch (e) { toast(e.message || 'Erreur reseau.'); }
}

async function revertProgram() {
  if (!confirm('Revenir au programme par defaut ? Ton programme importe sera supprime (ta progression est conservee).')) return;
  try {
    await apiDeleteProgram();
    customProgram = false;
    applyProgram(await apiDefaultProgram());
    toast('Programme par defaut restaure.');
    renderAll();
    renderProgress();
  } catch (e) { toast('Erreur reseau.'); }
}

function downloadTemplate() {
  const data = JSON.stringify({ themes: THEMES, citations: CITATIONS, missions: MISSIONS }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mes-objectifs.json';
  a.click();
  URL.revokeObjectURL(url);
}

// =========================================================================
// NAVIGATION
// =========================================================================
function renderAll() {
  renderToday();
  renderWeek();
  if (currentTab === 'progress') renderProgress();
}
function switchTab(tab) {
  currentTab = tab;
  ['today', 'week', 'progress'].forEach((t) => {
    document.getElementById('view-' + t).classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('text-accent2', active);
    b.classList.toggle('text-slate-400', !active);
  });
  if (tab === 'progress') renderProgress();
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
  try {
    const [data, program] = await Promise.all([apiGet(), loadProgram()]);
    state = data;
    applyProgram(program);
  } catch (e) {
    toast('Serveur injoignable.');
  }
  document.getElementById('loader').remove();
  renderToday();
  renderWeek();
  switchTab('today');
}

init();
