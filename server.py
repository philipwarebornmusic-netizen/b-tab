#!/usr/bin/env python3
from __future__ import annotations

import json, os, secrets, uuid
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'
DB_FILE = ROOT / 'barpass.db.json'
PORT = int(os.environ.get('PORT', '4173'))
STAFF_PIN = os.environ.get('STAFF_PIN', '1842')


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def initial_db():
    return {
        'bars': [{'id': 'millstone', 'name': 'Millstone Bar', 'currency': 'SEK', 'staffPin': STAFF_PIN}],
        'tabs': {}, 'invites': {}, 'passes': {}, 'purchases': {}, 'idempotency': {}, 'events': []
    }


def load_db():
    if not DB_FILE.exists():
        return initial_db()
    data = json.loads(DB_FILE.read_text())
    base = initial_db(); base.update(data); return base


db = load_db()


def persist():
    DB_FILE.write_text(json.dumps(db, ensure_ascii=False, indent=2))


def make_token(prefix):
    return f"{prefix}_{secrets.token_urlsafe(18)}"


def event(kind, actor, data):
    db['events'].insert(0, {'id': str(uuid.uuid4()), 'type': kind, 'actor': actor, 'at': now(), 'data': data})
    del db['events'][300:]


def fmt_money(amount):
    return f"{amount:,.2f}".replace(',', ' ').replace('.', ',')


def pass_view(pass_):
    tab = db['tabs'].get(pass_['tabId'])
    bar = next((b for b in db['bars'] if b['id'] == tab.get('barId')), None) if tab else None
    return {k: pass_.get(k) for k in ['id', 'token', 'tabId', 'label', 'status', 'createdAt', 'lastScannedAt']} | {
        'groupName': tab.get('groupName') if tab else None,
        'barName': bar.get('name') if bar else None,
    }


def tab_summary(tab):
    purchases = [p for p in db['purchases'].values() if p['tabId'] == tab['id'] and p['status'] == 'confirmed']
    total = round(sum(float(p['amount']) for p in purchases), 2)
    passes = [p for p in db['passes'].values() if p['tabId'] == tab['id']]
    return dict(tab) | {
        'totals': {'confirmed': total, 'formatted': f"{fmt_money(total)} {tab['currency']}", 'count': len(purchases)},
        'passes': [pass_view(p) for p in passes],
        'purchases': sorted(purchases, key=lambda p: p['createdAt'], reverse=True)[:20],
    }


def require_tab(tab_id):
    tab = db['tabs'].get(tab_id)
    if not tab: raise ApiError(404, 'Notan finns inte')
    return tab


def require_admin(tab, admin_token):
    if not admin_token or tab.get('adminToken') != admin_token:
        raise ApiError(403, 'Adminlänk saknas eller är fel')


def require_staff(pin):
    if pin != STAFF_PIN: raise ApiError(403, 'Fel personalkod')


def scan_status(pass_token):
    pass_ = next((p for p in db['passes'].values() if p['token'] == pass_token or p['id'] == pass_token), None)
    if not pass_: return {'status': 'denied', 'color': 'red', 'reason': 'Passet finns inte.'}
    tab = db['tabs'].get(pass_['tabId'])
    bar = next((b for b in db['bars'] if b['id'] == tab.get('barId')), None) if tab else None
    if not tab: return {'status': 'denied', 'color': 'red', 'reason': 'Notan finns inte längre.', 'pass': pass_view(pass_)}
    if pass_['status'] != 'active': return {'status': pass_['status'], 'color': 'red', 'reason': 'Passet är spärrat.', 'pass': pass_view(pass_), 'tab': tab_summary(tab)}
    if tab['status'] == 'paused': return {'status': 'paused', 'color': 'yellow', 'reason': 'Notan är pausad.', 'pass': pass_view(pass_), 'tab': tab_summary(tab)}
    if tab['status'] in ('closing', 'closed'): return {'status': tab['status'], 'color': 'red', 'reason': 'Notan är stängd för nya köp.', 'pass': pass_view(pass_), 'tab': tab_summary(tab)}
    if tab['status'] != 'active': return {'status': tab['status'], 'color': 'yellow', 'reason': 'Notan är inte aktiv.', 'pass': pass_view(pass_), 'tab': tab_summary(tab)}
    return {'status': 'active', 'color': 'green', 'reason': 'Köp kan registreras på gruppnotan.', 'pass': pass_view(pass_), 'tab': tab_summary(tab), 'bar': bar}


