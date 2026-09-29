import { getStore } from '@netlify/blobs';
import { createClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';

const STAFF_PIN = process.env.STAFF_PIN || '1842';
const STATE_KEY = 'state.json';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseClient;

const initialDb = () => ({
  bars: [{ id: 'millstone', name: process.env.BAR_NAME || 'Millstone Bar', currency: 'SEK', staffPin: STAFF_PIN }],
  tabs: {},
  invites: {},
  passes: {},
  purchases: {},
  idempotency: {},
  events: [],
});

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function token(prefix) {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

function now() {
  return new Date().toISOString();
}

function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function hasSupabase() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabase() {
  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}

async function loadDb() {
  if (hasSupabase()) {
    const { data, error } = await supabase()
      .from('barpass_state')
      .select('data')
      .eq('key', STATE_KEY)
      .maybeSingle();
    if (error) throw apiError(500, `Supabase kunde inte läsa state: ${error.message}`);
    return { ...initialDb(), ...(data?.data || {}) };
  }

  const store = getStore('barpass');
  const data = await store.get(STATE_KEY, { type: 'json' });
  return { ...initialDb(), ...(data || {}) };
}

async function saveDb(db) {
  if (hasSupabase()) {
    const { error } = await supabase()
      .from('barpass_state')
      .upsert({ key: STATE_KEY, data: db, updated_at: now() }, { onConflict: 'key' });
    if (error) throw apiError(500, `Supabase kunde inte spara state: ${error.message}`);
    return;
  }

  const store = getStore('barpass');
  await store.setJSON(STATE_KEY, db);
}

function event(db, type, actor, data) {
  db.events.unshift({ id: randomUUID(), type, actor, at: now(), data });
  db.events = db.events.slice(0, 300);
}

function fmt(amount) {
  return `${Number(amount || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
}

function passView(db, pass) {
  const tab = db.tabs[pass.tabId];
  const bar = db.bars.find((b) => b.id === tab?.barId);
  return {
    id: pass.id,
    token: pass.token,
    tabId: pass.tabId,
    label: pass.label,
    status: pass.status,
    createdAt: pass.createdAt,
    lastScannedAt: pass.lastScannedAt,
    groupName: tab?.groupName,
    barName: bar?.name,
  };
}

function tabSummary(db, tab) {
  const purchases = Object.values(db.purchases).filter((p) => p.tabId === tab.id && p.status === 'confirmed');
  const confirmed = Math.round(purchases.reduce((sum, p) => sum + Number(p.amount || 0), 0) * 100) / 100;
  const passes = Object.values(db.passes).filter((p) => p.tabId === tab.id);
  return {
    ...tab,
    totals: { confirmed, formatted: fmt(confirmed), count: purchases.length },
    passes: passes.map((p) => passView(db, p)),
    purchases: purchases.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
  };
}

function requireTab(db, id) {
  const tab = db.tabs[id];
  if (!tab) throw apiError(404, 'Notan finns inte');
  return tab;
}

function requireAdmin(tab, adminToken) {
  if (!adminToken || tab.adminToken !== adminToken) throw apiError(403, 'Adminlänk saknas eller är fel');
}

function requireStaff(pin) {
  if (pin !== STAFF_PIN) throw apiError(403, 'Fel personalkod');
}

function scanStatus(db, passToken) {
  const pass = Object.values(db.passes).find((p) => p.token === passToken || p.id === passToken);
  if (!pass) return { status: 'denied', color: 'red', reason: 'Passet finns inte.' };
  const tab = db.tabs[pass.tabId];
  const bar = db.bars.find((b) => b.id === tab?.barId);
  if (!tab) return { status: 'denied', color: 'red', reason: 'Notan finns inte längre.', pass: passView(db, pass) };
  if (pass.status !== 'active') return { status: pass.status, color: 'red', reason: 'Passet är spärrat.', pass: passView(db, pass), tab: tabSummary(db, tab) };
  if (tab.status === 'paused') return { status: 'paused', color: 'yellow', reason: 'Notan är pausad.', pass: passView(db, pass), tab: tabSummary(db, tab) };
  if (tab.status === 'closing' || tab.status === 'closed') return { status: tab.status, color: 'red', reason: 'Notan är stängd för nya köp.', pass: passView(db, pass), tab: tabSummary(db, tab) };
  if (tab.status !== 'active') return { status: tab.status, color: 'yellow', reason: 'Notan är inte aktiv.', pass: passView(db, pass), tab: tabSummary(db, tab) };
  return { status: 'active', color: 'green', reason: 'Köp kan registreras på gruppnotan.', pass: passView(db, pass), tab: tabSummary(db, tab), bar };
}

function cleanApiPath(url) {
  let path = url.pathname;
  path = path.replace(/^\/\.netlify\/functions\/api\/?/, '/api/');
  if (!path.startsWith('/api/')) path = `/api/${path.replace(/^\//, '')}`;
  return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/api';
}

async function bodyJson(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  const raw = await request.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw apiError(400, 'Ogiltig JSON'); }
}

async function handle(request) {
  const url = new URL(request.url);
  const path = cleanApiPath(url);
  const method = request.method;
  const db = await loadDb();
  const origin = url.origin;
  let dirty = false;

  const finish = async (status, data) => {
    if (dirty) await saveDb(db);
    return json(status, data);
  };

  if (method === 'GET' && path === '/api/bootstrap') {
    return finish(200, { bars: db.bars, staffPinHint: STAFF_PIN, roles: ['payer', 'guest', 'restaurant'] });
  }

  if (method === 'POST' && path === '/api/tabs') {
    const body = await bodyJson(request);
    const bar = db.bars.find((b) => b.id === (body.barId || 'millstone')) || db.bars[0];
    const groupName = String(body.groupName || '').trim();
    const contact = String(body.contact || '').trim();
    if (groupName.length < 2) throw apiError(400, 'Gruppnamn krävs');
    if (contact.length < 3) throw apiError(400, 'Kontakt krävs');
    const budget = body.budget ? Number(body.budget) : null;
    if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) throw apiError(400, 'Budget måste vara ett positivt belopp');
    const id = `tab_${Object.keys(db.tabs).length + 1842}`;
    const adminToken = token('adm');
    const inviteToken = token('inv');
    const tab = { id, barId: bar.id, groupName, contact, budget, currency: bar.currency, status: 'active', adminToken, inviteToken, createdAt: now(), budgetMode: 'preliminär informationsnivå' };
    db.tabs[id] = tab;
    db.invites[inviteToken] = { token: inviteToken, tabId: id, status: 'open', createdAt: now(), maxPasses: body.maxPasses ? Number(body.maxPasses) : null };
    event(db, 'tab.created', contact, { tabId: id, groupName });
    dirty = true;
    return finish(201, { tab: tabSummary(db, tab), adminUrl: `${origin}/#admin/${id}/${adminToken}`, inviteUrl: `${origin}/#invite/${inviteToken}`, staffUrl: `${origin}/#staff` });
  }

  const parts = path.split('/').filter(Boolean);

  if (method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'tabs') {
    const tab = requireTab(db, parts[2]);
    requireAdmin(tab, url.searchParams.get('adminToken'));
    return finish(200, { tab: tabSummary(db, tab), events: db.events.filter((e) => e.data?.tabId === tab.id).slice(0, 30) });
  }

  if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'tabs' && parts[3] === 'status') {
    const tab = requireTab(db, parts[2]);
    const body = await bodyJson(request);
    requireAdmin(tab, body.adminToken);
    const next = String(body.status || '');
    if (!['active', 'paused', 'closing', 'closed'].includes(next)) throw apiError(400, 'Ogiltig status');
    if (tab.status === 'closed' && next !== 'closed') throw apiError(409, 'Stängd nota kan inte återöppnas');
    tab.status = next;
    event(db, 'tab.status', 'admin', { tabId: tab.id, status: next });
    dirty = true;
    return finish(200, { tab: tabSummary(db, tab) });
  }

  if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'invitations' && parts[3] === 'pass') {
    const invite = db.invites[parts[2]];
    if (!invite || invite.status !== 'open') throw apiError(404, 'Inbjudan är stängd eller saknas');
    const tab = requireTab(db, invite.tabId);
    if (tab.status === 'closed' || tab.status === 'closing') throw apiError(409, 'Notan är stängd för nya pass');
    const body = await bodyJson(request);
    const deviceId = String(body.deviceId || '').trim();
    if (deviceId.length < 8) throw apiError(400, 'Enhets-ID saknas');
    const existing = Object.values(db.passes).find((p) => p.tabId === tab.id && p.deviceId === deviceId && p.status === 'active');
    if (existing) return finish(200, { pass: passView(db, existing), passUrl: `${origin}/#pass/${existing.token}` });
    const count = Object.values(db.passes).filter((p) => p.tabId === tab.id).length;
    if (invite.maxPasses && count >= invite.maxPasses) throw apiError(409, 'Max antal pass är utfärdade');
    const pass = { id: `pass_${count + 1}`, token: token('pass'), tabId: tab.id, deviceId, status: 'active', label: `Gäst ${count + 1}`, createdAt: now(), lastScannedAt: null };
    db.passes[pass.token] = pass;
    event(db, 'pass.issued', 'guest', { tabId: tab.id, passId: pass.id });
    dirty = true;
    return finish(201, { pass: passView(db, pass), passUrl: `${origin}/#pass/${pass.token}` });
  }

  if (method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'passes') {
    const pass = db.passes[parts[2]];
    if (!pass) throw apiError(404, 'Passet finns inte');
    return finish(200, { pass: passView(db, pass), scan: scanStatus(db, pass.token) });
  }

  if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'passes' && parts[3] === 'revoke') {
    const pass = db.passes[parts[2]];
    if (!pass) throw apiError(404, 'Passet finns inte');
    const tab = requireTab(db, pass.tabId);
    const body = await bodyJson(request);
    requireAdmin(tab, body.adminToken);
    pass.status = 'revoked';
    event(db, 'pass.revoked', 'admin', { tabId: tab.id, passId: pass.id });
    dirty = true;
    return finish(200, { pass: passView(db, pass) });
  }

  if (method === 'POST' && path === '/api/scan') {
    const body = await bodyJson(request);
    requireStaff(body.staffPin || STAFF_PIN);
    const passToken = String(body.passToken || '').trim().split('/').pop();
    const result = scanStatus(db, passToken);
    if (result.pass) {
      const pass = db.passes[result.pass.token];
      pass.lastScannedAt = now();
      event(db, 'pass.scanned', 'staff', { tabId: pass.tabId, passId: pass.id, status: result.status });
      dirty = true;
    }
    return finish(200, result);
  }

  if (method === 'POST' && path === '/api/purchases') {
    const body = await bodyJson(request);
    requireStaff(body.staffPin || STAFF_PIN);
    const key = String(body.idempotencyKey || '').trim();
    if (key && db.idempotency[key]) return finish(200, { purchase: db.purchases[db.idempotency[key]], duplicate: true });
    const passToken = String(body.passToken || '').trim().split('/').pop();
    const scan = scanStatus(db, passToken);
    if (scan.status !== 'active') throw apiError(409, scan.reason);
    const amount = Math.round(Number(body.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) throw apiError(400, 'Belopp måste vara positivt');
    const purchase = { id: randomUUID(), tabId: scan.tab.id, passId: scan.pass.id, passToken: scan.pass.token, amount, currency: scan.tab.currency, staffId: 'staff-demo', source: 'manual', status: 'confirmed', createdAt: now(), idempotencyKey: key || randomUUID(), note: 'Preliminärt saldo tills kassans avstämning är klar.' };
    db.purchases[purchase.id] = purchase;
    db.idempotency[purchase.idempotencyKey] = purchase.id;
    event(db, 'purchase.confirmed', 'staff', { tabId: purchase.tabId, passId: purchase.passId, amount });
    dirty = true;
    return finish(201, { purchase, tab: tabSummary(db, db.tabs[purchase.tabId]) });
  }

  if (method === 'GET' && path === '/api/staff/recent') {
    requireStaff(url.searchParams.get('staffPin') || STAFF_PIN);
    const tabs = Object.values(db.tabs).map((tab) => tabSummary(db, tab)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return finish(200, { tabs });
  }

  throw apiError(404, 'Hittar inte API-resursen');
}

export default async function handler(request) {
  try {
    return await handle(request);
  } catch (err) {
    return json(err.status || 500, { error: err.message || 'Serverfel' });
  }
}
