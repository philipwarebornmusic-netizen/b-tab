const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const state = { bars: [], lastScan: null, admin: null };

const routes = {
  start: () => renderStart(),
  admin: ([tabId, adminToken]) => renderAdmin(tabId, adminToken),
  invite: ([inviteToken]) => renderInvite(inviteToken),
  pass: ([passToken]) => renderPass(passToken),
  restaurant: () => renderRestaurant(),
  staff: () => renderStaff(),
};

function h(strings, ...values) {
  return strings.reduce((out, s, i) => out + s + (values[i] ?? ''), '');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function sek(value) {
  return `${Number(value || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Något gick fel');
  return json;
}

function notice(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

function deviceId() {
  let id = localStorage.getItem('barpass.deviceId');
  if (!id) {
    id = `dev_${crypto.randomUUID()}`;
    localStorage.setItem('barpass.deviceId', id);
  }
  return id;
}

function setView(html) {
  app.innerHTML = html;
  app.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    notice('Länken kopierad.');
  }));
}
function brandMark(extra = '') {
  return `<span class="brandmark ${extra}" aria-hidden="true"></span>`;
}


function top(title, right = '<a class="pill" href="#start">Start</a>') {
  return `<div class="topbar"><div class="logo">${brandMark('small inverse')}<span class="wordmark">${esc(title)}</span></div>${right}</div>`;
}

async function init() {
  const boot = await api('/api/bootstrap');
  state.bars = boot.bars;
  addEventListener('hashchange', route);
  route();
}

function route() {
  const [name = 'start', ...parts] = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  (routes[name] || routes.start)(parts);
}

function renderStart() {
  const barOptions = state.bars.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  setView(h`
    <section class="shell">
      <div class="hero">
        <div class="brand"><div class="logo">${brandMark()}<span class="wordmark">B·TAB</span></div><span class="pill"><span class="dot"></span>MVP · manuell POS</span></div>
        <div class="pass-kicker">01 / MIDNATT</div>
        <div class="rule"></div>
        <h1>Barpass</h1>
        <p>Öppna en aktiv gruppnota, dela individuella gästpass och låt personalen verifiera passet i baren. MVP:n har två huvudingångar: betalaren som äger notan och restaurangen som scannar pass.</p>
        <div class="cards grid">
          <a class="card role-card" href="#start"><h3>Kund / betalare</h3><p class="muted">Startar nota, delar inbjudan, spärrar pass och stänger.</p></a>
          <a class="card role-card" href="#restaurant"><h3>Restaurang</h3><p class="muted">Öppnar personalvy, scannar pass och registrerar köp.</p></a>
          <div class="card"><h3>Gäst</h3><p class="muted">Får ett eget digitalt pass. Ingen app, inget konto.</p></div>
        </div>
        <div class="swatches">
          <span class="swatch"><i style="background:#07131f"></i>Midnattsblå</span>
          <span class="swatch"><i style="background:linear-gradient(135deg,#ead399,#c39a48)"></i>Mässing</span>
          <span class="swatch"><i style="background:#8fd0aa"></i>Mint</span>
          <span class="swatch"><i style="background:#263644"></i>Skiffer</span>
        </div>
      </div>
      <form id="startForm" class="card form">
        <h2>Starta nota</h2>
        <label>Bar<select name="barId">${barOptions}</select></label>
        <label>Gruppnamn<input name="groupName" required minlength="2" placeholder="MILLSTONE · Företagskväll"></label>
        <label>Kontakt / betalningsansvarig<input name="contact" required minlength="3" placeholder="namn@företag.se eller telefon"></label>
        <label>Budget, frivillig<input name="budget" inputmode="decimal" placeholder="5000"></label>
        <label>Max antal pass, frivilligt<input name="maxPasses" inputmode="numeric" placeholder="25"></label>
        <p class="muted small">Budgeten är preliminär tills en riktig kassa eller betalpartner reserverar köp atomiskt.</p>
        <button>Öppna aktiv nota</button>
        <a class="pill" href="#restaurant">Öppna restaurangvy</a>
      </form>
    </section>`);
  document.querySelector('#startForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const created = await api('/api/tabs', { method: 'POST', body: JSON.stringify(data) });
    sessionStorage.setItem('barpass.lastAdmin', created.adminUrl);
    location.href = created.adminUrl;
  });
}

async function renderAdmin(tabId, adminToken) {
  const data = await api(`/api/tabs/${tabId}?adminToken=${encodeURIComponent(adminToken)}`);
  const tab = data.tab;
  const origin = location.origin;
  const inviteUrl = `${origin}/#invite/${tab.inviteToken}`;
  const rows = tab.passes.map((p) => `<div class="row"><div><b>${esc(p.label)}</b><div class="muted small">${esc(p.status)} · ${esc(p.id)}</div></div><button class="danger" data-revoke="${esc(p.token)}" ${p.status !== 'active' ? 'disabled' : ''}>Spärra</button></div>`).join('') || '<p class="muted">Inga pass utfärdade ännu.</p>';
  const purchases = tab.purchases.map((p) => `<div class="row"><div><b>${sek(p.amount)}</b><div class="muted small">${new Date(p.createdAt).toLocaleTimeString('sv-SE')} · ${esc(p.passId)}</div></div><span class="pill">${esc(p.source)}</span></div>`).join('') || '<p class="muted">Inga köp registrerade.</p>';
  const events = data.events.map((e) => `<div class="row"><div><b>${esc(e.type)}</b><div class="muted small">${new Date(e.at).toLocaleString('sv-SE')}</div></div></div>`).join('');
  setView(h`${top(tab.groupName)}
    <section class="screen two">
      <div class="grid">
        <div class="status ${tab.status === 'active' ? 'green' : tab.status === 'paused' ? 'yellow' : 'red'}"><div class="bigStatus">${esc(tab.status.toUpperCase())}</div><p>${esc(tab.barId)} · Nota ${esc(tab.id)}</p></div>
        <div class="card"><h2>Saldo</h2><div class="money">${esc(tab.totals.formatted)}</div><p class="muted">${tab.budget ? `Budget ${sek(tab.budget)} · ${esc(tab.budgetMode)}` : 'Ingen budget satt. Manuellt saldo är preliminärt.'}</p></div>
        <div class="card form"><h2>Dela inbjudan</h2><div class="copyBox">${esc(inviteUrl)}</div><button data-copy="${esc(inviteUrl)}" type="button">Kopiera inbjudningslänk</button></div>
        <div class="card"><h2>Status</h2><div class="actions"><button class="good" data-status="active">Aktivera</button><button class="warn" data-status="paused">Pausa</button><button class="danger" data-status="closed">Stäng nota</button></div></div>
      </div>
      <div class="grid">
        <div class="card"><h2>Pass</h2><div class="list">${rows}</div></div>
        <div class="card"><h2>Köp</h2><div class="list">${purchases}</div></div>
        <div class="card"><h2>Händelser</h2><div class="list">${events}</div></div>
      </div>
    </section>`);
  document.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/tabs/${tabId}/status`, { method: 'POST', body: JSON.stringify({ adminToken, status: button.dataset.status }) });
    notice('Status uppdaterad.');
    renderAdmin(tabId, adminToken);
  }));
  document.querySelectorAll('[data-revoke]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/passes/${button.dataset.revoke}/revoke`, { method: 'POST', body: JSON.stringify({ adminToken }) });
    notice('Pass spärrat.');
    renderAdmin(tabId, adminToken);
  }));
}

