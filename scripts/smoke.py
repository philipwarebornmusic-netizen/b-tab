#!/usr/bin/env python3
import json, os, time, urllib.request

BASE = os.environ.get('BASE_URL', 'http://localhost:4173')

def api(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        body = err.read().decode()
        raise RuntimeError(f'{path}: {body}')

stamp = int(time.time() * 1000)
created = api('/api/tabs', {'barId': 'millstone', 'groupName': f'Smoke {stamp}', 'contact': 'smoke@example.test', 'budget': 500})
invite = created['tab']['inviteToken']; tab_id = created['tab']['id']; admin = created['tab']['adminToken']

p1 = api(f'/api/invitations/{invite}/pass', {'deviceId': f'device-a-{stamp}'})
p2 = api(f'/api/invitations/{invite}/pass', {'deviceId': f'device-b-{stamp}'})
assert p1['pass']['token'] != p2['pass']['token'], 'Guests received same pass token'

scan = api('/api/scan', {'staffPin': '1842', 'passToken': p1['pass']['token']})
assert scan['status'] == 'active' and scan['tab']['id'] == tab_id, 'Scan did not resolve active tab'

key = f'idem-{stamp}'
buy1 = api('/api/purchases', {'staffPin': '1842', 'passToken': p1['pass']['token'], 'amount': 129, 'idempotencyKey': key})
buy2 = api('/api/purchases', {'staffPin': '1842', 'passToken': p1['pass']['token'], 'amount': 129, 'idempotencyKey': key})
assert buy2.get('duplicate') is True and buy1['purchase']['id'] == buy2['purchase']['id'], 'Idempotent retry created a second purchase'

api(f"/api/passes/{p1['pass']['token']}/revoke", {'adminToken': admin})
denied = api('/api/scan', {'staffPin': '1842', 'passToken': p1['pass']['token']})
assert denied['status'] != 'active', 'Revoked pass scanned as active'

api(f'/api/tabs/{tab_id}/status', {'adminToken': admin, 'status': 'closed'})
closed = api('/api/scan', {'staffPin': '1842', 'passToken': p2['pass']['token']})
assert closed['status'] != 'active', 'Closed tab allowed active scan'

print(json.dumps({'ok': True, 'tabId': tab_id, 'passTokensDistinct': True, 'purchaseId': buy1['purchase']['id'], 'duplicateIgnored': buy2.get('duplicate'), 'revokedStatus': denied['status'], 'closedStatus': closed['status']}, ensure_ascii=False, indent=2))
