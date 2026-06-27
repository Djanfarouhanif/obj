'use strict';

/**
 * Copilote de Parole — mini-serveur Node.js (modules natifs uniquement).
 * - Sert les fichiers statiques de /public
 * - Expose une API REST CRUD lisant/ecrivant data.json (source de verite)
 *
 * Modele de donnees (v2) :
 *   {
 *     "version": 2,
 *     "startDate": "AAAA-MM-JJ",
 *     "completions": ["AAAA-MM-JJ"],         // journees ENTIEREMENT accomplies (unite de score)
 *     "progress": { "AAAA-MM-JJ": [0,1,2] }  // taches cochees par jour (checklist)
 *   }
 *
 * API :
 *   GET    /api/data                       -> Read   : renvoie tout l'etat
 *   POST   /api/progress                   -> Create : body { date, task } -> coche une tache
 *   DELETE /api/progress/:date/:task       -> Delete : decoche une tache
 *   POST   /api/completions                -> Create : body { date } -> marque la journee accomplie
 *   DELETE /api/completions/:date          -> Delete : annule la validation d'une journee
 *   PUT    /api/data                       -> Update : remplace l'etat complet (reset)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'data.json');
const CUSTOM_PROGRAM_FILE = path.join(__dirname, 'custom-program.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validProgram(p) {
  if (!p || typeof p !== 'object') return false;
  if (!Array.isArray(p.missions) || p.missions.length === 0) return false;
  return p.missions.every((m) =>
    m && typeof m.titre === 'string' &&
    Array.isArray(m.tasks) && m.tasks.length > 0 &&
    m.tasks.every((t) => typeof t === 'string')
  );
}

function sanitizeProgram(p) {
  return {
    themes: (p.themes && typeof p.themes === 'object') ? p.themes : {},
    citations: Array.isArray(p.citations) ? p.citations.filter((c) => typeof c === 'string') : [],
    missions: p.missions.map((m) => ({
      titre: String(m.titre),
      phase: typeof m.phase === 'string' ? m.phase : '',
      tasks: m.tasks.map((t) => String(t))
    }))
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

// ---------------------------------------------------------------------------
// Helpers data.json
// ---------------------------------------------------------------------------

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultData() {
  return { version: 2, startDate: todayISO(), completions: [], progress: {}, phrases: [], ideas: [] };
}

function normalizePhrases(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === 'object' && p.id != null)
    .map((p) => ({
      id: String(p.id),
      text: String(p.text || '').slice(0, 1000),
      reads: (p.reads && typeof p.reads === 'object') ? p.reads : {}
    }));
}

function normalizeIdeas(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x === 'object' && x.id != null)
    .map((x) => ({
      id: String(x.id),
      text: String(x.text || '').slice(0, 2000),
      pct: Math.max(0, Math.min(100, Math.round(Number(x.pct) || 0))),
      createdAt: x.createdAt ? String(x.createdAt) : ''
    }));
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('format invalide');
    if (!Array.isArray(data.completions)) data.completions = [];
    if (!data.progress || typeof data.progress !== 'object') data.progress = {};
    data.phrases = normalizePhrases(data.phrases);
    data.ideas = normalizeIdeas(data.ideas);
    if (!data.startDate) data.startDate = todayISO();
    data.version = 2;
    return data;
  } catch (e) {
    const d = defaultData();
    writeData(d);
    return d;
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('payload trop volumineux'));
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Routage API
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  // GET /api/data — Read
  if (req.method === 'GET' && pathname === '/api/data') {
    return sendJSON(res, 200, readData());
  }

  // GET /api/program — programme personnalise (404 => defaut statique)
  if (req.method === 'GET' && pathname === '/api/program') {
    try {
      const raw = fs.readFileSync(CUSTOM_PROGRAM_FILE, 'utf8');
      return sendJSON(res, 200, JSON.parse(raw));
    } catch (e) {
      return sendJSON(res, 404, { error: 'Aucun programme personnalise.' });
    }
  }

  // PUT /api/program — importe / remplace les objectifs
  if (req.method === 'PUT' && pathname === '/api/program') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    if (!validProgram(body)) {
      return sendJSON(res, 400, { error: 'JSON invalide : il faut un tableau "missions" avec { titre, tasks: [..] }.' });
    }
    const clean = sanitizeProgram(body);
    fs.writeFileSync(CUSTOM_PROGRAM_FILE, JSON.stringify(clean, null, 2), 'utf8');
    return sendJSON(res, 200, clean);
  }

  // DELETE /api/program — revient au programme par defaut
  if (req.method === 'DELETE' && pathname === '/api/program') {
    try { fs.unlinkSync(CUSTOM_PROGRAM_FILE); } catch (e) {}
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/progress — coche une tache
  if (req.method === 'POST' && pathname === '/api/progress') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    const date = body && body.date;
    const task = body && body.task;
    if (!date || !DATE_RE.test(date)) {
      return sendJSON(res, 400, { error: 'Champ "date" requis au format AAAA-MM-JJ.' });
    }
    if (!Number.isInteger(task) || task < 0) {
      return sendJSON(res, 400, { error: 'Champ "task" requis (entier >= 0).' });
    }
    const data = readData();
    if (!Array.isArray(data.progress[date])) data.progress[date] = [];
    if (!data.progress[date].includes(task)) {
      data.progress[date].push(task);
      data.progress[date].sort((a, b) => a - b);
      writeData(data);
    }
    return sendJSON(res, 201, data);
  }

  // DELETE /api/progress/:date/:task — decoche une tache
  if (req.method === 'DELETE' && pathname.startsWith('/api/progress/')) {
    const parts = pathname.slice('/api/progress/'.length).split('/');
    const date = decodeURIComponent(parts[0] || '');
    const task = Number(parts[1]);
    if (!DATE_RE.test(date) || !Number.isInteger(task)) {
      return sendJSON(res, 400, { error: 'Format attendu : /api/progress/AAAA-MM-JJ/<index>.' });
    }
    const data = readData();
    const arr = data.progress[date] || [];
    const idx = arr.indexOf(task);
    if (idx === -1) {
      return sendJSON(res, 404, { error: 'Tache non cochee.' });
    }
    arr.splice(idx, 1);
    if (arr.length === 0) delete data.progress[date];
    writeData(data);
    return sendJSON(res, 200, data);
  }

  // POST /api/completions — marque la journee accomplie
  if (req.method === 'POST' && pathname === '/api/completions') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    const date = body && body.date;
    if (!date || !DATE_RE.test(date)) {
      return sendJSON(res, 400, { error: 'Champ "date" requis au format AAAA-MM-JJ.' });
    }
    const data = readData();
    if (!data.completions.includes(date)) {
      data.completions.push(date);
      data.completions.sort();
      writeData(data);
    }
    return sendJSON(res, 201, data);
  }

  // DELETE /api/completions/:date — annule la validation d'une journee
  if (req.method === 'DELETE' && pathname.startsWith('/api/completions/')) {
    const date = decodeURIComponent(pathname.slice('/api/completions/'.length));
    if (!DATE_RE.test(date)) {
      return sendJSON(res, 400, { error: 'Date invalide (AAAA-MM-JJ attendu).' });
    }
    const data = readData();
    const idx = data.completions.indexOf(date);
    if (idx === -1) {
      return sendJSON(res, 404, { error: 'Aucune validation trouvee pour cette date.' });
    }
    data.completions.splice(idx, 1);
    writeData(data);
    return sendJSON(res, 200, data);
  }

  // PUT /api/data — Update / Reset
  if (req.method === 'PUT' && pathname === '/api/data') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    const progress = {};
    if (body.progress && typeof body.progress === 'object') {
      for (const k of Object.keys(body.progress)) {
        if (DATE_RE.test(k) && Array.isArray(body.progress[k])) {
          progress[k] = body.progress[k].filter((n) => Number.isInteger(n) && n >= 0);
        }
      }
    }
    const next = {
      version: 2,
      startDate: DATE_RE.test(body.startDate) ? body.startDate : todayISO(),
      completions: Array.isArray(body.completions)
        ? body.completions.filter((d) => DATE_RE.test(d)).sort()
        : [],
      progress,
      phrases: normalizePhrases(body.phrases),
      ideas: normalizeIdeas(body.ideas)
    };
    writeData(next);
    return sendJSON(res, 200, next);
  }

  // POST /api/phrases — ajoute une phrase/citation
  if (req.method === 'POST' && pathname === '/api/phrases') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    const text = (body && body.text != null) ? String(body.text).trim() : '';
    if (!text) return sendJSON(res, 400, { error: 'Champ "text" requis.' });
    const id = (body && body.id) ? String(body.id) : ('p' + Date.now());
    const data = readData();
    if (!data.phrases.some((p) => p.id === id)) {
      data.phrases.push({ id, text: text.slice(0, 1000), reads: {} });
      writeData(data);
    }
    return sendJSON(res, 201, data);
  }

  // POST /api/phrases/:id/read — enregistre une lecture (body { date })
  if (req.method === 'POST' && /^\/api\/phrases\/[^/]+\/read$/.test(pathname)) {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    const id = decodeURIComponent(pathname.split('/')[3]);
    const date = (body && body.date) || todayISO();
    if (!DATE_RE.test(date)) return sendJSON(res, 400, { error: 'Date invalide.' });
    const data = readData();
    const phrase = data.phrases.find((p) => p.id === id);
    if (!phrase) return sendJSON(res, 404, { error: 'Phrase introuvable.' });
    phrase.reads[date] = (phrase.reads[date] || 0) + 1;
    writeData(data);
    return sendJSON(res, 200, data);
  }

  // DELETE /api/phrases/:id — supprime une phrase
  if (req.method === 'DELETE' && pathname.startsWith('/api/phrases/')) {
    const id = decodeURIComponent(pathname.slice('/api/phrases/'.length));
    const data = readData();
    const idx = data.phrases.findIndex((p) => p.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'Phrase introuvable.' });
    data.phrases.splice(idx, 1);
    writeData(data);
    return sendJSON(res, 200, data);
  }

  // POST /api/ideas — ajoute une idee/note
  if (req.method === 'POST' && pathname === '/api/ideas') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    const text = (body && body.text != null) ? String(body.text).trim() : '';
    if (!text) return sendJSON(res, 400, { error: 'Champ "text" requis.' });
    const id = (body && body.id) ? String(body.id) : ('i' + Date.now());
    const data = readData();
    if (!data.ideas.some((x) => x.id === id)) {
      data.ideas.push({ id, text: text.slice(0, 2000), pct: 0, createdAt: (body && body.createdAt) ? String(body.createdAt) : new Date().toISOString() });
      writeData(data);
    }
    return sendJSON(res, 201, data);
  }

  // PUT /api/ideas/:id — met a jour une idee (pct et/ou texte)
  if (req.method === 'PUT' && pathname.startsWith('/api/ideas/')) {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    const id = decodeURIComponent(pathname.slice('/api/ideas/'.length));
    const data = readData();
    const idea = data.ideas.find((x) => x.id === id);
    if (!idea) return sendJSON(res, 404, { error: 'Idee introuvable.' });
    if (body.pct != null) idea.pct = Math.max(0, Math.min(100, Math.round(Number(body.pct) || 0)));
    if (typeof body.text === 'string') idea.text = body.text.slice(0, 2000);
    writeData(data);
    return sendJSON(res, 200, data);
  }

  // DELETE /api/ideas/:id — supprime une idee
  if (req.method === 'DELETE' && pathname.startsWith('/api/ideas/')) {
    const id = decodeURIComponent(pathname.slice('/api/ideas/'.length));
    const data = readData();
    const idx = data.ideas.findIndex((x) => x.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'Idee introuvable.' });
    data.ideas.splice(idx, 1);
    writeData(data);
    return sendJSON(res, 200, data);
  }

  return sendJSON(res, 404, { error: 'Route API inconnue.' });
}

// ---------------------------------------------------------------------------
// Fichiers statiques
// ---------------------------------------------------------------------------

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJSON(res, 403, { error: 'Acces refuse.' });
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      return sendJSON(res, 404, { error: 'Fichier introuvable.' });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const pathname = decodeURI(req.url.split('?')[0]);

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      sendJSON(res, 500, { error: 'Erreur serveur : ' + e.message });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

if (!fs.existsSync(DATA_FILE)) {
  writeData(defaultData());
  console.log('data.json cree avec une structure par defaut.');
}

server.listen(PORT, HOST, () => {
  console.log('🎤  Copilote de Parole demarre.');
  console.log('    Local   : http://localhost:' + PORT);
  console.log('    Reseau  : http://<IP-locale-de-votre-PC>:' + PORT);
});