async function renderInvite(inviteToken) {
  setView(`${top('B·TAB')}<section class="pass-stage"><div class="pass-kicker">Inbjudan</div><h1 class="pass-title">Barpass</h1><div class="card"><h2>Hämta ditt gästpass</h2><p class="muted">Den här länken skapar ett separat pass för den här enheten. Samma telefon får tillbaka samma aktiva pass.</p><button id="claim">Skapa mitt pass</button></div></section>`);
  document.querySelector('#claim').addEventListener('click', async () => {
    const out = await api(`/api/invitations/${inviteToken}/pass`, { method: 'POST', body: JSON.stringify({ deviceId: deviceId() }) });
    location.href = out.passUrl;
  });
}

function qrBits(text) {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  let html = '';
  for (let i = 0; i < 289; i++) {
    const finder = (x, y) => (x < 7 && y < 7) || (x > 9 && y < 7) || (x < 7 && y > 9);
    const x = i % 17, y = Math.floor(i / 17);
    seed = (seed * 1664525 + 1013904223) >>> 0;
    html += `<i class="${finder(x, y) || (seed & 3) === 0 ? '' : 'off'}"></i>`;
  }
  return html;
}

async function renderPass(passToken) {
  const data = await api(`/api/passes/${passToken}`);
  const pass = data.pass;
  const scan = data.scan;
  const passUrl = `${location.origin}/#pass/${pass.token}`;
  const active = scan.status === 'active';
  setView(h`${top('B·TAB', '<span class="pill"><span class="dot"></span>Visa i baren</span>')}
    <section class="pass-stage">
      <div class="pass-kicker">01 / MIDNATT</div>
      <div class="rule"></div>
      <h1 class="pass-title">Barpass</h1>
      <div class="phone-shell">
        <div class="phone-status"><span>9:41</span><span>●●●  Wi‑Fi  ▰</span></div>
        <div class="ticket">
          <h2>Gästpass</h2>
          <div class="qr"><div class="qrgrid" aria-label="Visuell QR-markering">${qrBits(pass.token)}</div></div>
          <div class="ticket-cta"><span>Visa i baren</span><span>→</span></div>
        </div>
        <div class="pass-state"><span class="status-dot" style="background:${active ? 'var(--mint)' : scan.color === 'yellow' ? 'var(--yellow)' : 'var(--red)'}"></span><b>${active ? 'Aktiv' : esc(scan.status)}</b></div>
        <div class="balance-card">
          <div class="row"><div><b>Barpass</b><div class="muted">Gruppnota · ${esc(pass.groupName || 'PASS')}</div></div><div class="amount">${scan.tab ? esc(scan.tab.totals.formatted).replace('SEK', 'kr') : '—'}</div></div>
          <div class="progress"><i></i></div>
        </div>
      </div>
      <div class="card"><p class="muted">${esc(pass.barName || '')} · ${esc(scan.reason)}</p><p class="muted">Skanningskod</p><div class="copyBox tabular">${esc(pass.token)}</div><div class="actions"><button data-copy="${esc(passUrl)}">Kopiera passlänk</button><button class="secondary" id="refresh">Uppdatera status</button></div></div>
      <p class="muted small">Om du tappar telefonen: kontakta personen som öppnade notan så spärras passet.</p>
    </section>`);
  document.querySelector('#refresh').addEventListener('click', () => renderPass(passToken));
}

