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

// --- Couche reseau bas niveau : distingue "hors-ligne" (fetch echoue) de "erreur serveur" ---
async function apiFetch(path, opts) {
  let r;
  try { r = await fetch(API + path, opts); }
  catch (e) { const err = new Error('offline'); err.offline = true; throw err; }
  if (!r.ok) { const err = new Error('http ' + r.status); err.status = r.status; throw err; }
  return r.json().catch(() => ({}));
}

function apiGet() { return apiFetch('/data'); }
function apiTaskOn(date, task) {
  return apiFetch('/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, task }) });
}
function apiTaskOff(date, task) { return apiFetch('/progress/' + date + '/' + task, { method: 'DELETE' }); }
function apiComplete(date) {
  return apiFetch('/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) });
}
function apiUncomplete(date) { return apiFetch('/completions/' + date, { method: 'DELETE' }); }
function apiReset() {
  return apiFetch('/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 2, startDate: todayISO(), completions: [], progress: {} }) });
}
function apiSaveProgram(obj) {
  return apiFetch('/program', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
}
function apiDeleteProgram() { return apiFetch('/program', { method: 'DELETE' }); }

async function apiDefaultProgram() {
  // program.json : programme par defaut (fichier statique, dispo hors-ligne via le Service Worker)
  const r = await fetch('./program.json');
  if (!r.ok) throw new Error('GET program.json');
  return r.json();
}
async function loadProgram() {
  // 1) programme personnalise (importe) ? 2) sinon, programme par defaut
  try {
    const p = await apiFetch('/program');
    customProgram = true;
    return p;
  } catch (e) { /* 404 ou hors-ligne : on retombe sur le defaut */ }
  customProgram = false;
  return apiDefaultProgram();
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

// =========================================================================
// PERSISTANCE LOCALE & SYNCHRONISATION (offline-first)
// =========================================================================
const LS_STATE = 'cdp.state';
const LS_QUEUE = 'cdp.queue';
const LS_PROGRAM = 'cdp.program';
const LS_CUSTOM = 'cdp.custom';
let queue = [];
let flushing = false;

function saveLocalState() { try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch (e) {} }
function loadLocalState() { try { const s = localStorage.getItem(LS_STATE); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function saveLocalProgram(p) {
  try { localStorage.setItem(LS_PROGRAM, JSON.stringify(p)); localStorage.setItem(LS_CUSTOM, customProgram ? '1' : '0'); } catch (e) {}
}
function loadLocalProgram() { try { const p = localStorage.getItem(LS_PROGRAM); return p ? JSON.parse(p) : null; } catch (e) { return null; } }
function loadQueue() { try { const q = localStorage.getItem(LS_QUEUE); queue = q ? JSON.parse(q) : []; } catch (e) { queue = []; } }
function saveQueue() { try { localStorage.setItem(LS_QUEUE, JSON.stringify(queue)); } catch (e) {} }
function enqueue(op) { queue.push(op); saveQueue(); }

// Mutations locales (appliquees immediatement, meme hors-ligne)
function addTaskLocal(date, i) {
  if (!Array.isArray(state.progress[date])) state.progress[date] = [];
  if (!state.progress[date].includes(i)) { state.progress[date].push(i); state.progress[date].sort((a, b) => a - b); }
}
function removeTaskLocal(date, i) {
  const a = state.progress[date] || [];
  const idx = a.indexOf(i);
  if (idx > -1) a.splice(idx, 1);
  if (a.length === 0) delete state.progress[date];
}
function addCompletionLocal(date) { if (!state.completions.includes(date)) { state.completions.push(date); state.completions.sort(); } }
function removeCompletionLocal(date) { const idx = state.completions.indexOf(date); if (idx > -1) state.completions.splice(idx, 1); }

// Envoie une operation au serveur
function sendOp(op) {
  switch (op.type) {
    case 'taskOn': return apiTaskOn(op.date, op.task);
    case 'taskOff': return apiTaskOff(op.date, op.task);
    case 'complete': return apiComplete(op.date);
    case 'uncomplete': return apiUncomplete(op.date);
    case 'reset': return apiReset();
    case 'putProgram': return apiSaveProgram(op.program);
    case 'deleteProgram': return apiDeleteProgram();
    default: return Promise.resolve();
  }
}

// Vide la file d'attente puis resynchronise depuis le serveur
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
    if (queue.length === 0) {
      // resync : recupere l'etat du serveur (et d'eventuels changements d'un autre appareil)
      try {
        const data = await apiGet();
        state = data; saveLocalState();
        const prog = await loadProgram();
        applyProgram(prog); saveLocalProgram(prog);
        renderAll();
        if (currentTab === 'settings') renderSettings();
      } catch (e) { /* hors-ligne : on garde l'etat local */ }
    }
  } finally {
    flushing = false;
    updateSyncBadge();
  }
}

// Indicateur de synchronisation dans l'en-tete
function updateSyncBadge() {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (!navigator.onLine) {
    el.textContent = 'Hors-ligne';
    el.className = 'ml-auto text-[10px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-100 px-2 py-1 rounded-full';
  } else if (queue.length > 0) {
    el.textContent = 'Sync ⏳ ' + queue.length;
    el.className = 'ml-auto text-[10px] font-semibold uppercase tracking-wider text-accent2 bg-orange-50 px-2 py-1 rounded-full';
  } else {
    el.textContent = 'En ligne';
    el.className = 'ml-auto text-[10px] font-semibold uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full';
  }
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
  if (undo) undo.addEventListener('click', () => {
    const date = todayISO();
    removeCompletionLocal(date);
    enqueue({ type: 'uncomplete', date });
    saveLocalState();
    renderAll();
    flushQueue();
  });
}

// Local-first : on applique l'action immediatement, puis on synchronise (ou on met en file si hors-ligne)
function toggleTask(i, mission) {
  const date = todayISO();
  const wasComplete = isDayComplete();
  if (isTaskDone(i)) {
    removeTaskLocal(date, i);
    enqueue({ type: 'taskOff', date, task: i });
    if (wasComplete) { removeCompletionLocal(date); enqueue({ type: 'uncomplete', date }); }
  } else {
    addTaskLocal(date, i);
    enqueue({ type: 'taskOn', date, task: i });
    if (!wasComplete && allTasksDone(mission)) {
      addCompletionLocal(date);
      enqueue({ type: 'complete', date });
      toast('Journee accomplie ! 🎉');
    }
  }
  saveLocalState();
  renderAll();
  flushQueue();
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

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Reinitialiser toute ta progression ? Cette action est irreversible.')) return;
    state = { version: 2, startDate: todayISO(), completions: [], progress: {} };
    saveLocalState();
    enqueue({ type: 'reset' });
    toast('Progression reinitialisee.');
    renderAll();
    flushQueue();
  });
}

async function importProgram(text) {
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { toast('JSON invalide (erreur de syntaxe).'); return; }
  if (!validProgramClient(obj)) {
    toast('Format invalide : il faut "missions": [{ titre, tasks: [...] }].');
    return;
  }
  // Local-first : on applique tout de suite, puis on synchronise
  customProgram = true;
  applyProgram(obj);
  saveLocalProgram(obj);
  enqueue({ type: 'putProgram', program: obj });
  toast('Objectifs importes ! ' + obj.missions.length + ' jours.');
  renderAll();
  renderSettings();
  flushQueue();
}

async function revertProgram() {
  if (!confirm('Revenir au programme par defaut ? Ton programme importe sera supprime (ta progression est conservee).')) return;
  try {
    customProgram = false;
    const def = await apiDefaultProgram(); // dispo hors-ligne via le Service Worker
    applyProgram(def);
    saveLocalProgram(def);
    enqueue({ type: 'deleteProgram' });
    toast('Programme par defaut restaure.');
    renderAll();
    renderSettings();
    flushQueue();
  } catch (e) { toast('Erreur reseau.'); }
}

// =========================================================================
// ONGLET 4 : PARAMETRES (generateur IA + import)
// =========================================================================
const AI_PROMPT = `Tu es un coach/mentor expert capable de batir un programme d'entrainement progressif pour N'IMPORTE QUEL objectif personnel : apprendre une nouvelle competence, une langue, un instrument de musique, le code, le dessin, le sport, la cuisine, la prise de parole, une habitude... bref, tout ce que je veux apprendre ou ameliorer.

Aide-moi a construire ce programme jour par jour. Je vais l'importer dans mon application de suivi d'objectifs.

ETAPE 1 - INTERVIEW (REGLE ABSOLUE : UNE SEULE QUESTION A LA FOIS)
Pose-moi les questions ci-dessous, mais STRICTEMENT une par message.
Regles imperatives, sans exception :
- Pose UNE seule question, puis ARRETE-TOI et attends ma reponse.
- NE passe JAMAIS a la question suivante tant que je n'ai pas repondu a la question en cours.
- Ne regroupe jamais plusieurs questions dans le meme message. Ne saute aucune question.
- Si ma reponse est vague ou incomplete, reformule/repose la MEME question avant d'avancer.
- Ne commence l'ETAPE 2 (le JSON) que lorsque j'ai repondu a TOUTES les questions.
- Numerote chaque question (ex : "Question 1/5").

Questions a poser, dans cet ordre :
1. Quel est mon objectif precis ? (ce que je veux apprendre ou atteindre)
2. Mon niveau actuel sur cet objectif (grand debutant, debutant, intermediaire, avance)
3. Le temps dont je dispose chaque jour
4. La duree du programme souhaitee (nombre de jours, ex : 30)
5. Mon contexte, mes contraintes, mes blocages ou motivations

ETAPE 2 - GENERATION DU FICHIER JSON
Quand tu as assez d'infos, genere un VRAI FICHIER telechargeable nomme "mes-objectifs.json" (pas seulement du texte dans la conversation : cree un fichier que je peux telecharger). Son contenu doit etre un JSON valide respectant EXACTEMENT ce format :

{
  "themes": { "Nom de la phase": "Titre de l'etape" },
  "citations": ["citation motivante 1", "citation motivante 2"],
  "missions": [
    {
      "titre": "Titre court de la mission du jour",
      "phase": "Nom de la phase (doit aussi exister dans themes)",
      "tasks": ["tache concrete 1", "tache concrete 2", "tache concrete 3"]
    }
  ]
}

REGLES STRICTES :
- "missions" : un objet par jour, du plus facile au plus difficile (vraie progression vers l'objectif).
- Le nombre de missions = le nombre de jours demande.
- Chaque mission a 3 a 5 "tasks" : des actions concretes, mesurables, faisables dans la journee.
- Chaque "phase" utilisee dans une mission doit etre une cle de "themes".
- "citations" : des phrases motivantes adaptees a mon objectif.
- Le JSON doit etre valide (guillemets droits, pas de virgule finale) et adapte a MON objectif precis.
- Ecris tout en francais, ton motivant et bienveillant.
- Donne-moi le fichier "mes-objectifs.json" a telecharger, puis rappelle-moi de l'importer dans l'app via l'onglet Parametres. Si tu ne peux pas creer de fichier telechargeable, alors affiche UNIQUEMENT le JSON dans un bloc de code, sans aucun autre texte, pour que je puisse l'enregistrer en .json moi-meme.`;

function renderSettings() {
  document.getElementById('view-settings').innerHTML = `
    <div class="fade-up mt-2">

      <!-- Generateur IA -->
      <div class="bg-orange-50 rounded-2xl p-4 border border-orange-100">
        <p class="text-xs uppercase tracking-wider text-accent2 font-bold">Generer mes objectifs avec une IA</p>
        <h2 class="font-display text-xl font-bold mt-1 text-slate-900">Assistant de creation</h2>
        <p class="mt-1 text-sm text-slate-600">Pour <span class="font-semibold">n'importe quel objectif</span> : apprendre une langue, un instrument, le sport, une competence...</p>
        <ol class="mt-3 text-sm text-slate-600 space-y-1 list-decimal list-inside">
          <li>Copie le prompt ci-dessous.</li>
          <li>Colle-le dans une IA (ChatGPT, Claude, Gemini...).</li>
          <li>Reponds a ses questions.</li>
          <li>Telecharge le fichier <span class="font-mono text-accent2">mes-objectifs.json</span> qu'elle genere.</li>
          <li>Importe ce fichier juste en dessous.</li>
        </ol>
        <textarea id="aiPrompt" readonly rows="12"
          class="mt-3 w-full text-xs font-mono p-3 rounded-lg border border-orange-200 bg-white text-slate-700 leading-relaxed"></textarea>
        <button id="copyPromptBtn" class="mt-2 w-full py-3 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white font-semibold text-sm active:scale-95 transition-transform">
          Copier le prompt
        </button>
      </div>

      <!-- Import des objectifs -->
      <div class="mt-6 bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
        <p class="font-display font-semibold text-slate-900">Importer mes objectifs</p>
        <p class="text-xs text-slate-500 mt-1">
          Programme actuel :
          <span class="font-semibold ${customProgram ? 'text-accent2' : 'text-slate-600'}">${customProgram ? 'personnalise' : 'par defaut'}</span>
          · ${MISSIONS.length} jours
        </p>

        <input type="file" id="importFile" accept="application/json,.json" class="hidden" />
        <button id="pickFileBtn" class="mt-3 w-full py-3 rounded-xl bg-slate-800 text-white font-semibold text-sm active:scale-95 transition-transform">
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

      <p class="mt-6 text-center text-[11px] text-slate-400">Copilote de Parole · tes objectifs, ton rythme.</p>
    </div>
  `;

  document.getElementById('aiPrompt').value = AI_PROMPT;

  document.getElementById('copyPromptBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT);
      toast('Prompt copie ! Colle-le dans ton IA.');
    } catch (e) {
      // repli si clipboard indisponible
      const ta = document.getElementById('aiPrompt');
      ta.focus(); ta.select();
      toast('Selectionne et copie le texte (Ctrl/Cmd + C).');
    }
  });

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
  ['today', 'week', 'progress', 'settings'].forEach((t) => {
    document.getElementById('view-' + t).classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('text-accent2', active);
    b.classList.toggle('text-slate-400', !active);
  });
  if (tab === 'progress') renderProgress();
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
  const ls = loadLocalState();
  if (ls) state = ls;
  const lp = loadLocalProgram();
  if (lp) {
    try { customProgram = localStorage.getItem(LS_CUSTOM) === '1'; } catch (e) {}
    applyProgram(lp);
  }
  document.getElementById('loader').remove();
  renderToday();
  renderWeek();
  switchTab('today');
  updateSyncBadge();

  // 2) Synchronisation en arriere-plan si en ligne (envoie la file + recupere l'etat serveur)
  if (navigator.onLine) {
    if (queue.length) {
      await flushQueue();
    } else {
      try {
        const [data, program] = await Promise.all([apiGet(), loadProgram()]);
        state = data; saveLocalState();
        applyProgram(program); saveLocalProgram(program);
        renderAll();
      } catch (e) { /* hors-ligne : on garde le cache local */ }
    }
    updateSyncBadge();
  }

  // 3) Reagit aux changements de connexion
  window.addEventListener('online', () => { updateSyncBadge(); flushQueue(); });
  window.addEventListener('offline', updateSyncBadge);
}

init();