class ApiError(Exception):
    def __init__(self, status, message): self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    server_version = 'Barpass/0.1'

    def log_message(self, fmt, *args):
        print(fmt % args)

    def origin(self):
        return f"http://{self.headers.get('host')}"

    def json_body(self):
        n = int(self.headers.get('content-length', '0') or 0)
        if n > 1_000_000: raise ApiError(413, 'För stor begäran')
        raw = self.rfile.read(n) if n else b'{}'
        try: return json.loads(raw.decode('utf-8') or '{}')
        except json.JSONDecodeError: raise ApiError(400, 'Ogiltig JSON')

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status); self.send_header('content-type', 'application/json; charset=utf-8'); self.send_header('cache-control', 'no-store'); self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def send_error_json(self, err):
        self.send_json(getattr(err, 'status', 500), {'error': getattr(err, 'message', str(err))})

    def do_GET(self):
        try: self.route('GET')
        except Exception as err: self.send_error_json(err)

    def do_POST(self):
        try: self.route('POST')
        except Exception as err: self.send_error_json(err)

    def route(self, method):
        parsed = urlparse(self.path); path = parsed.path; qs = parse_qs(parsed.query)
        if path.startswith('/api/'): return self.api(method, path, qs)
        file = PUBLIC / ('index.html' if path == '/' else path.lstrip('/'))
        if not str(file.resolve()).startswith(str(PUBLIC.resolve())) or not file.exists():
            self.send_response(302); self.send_header('location', '/'); self.end_headers(); return
        mime = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png'}.get(file.suffix, 'application/octet-stream')
        data = file.read_bytes(); self.send_response(200); self.send_header('content-type', mime); self.send_header('content-length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def api(self, method, path, qs):
        if method == 'GET' and path == '/api/bootstrap': return self.send_json(200, {'bars': db['bars'], 'staffPinHint': STAFF_PIN})
        if method == 'POST' and path == '/api/tabs':
            body = self.json_body(); bar = next((b for b in db['bars'] if b['id'] == body.get('barId', 'millstone')), db['bars'][0])
            group = str(body.get('groupName', '')).strip(); contact = str(body.get('contact', '')).strip()
            if len(group) < 2: raise ApiError(400, 'Gruppnamn krävs')
            if len(contact) < 3: raise ApiError(400, 'Kontakt krävs')
            budget = float(body['budget']) if str(body.get('budget', '')).strip() else None
            if budget is not None and budget <= 0: raise ApiError(400, 'Budget måste vara ett positivt belopp')
            tab_id = f"tab_{len(db['tabs']) + 1842}"; admin_token = make_token('adm'); invite_token = make_token('inv')
            tab = {'id': tab_id, 'barId': bar['id'], 'groupName': group, 'contact': contact, 'budget': budget, 'currency': bar['currency'], 'status': 'active', 'adminToken': admin_token, 'inviteToken': invite_token, 'createdAt': now(), 'budgetMode': 'preliminär informationsnivå'}
            db['tabs'][tab_id] = tab; db['invites'][invite_token] = {'token': invite_token, 'tabId': tab_id, 'status': 'open', 'createdAt': now(), 'maxPasses': int(body['maxPasses']) if str(body.get('maxPasses', '')).strip() else None}
            event('tab.created', contact, {'tabId': tab_id, 'groupName': group}); persist()
            origin = self.origin(); return self.send_json(201, {'tab': tab_summary(tab), 'adminUrl': f'{origin}/#admin/{tab_id}/{admin_token}', 'inviteUrl': f'{origin}/#invite/{invite_token}', 'staffUrl': f'{origin}/#staff'})
        parts = path.strip('/').split('/')
        if method == 'GET' and len(parts) == 3 and parts[:2] == ['api', 'tabs']:
            tab = require_tab(parts[2]); require_admin(tab, qs.get('adminToken', [''])[0]); return self.send_json(200, {'tab': tab_summary(tab), 'events': [e for e in db['events'] if e.get('data', {}).get('tabId') == tab['id']][:30]})
        if method == 'POST' and len(parts) == 4 and parts[:2] == ['api', 'tabs'] and parts[3] == 'status':
            tab = require_tab(parts[2]); body = self.json_body(); require_admin(tab, body.get('adminToken')); nxt = str(body.get('status', ''))
            if nxt not in ('active', 'paused', 'closing', 'closed'): raise ApiError(400, 'Ogiltig status')
            if tab['status'] == 'closed' and nxt != 'closed': raise ApiError(409, 'Stängd nota kan inte återöppnas')
            tab['status'] = nxt; event('tab.status', 'admin', {'tabId': tab['id'], 'status': nxt}); persist(); return self.send_json(200, {'tab': tab_summary(tab)})
        if method == 'POST' and len(parts) == 4 and parts[:2] == ['api', 'invitations'] and parts[3] == 'pass':
            invite = db['invites'].get(parts[2])
            if not invite or invite['status'] != 'open': raise ApiError(404, 'Inbjudan är stängd eller saknas')
            tab = require_tab(invite['tabId']); body = self.json_body(); dev = str(body.get('deviceId', '')).strip()
            if tab['status'] in ('closed', 'closing'): raise ApiError(409, 'Notan är stängd för nya pass')
            if len(dev) < 8: raise ApiError(400, 'Enhets-ID saknas')
            existing = next((p for p in db['passes'].values() if p['tabId'] == tab['id'] and p['deviceId'] == dev and p['status'] == 'active'), None)
            if existing: return self.send_json(200, {'pass': pass_view(existing), 'passUrl': f'{self.origin()}/#pass/{existing["token"]}'})
            count = len([p for p in db['passes'].values() if p['tabId'] == tab['id']])
            if invite.get('maxPasses') and count >= invite['maxPasses']: raise ApiError(409, 'Max antal pass är utfärdade')
            pass_ = {'id': f'pass_{count+1}', 'token': make_token('pass'), 'tabId': tab['id'], 'deviceId': dev, 'status': 'active', 'label': f'Gäst {count+1}', 'createdAt': now(), 'lastScannedAt': None}
            db['passes'][pass_['token']] = pass_; event('pass.issued', 'guest', {'tabId': tab['id'], 'passId': pass_['id']}); persist(); return self.send_json(201, {'pass': pass_view(pass_), 'passUrl': f'{self.origin()}/#pass/{pass_["token"]}'})
        if method == 'GET' and len(parts) == 3 and parts[:2] == ['api', 'passes']:
            pass_ = db['passes'].get(parts[2])
            if not pass_: raise ApiError(404, 'Passet finns inte')
            return self.send_json(200, {'pass': pass_view(pass_), 'scan': scan_status(pass_['token'])})
        if method == 'POST' and len(parts) == 4 and parts[:2] == ['api', 'passes'] and parts[3] == 'revoke':
            pass_ = db['passes'].get(parts[2])
            if not pass_: raise ApiError(404, 'Passet finns inte')
            tab = require_tab(pass_['tabId']); body = self.json_body(); require_admin(tab, body.get('adminToken'))
            pass_['status'] = 'revoked'; event('pass.revoked', 'admin', {'tabId': tab['id'], 'passId': pass_['id']}); persist(); return self.send_json(200, {'pass': pass_view(pass_)})
        if method == 'POST' and path == '/api/scan':
            body = self.json_body(); require_staff(body.get('staffPin', STAFF_PIN)); pass_token = str(body.get('passToken', '')).strip().split('/')[-1]
            result = scan_status(pass_token)
            if result.get('pass'):
                pass_ = db['passes'][result['pass']['token']]; pass_['lastScannedAt'] = now(); event('pass.scanned', 'staff', {'tabId': pass_['tabId'], 'passId': pass_['id'], 'status': result['status']}); persist()
            return self.send_json(200, result)
        if method == 'POST' and path == '/api/purchases':
            body = self.json_body(); require_staff(body.get('staffPin', STAFF_PIN)); key = str(body.get('idempotencyKey', '')).strip()
            if key and key in db['idempotency']: return self.send_json(200, {'purchase': db['purchases'][db['idempotency'][key]], 'duplicate': True})
            scan = scan_status(str(body.get('passToken', '')).strip().split('/')[-1])
            if scan['status'] != 'active': raise ApiError(409, scan['reason'])
            amount = round(float(body.get('amount')), 2)
            if amount <= 0: raise ApiError(400, 'Belopp måste vara positivt')
            purchase = {'id': str(uuid.uuid4()), 'tabId': scan['tab']['id'], 'passId': scan['pass']['id'], 'passToken': scan['pass']['token'], 'amount': amount, 'currency': scan['tab']['currency'], 'staffId': 'staff-demo', 'source': 'manual', 'status': 'confirmed', 'createdAt': now(), 'idempotencyKey': key or str(uuid.uuid4()), 'note': 'Preliminärt saldo tills kassans avstämning är klar.'}
            db['purchases'][purchase['id']] = purchase; db['idempotency'][purchase['idempotencyKey']] = purchase['id']; event('purchase.confirmed', 'staff', {'tabId': purchase['tabId'], 'passId': purchase['passId'], 'amount': amount}); persist(); return self.send_json(201, {'purchase': purchase, 'tab': tab_summary(db['tabs'][purchase['tabId']])})
        if method == 'GET' and path == '/api/staff/recent':
            require_staff(qs.get('staffPin', [STAFF_PIN])[0]); tabs = sorted([tab_summary(t) for t in db['tabs'].values()], key=lambda t: t['createdAt'], reverse=True); return self.send_json(200, {'tabs': tabs})
        raise ApiError(404, 'Hittar inte API-resursen')


if __name__ == '__main__':
    print(f'Barpass running on http://localhost:{PORT}', flush=True)
    print(f'Staff PIN: {STAFF_PIN}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