function renderRestaurant() {
  const barName = state.bars[0]?.name || 'Restaurang';
  setView(h`${top('Restaurang', '<a class="pill" href="#start">Kundvy</a>')}
    <section class="screen two">
      <div class="hero">
        <div class="brand"><div class="logo">${brandMark()}<span class="wordmark">B·TAB</span></div><span class="pill"><span class="dot"></span>${esc(barName)}</span></div>
        <div class="pass-kicker">Restaurangläge</div>
        <div class="rule"></div>
        <h1>Barvy</h1>
        <p>Restaurangen behöver en enkel personalingång: scanna gästpass, se aktuell status online och registrera köp på rätt gruppnota. I skarp pilot ersätts manuell registrering av POS-adapter.</p>
      </div>
      <div class="grid">
        <div class="card"><h2>Personal</h2><p class="muted">Använd scannerläget i baren. Demo-personalkod är <span class="kbd">1842</span>.</p><div class="actions"><a class="pill" href="#staff">Öppna scanner</a></div></div>
        <div class="card"><h2>Stationär QR</h2><p class="muted">I pilot kan baren visa kundstarten som stationär QR vid entré/bord. Betalaren öppnar notan från sin telefon.</p><div class="copyBox">${esc(location.origin)}#start</div></div>
        <div class="card"><h2>Roller</h2><div class="row"><span>Kund</span><b>äger notan</b></div><div class="row"><span>Gäst</span><b>visar pass</b></div><div class="row"><span>Restaurang</span><b>scannar</b></div></div>
      </div>
    </section>`);
}

