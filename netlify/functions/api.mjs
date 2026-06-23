import { getStore } from '@netlify/blobs';

/**
 * API REST CRUD du Copilote de Parole, en Netlify Function (v2).
 * Persistance : Netlify Blobs (store "copilote", cle "state").
 *
 *   GET    /api/data                 -> Read   : etat complet
 *   PUT    /api/data                 -> Update : remplace l'etat (reset)
 *   POST   /api/progress             -> Create : { date, task } coche une tache
 *   DELETE /api/progress/:date/:task -> Delete : decoche une tache
 *   POST   /api/completions          -> Create : { date } journee accomplie
 *   DELETE /api/completions/:date     -> Delete : annule la journee
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE = 'copilote';
const KEY = 'state';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function defaultData() {
  return { version: 2, startDate: todayISO(), completions: [], progress: {} };
}

function normalize(d) {
  if (!d || typeof d !== 'object') return defaultData();
  if (!Array.isArray(d.completions)) d.completions = [];
  if (!d.progress || typeof d.progress !== 'object') d.progress = {};
  if (!d.startDate) d.startDate = todayISO();
  d.version = 2;
  return d;
}

async function loadData(store) {
  const d = await store.get(KEY, { type: 'json' });
  if (!d) {
    const def = defaultData();
    await store.setJSON(KEY, def);
    return def;
  }
  return normalize(d);
}

async function saveData(store, data) {
  await store.setJSON(KEY, data);
}

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: HEADERS });
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: HEADERS });
  }

  const store = getStore(STORE);
  const url = new URL(req.url);
  const pathname = url.pathname; // ex: /api/data
  const method = req.method;

  let body = {};
  if (method === 'POST' || method === 'PUT') {
    try { body = await req.json(); }
    catch (e) { return json(400, { error: 'JSON invalide.' }); }
  }

  try {
    // GET /api/data
    if (method === 'GET' && pathname === '/api/data') {
      return json(200, await loadData(store));
    }

    // PUT /api/data — reset / remplacement complet
    if (method === 'PUT' && pathname === '/api/data') {
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
        progress
      };
      await saveData(store, next);
      return json(200, next);
    }

    // POST /api/progress — coche une tache
    if (method === 'POST' && pathname === '/api/progress') {
      const { date, task } = body;
      if (!date || !DATE_RE.test(date)) return json(400, { error: 'Champ "date" requis (AAAA-MM-JJ).' });
      if (!Number.isInteger(task) || task < 0) return json(400, { error: 'Champ "task" requis (entier >= 0).' });
      const data = await loadData(store);
      if (!Array.isArray(data.progress[date])) data.progress[date] = [];
      if (!data.progress[date].includes(task)) {
        data.progress[date].push(task);
        data.progress[date].sort((a, b) => a - b);
        await saveData(store, data);
      }
      return json(201, data);
    }

    // DELETE /api/progress/:date/:task — decoche une tache
    if (method === 'DELETE' && pathname.startsWith('/api/progress/')) {
      const parts = pathname.slice('/api/progress/'.length).split('/');
      const date = decodeURIComponent(parts[0] || '');
      const task = Number(parts[1]);
      if (!DATE_RE.test(date) || !Number.isInteger(task)) {
        return json(400, { error: 'Format : /api/progress/AAAA-MM-JJ/<index>.' });
      }
      const data = await loadData(store);
      const arr = data.progress[date] || [];
      const idx = arr.indexOf(task);
      if (idx === -1) return json(404, { error: 'Tache non cochee.' });
      arr.splice(idx, 1);
      if (arr.length === 0) delete data.progress[date];
      await saveData(store, data);
      return json(200, data);
    }

    // POST /api/completions — journee accomplie
    if (method === 'POST' && pathname === '/api/completions') {
      const { date } = body;
      if (!date || !DATE_RE.test(date)) return json(400, { error: 'Champ "date" requis (AAAA-MM-JJ).' });
      const data = await loadData(store);
      if (!data.completions.includes(date)) {
        data.completions.push(date);
        data.completions.sort();
        await saveData(store, data);
      }
      return json(201, data);
    }

    // DELETE /api/completions/:date — annule la journee
    if (method === 'DELETE' && pathname.startsWith('/api/completions/')) {
      const date = decodeURIComponent(pathname.slice('/api/completions/'.length));
      if (!DATE_RE.test(date)) return json(400, { error: 'Date invalide (AAAA-MM-JJ).' });
      const data = await loadData(store);
      const idx = data.completions.indexOf(date);
      if (idx === -1) return json(404, { error: 'Aucune validation pour cette date.' });
      data.completions.splice(idx, 1);
      await saveData(store, data);
      return json(200, data);
    }

    return json(404, { error: 'Route API inconnue.' });
  } catch (e) {
    return json(500, { error: 'Erreur serveur : ' + e.message });
  }
};

export const config = {
  path: '/api/*'
};
