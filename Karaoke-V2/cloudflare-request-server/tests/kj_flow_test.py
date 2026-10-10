"""Test de bout en bout des espaces KJ, contre le serveur lancé en local :

    npx wrangler dev --local --port 8787   (vars : KJ_ADMIN_TOKEN, OPENKJ_API_KEY)
    python tests/kj_flow_test.py http://localhost:8787 admin-secret owner-key

Vérifie aussi que la partie OpenKJ du KJ propriétaire n'a pas changé.
"""
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request

BASE, ADMIN, OWNER = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
CODE = f"djtest{int(time.time()) % 100000}"
KEY = "cle-secrete-du-kj"


def call(method, path, body=None, token=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", ctype)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as res:
            payload = res.read()
            return res.status, (json.loads(payload) if res.headers.get_content_type() == "application/json" else payload)
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        try:
            return exc.code, json.loads(payload)
        except ValueError:
            return exc.code, payload


def kj(command, **fields):
    return call("POST", f"/kj/{CODE}", {"command": command, **fields}, KEY)


def check(label, condition):
    print(("OK   " if condition else "FAIL ") + label)
    if not condition:
        sys.exit(1)


# Administration : création par le serveur karolive.com.
key_hash = hashlib.sha256(KEY.encode()).hexdigest()
check("admin refusé sans jeton", call("POST", "/admin/kj", {"code": CODE})[0] == 401)
status, body = call("POST", "/admin/kj", {"code": CODE, "email": "dj@test.fr", "keyHash": key_hash,
                                          "name": "DJ Test"}, ADMIN)
check("création du KJ", status == 200 and body["created"])
check("code jamais réattribué", call("POST", "/admin/kj", {"code": CODE, "email": "autre@test.fr",
                                                            "keyHash": key_hash}, ADMIN)[0] == 409)
check("code invalide refusé", call("POST", "/admin/kj", {"code": "A B", "email": "x@y.z",
                                                          "keyHash": key_hash}, ADMIN)[0] == 400)

# Logiciel du KJ.
check("mauvaise clé refusée", call("POST", f"/kj/{CODE}", {"command": "getSerial"}, "faux")[0] == 401)
status, info = call("GET", f"/kj/{CODE}/info")
check("page : KJ hors ligne, demandes fermées", status == 200 and not info["online"] and not info["open"])
check("demande refusée hors ligne", call("POST", f"/kj/{CODE}/request",
      {"artist": "ABBA", "title": "Waterloo", "singer": "Léa"})[0] == 403)
check("heartbeat", kj("heartbeat")[0] == 200)
status, info = call("GET", f"/kj/{CODE}/info")
check("page : KJ en ligne, demandes ouvertes", info["online"] and info["open"] and info["name"] == "DJ Test")

songs = [{"id": "a1", "artist": "ABBA", "title": "Waterloo"},
         {"id": "a1b", "artist": "abba", "title": "waterloo"},  # doublon (casse)
         {"id": "q1", "artist": "Queen", "title": "Bohemian Rhapsody"}]
status, body = call("PUT", f"/kj/{CODE}/catalog", {"songs": songs}, KEY)
check("publication du catalogue (doublon retiré)", status == 200 and body["count"] == 2)
status, catalog = call("GET", f"/kj/{CODE}/catalog")
check("catalogue public", [s["title"] for s in catalog] == ["Waterloo", "Bohemian Rhapsody"])
big = [{"id": str(i), "artist": f"Artiste {i:05d} " + "x" * 40, "title": f"Titre {i} " + "y" * 40}
       for i in range(20000)]
status, body = call("PUT", f"/kj/{CODE}/catalog", {"songs": big}, KEY)
status2, catalog = call("GET", f"/kj/{CODE}/catalog")
check("grand catalogue (20 000 titres, en plusieurs morceaux)", body["count"] == 20000 and len(catalog) == 20000)
call("PUT", f"/kj/{CODE}/catalog", {"songs": songs}, KEY)

png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082")
check("logo refusé si pas une image", call("PUT", f"/kj/{CODE}/logo", raw=b"abc", token=KEY,
                                           ctype="text/plain")[0] == 415)
check("envoi du logo", call("PUT", f"/kj/{CODE}/logo", raw=png, token=KEY, ctype="image/png")[0] == 200)
status, logo = call("GET", f"/kj/{CODE}/logo")
check("logo public", status == 200 and logo == png)

serial = kj("getSerial")[1]["serial"]
check("demande d'un client", call("POST", f"/kj/{CODE}/request", {"artist": "ABBA", "title": "Waterloo",
      "singer": "Léa", "keyChange": -2, "songId": "a1"})[0] == 200)
check("compteur incrémenté", kj("getSerial")[1]["serial"] > serial)
requests = kj("getRequests")[1]["requests"]
check("demande reçue par le KJ", len(requests) == 1 and requests[0]["song_id"] == "a1"
      and requests[0]["key_change"] == "-2" and requests[0]["offline"] == 0)
check("suppression", kj("deleteRequest", request_id=requests[0]["request_id"])[0] == 200)

check("fermeture des demandes", kj("setAccepting", accepting=False)[1]["accepting"] is False)
check("demande refusée (fermées)", call("POST", f"/kj/{CODE}/request",
      {"artist": "ABBA", "title": "Waterloo", "singer": "Max"})[0] == 403)
kj("setAccepting", accepting=True)

# Fin de soirée, puis option « hors soirée ».
call("POST", f"/kj/{CODE}/request", {"artist": "ABBA", "title": "Waterloo", "singer": "Zoé"})
check("fermeture du logiciel", kj("close")[0] == 200)
check("demandes restantes effacées à la fermeture", kj("getRequests")[1]["requests"] == [])
info = call("GET", f"/kj/{CODE}/info")[1]
check("page : hors ligne après fermeture", not info["online"] and not info["browse"])
check("option hors soirée", kj("setProfile", allowOffline=True)[1]["profile"]["allowOffline"] is True)
info = call("GET", f"/kj/{CODE}/info")[1]
check("page : catalogue et demandes ouverts, logiciel fermé", info["browse"] and info["open"] and not info["online"])
check("demande hors soirée acceptée", call("POST", f"/kj/{CODE}/request",
      {"artist": "Queen", "title": "Bohemian Rhapsody", "singer": "Tom"})[0] == 200)
requests = kj("getRequests")[1]["requests"]
check("demande hors soirée gardée et marquée", len(requests) == 1 and requests[0]["offline"] == 1)
kj("clearRequests")

# Abonnement suspendu : page fermée, logiciel refusé, même code (QR inchangé).
call("POST", "/admin/kj", {"code": CODE, "email": "dj@test.fr", "active": False}, ADMIN)
info = call("GET", f"/kj/{CODE}/info")[1]
check("abonnement suspendu : page fermée", not info["active"] and not info["open"] and not info["browse"])
check("abonnement suspendu : logiciel refusé", kj("heartbeat")[0] == 403)
call("POST", "/admin/kj", {"code": CODE, "email": "dj@test.fr", "active": True}, ADMIN)
check("abonnement réactivé : même code, même clé", kj("heartbeat")[0] == 200)

# Partie OpenKJ du KJ propriétaire : inchangée.
check("OpenKJ : statut", call("GET", "/status")[0] == 200)
check("OpenKJ : commande avec sa clé", call("POST", "/", {"command": "getSerial"}, OWNER)[0] == 200)
check("OpenKJ : clé d'un KJ refusée", call("POST", "/", {"command": "getSerial"}, KEY)[0] == 401)
print("TOUT EST OK")