async function renderStaff() {
  const recent = await api('/api/staff/recent');
  const quick = recent.tabs.flatMap((t) => t.passes.filter((p) => p.status === 'active').map((p) => `<button class="secondary" data-token="${esc(p.token)}">${esc(t.groupName)} · ${esc(p.label)}</button>`)).join('');
  setView(h`${top('Personalvy')}
    <section class="screen two">
      <form id="scanForm" class="card form"><h2>Skanna pass</h2><label>Personalkod<input name="staffPin" value="1842" inputmode="numeric"></label><label>Passlänk eller kod<input name="passToken" required placeholder="pass_..."></label><button>Kontrollera online</button><p class="muted small">Vid nätavbrott ska pass inte godkännas automatiskt.</p><div class="actions">${quick}</div></form>
      <div id="scanResult" class="grid"><div class="card"><h2>Resultat</h2><p class="muted">Skanna ett pass för status.</p></div></div>
    </section>`);
  const form = document.querySelector('#scanForm');
  document.querySelectorAll('[data-token]').forEach((b) => b.addEventListener('click', () => { form.passToken.value = b.dataset.token; form.requestSubmit(); }));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const result = await api('/api/scan', { method: 'POST', body: JSON.stringify(data) });
    state.lastScan = { ...result, staffPin: data.staffPin, passToken: data.passToken.split('/').pop() };
    drawScan();
  });
}

function drawScan() {
  const r = state.lastScan;
  const target = document.querySelector('#scanResult');
  const ok = r.status === 'active';
  target.innerHTML = h`<div class="status ${r.color}"><div class="bigStatus">${ok ? 'AKTIV' : esc(r.status.toUpperCase())}</div><p>${esc(r.reason)}</p></div>
    ${r.tab ? `<div class="card"><h2>${esc(r.tab.groupName)}</h2><div class="row"><span>Nota</span><b>${esc(r.tab.id)}</b></div><div class="row"><span>Saldo</span><b>${esc(r.tab.totals.formatted)}</b></div><div class="row"><span>Pass</span><b>${esc(r.pass.label)}</b></div></div>` : ''}
    ${ok ? `<form id="buyForm" class="card form"><h2>Registrera köp</h2><label>Belopp<input name="amount" inputmode="decimal" required placeholder="129"></label><input type="hidden" name="idempotencyKey" value="buy_${crypto.randomUUID()}"><button class="good">Bekräfta köp</button></form>` : ''}`;
  const buy = document.querySelector('#buyForm');
  if (buy) buy.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = { ...Object.fromEntries(new FormData(buy)), staffPin: r.staffPin, passToken: r.passToken };
    const out = await api('/api/purchases', { method: 'POST', body: JSON.stringify(body) });
    notice(out.duplicate ? 'Dublett ignorerad.' : 'Köp registrerat.');
    state.lastScan.tab = out.tab;
    buy.querySelector('button').disabled = true;
    buy.insertAdjacentHTML('beforeend', `<p class="muted">Kvittens: ${sek(out.purchase.amount)} · ${esc(out.purchase.id.slice(0, 8))}</p>`);
  });
}

init().catch((err) => setView(`<div class="card"><h1>Fel</h1><p>${esc(err.message)}</p></div>`));
