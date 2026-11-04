"""Test de bout en bout des espaces KJ, contre le serveur lancé en local :

    npx wrangler dev --local --port 8787   (var : KJ_ADMIN_TOKEN, fichier .dev.vars)
    python tests/kj_flow_test.py http://localhost:8787 admin-secret
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE, ADMIN = sys.argv[1].rstrip("/"), sys.argv[2]
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Rab de 2 h : testé seulement contre « wrangler dev --local » (base locale).
LOCAL_DB = BASE.startswith("http://localhost") or BASE.startswith("http://127.0.0.1")
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
check("page : KJ en ligne, catalogue ouvert, demandes fermées sans session",
      info["online"] and info["browse"] and not info["open"] and info["name"] == "DJ Test")

# Formules : FREE (1 session de 4 h offerte), puis UN WEEKEND / UN MOIS / UN AN achetés.
sessions = kj("getSessions")[1]["sessions"]
check("FREE : 1 session offerte", sessions["sessionsLeft"] == 1 and sessions["sessionUntil"] == 0
      and sessions["lifetime"] is False)
status, body = kj("startSession")
check("session offerte démarrée (4 h)", status == 200 and body["sessions"]["started"]
      and body["sessions"]["sessionsLeft"] == 0
      and 3.9 * 3600e3 < body["sessions"]["sessionUntil"] - time.time() * 1000 < 4.1 * 3600e3)
status, body = kj("startSession")
check("2e clic pendant la soirée : rien de décompté", status == 200 and not body["sessions"]["started"])
status, info = call("GET", f"/kj/{CODE}/info")
check("page : demandes ouvertes pendant la session", info["open"] and info["inSession"])
check("formule refusée sans jeton", call("POST", "/admin/kj/packs", {"code": CODE, "plan": "day"})[0] == 401)
check("formule inconnue refusée", call("POST", "/admin/kj/packs", {"code": CODE, "plan": "x"}, ADMIN)[0] == 400)
status, body = call("POST", "/admin/kj/packs", {"code": CODE, "plan": "weekend"}, ADMIN)
check("UN WEEKEND ajouté (2 sessions, sans date avant la 1re)", status == 200
      and body["sessions"]["sessionsLeft"] == 2 and body["sessions"]["packs"][0]["expiresAt"] == 0)
status, body = call("POST", "/admin/kj/packs", {"code": CODE, "plan": "month"}, ADMIN)
month = [p for p in body["sessions"]["packs"] if p["plan"] == "month"][0]
check("UN MOIS ajouté (8 sessions, 30 jours)", body["sessions"]["sessionsLeft"] == 10
      and 29.9 * 86400e3 < month["expiresAt"] - time.time() * 1000 < 30.1 * 86400e3)
status, body = call("POST", "/admin/kj/packs", {"code": CODE, "plan": "year"}, ADMIN)
year = [p for p in body["sessions"]["packs"] if p["plan"] == "year"][0]
check("UN AN ajouté (96 sessions, 365 jours)", body["sessions"]["sessionsLeft"] == 106
      and 364.9 * 86400e3 < year["expiresAt"] - time.time() * 1000 < 365.1 * 86400e3)
status, body = call("POST", "/admin/kj/sessions", {"code": CODE}, ADMIN)
check("sessions restantes (karolive.com)", status == 200 and body["sessions"]["sessionsLeft"] == 106)

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
check("option catalogue hors soirée", kj("setProfile", allowOffline=True)[1]["profile"]["allowOffline"] is True)
info = call("GET", f"/kj/{CODE}/info")[1]
check("page : catalogue ouvert, demandes fermées, logiciel fermé",
      info["browse"] and not info["open"] and not info["online"])
check("demande refusée (logiciel fermé, catalogue seul)", call("POST", f"/kj/{CODE}/request",
      {"artist": "Queen", "title": "Bohemian Rhapsody", "singer": "Tom"})[0] == 403)
profile = kj("setProfile", offlineRequests=True)[1]["profile"]
check("option demandes hors soirée", profile["offlineRequests"] is True and profile["allowOffline"] is True)
info = call("GET", f"/kj/{CODE}/info")[1]
check("page : catalogue et demandes ouverts, logiciel fermé", info["browse"] and info["open"] and not info["online"])
check("demande hors soirée acceptée", call("POST", f"/kj/{CODE}/request",
      {"artist": "Queen", "title": "Bohemian Rhapsody", "singer": "Tom"})[0] == 200)
requests = kj("getRequests")[1]["requests"]
check("demande hors soirée gardée et marquée", len(requests) == 1 and requests[0]["offline"] == 1)
kj("clearRequests")

# Session = 8 h d'UTILISATION dans les 24 h, pause logiciel fermé, rab de 2 h.
# (état de la session modifié directement dans la base locale)
def sql(statement):
    subprocess.run(["npx", "wrangler", "d1", "execute", "karolive-kj", "--local", "--command", statement],
                   check=True, capture_output=True, cwd=HERE, shell=(os.name == "nt"))


def set_session(start_ago_h, used_h, beat_ago_s=5, done_ago_h=None, length_h=8):
    now = int(time.time() * 1000)
    done = 0 if done_ago_h is None else now - int(done_ago_h * 3600e3)
    sql(f"UPDATE kjs SET session_start = {now - int(start_ago_h * 3600e3)}, "
        f"session_length = {int(length_h * 3600e3)}, session_used = {int(used_h * 3600e3)}, "
        f"session_beat = {now - beat_ago_s * 1000}, session_done = {done}, "
        f"last_heartbeat = {now - 20000} "  # logiciel en ligne, prochain signal enregistré
        f"WHERE code = '{CODE}'")


def session():
    return kj("getSessions")[1]["sessions"]


H = 3600e3
if LOCAL_DB:
    kj("setAccepting", accepting=True)
    set_session(start_ago_h=3, used_h=1, beat_ago_s=600)  # logiciel fermé 10 min
    kj("heartbeat")
    check("logiciel rouvert après une fermeture : pause, rien de compté",
          abs(session()["sessionRemaining"] - 7 * H) < 2000)
    info = call("GET", f"/kj/{CODE}/info")[1]
    check("session en cours : demandes ouvertes", info["open"] and info["inSession"])
    sql(f"UPDATE kjs SET session_beat = {int(time.time() * 1000) - 20000}, "
        f"last_heartbeat = {int(time.time() * 1000) - 20000} "
        f"WHERE code = '{CODE}'")
    kj("heartbeat")
    remaining = session()["sessionRemaining"]
    check("logiciel ouvert : le temps est décompté", 7 * H - 25000 < remaining < 7 * H - 15000)
    check("fin prévue = maintenant + durée restante",
          abs(session()["sessionUntil"] - time.time() * 1000 - remaining) < 5000)
    kj("heartbeat", usedMs=int(3 * H))
    check("compte du logiciel plus grand (connexion coupée) : retenu",
          abs(session()["sessionRemaining"] - 5 * H) < 2000)
    kj("heartbeat", usedMs=int(0.5 * H))
    check("compte du logiciel plus petit : ignoré", abs(session()["sessionRemaining"] - 5 * H) < 25000)
    check("« Démarrer ma soirée » pendant la session : rien de décompté",
          kj("startSession")[1]["sessions"]["started"] is False)

    set_session(start_ago_h=25, used_h=2)  # fenêtre de 24 h dépassée il y a 1 h
    info = call("GET", f"/kj/{CODE}/info")[1]
    check("24 h dépassées : session finie, rab de 2 h", not info["inSession"] and info["inGrace"] and info["open"])
    check("rab : fin donnée au logiciel", session()["sessionUntil"] == 0
          and 0.9 * H < session()["graceUntil"] - time.time() * 1000 < 1.1 * H)
    set_session(start_ago_h=27, used_h=2)
    info = call("GET", f"/kj/{CODE}/info")[1]
    check("après le rab : demandes fermées", not info["open"] and not info["inGrace"])
    set_session(start_ago_h=10, used_h=8, done_ago_h=0.5)  # 8 h utilisées il y a 30 min
    info = call("GET", f"/kj/{CODE}/info")[1]
    check("8 h utilisées : rab de 2 h", not info["inSession"] and info["inGrace"]
          and 1.4 * H < session()["graceUntil"] - time.time() * 1000 < 1.6 * H)
    set_session(start_ago_h=1, used_h=7.999, beat_ago_s=10)
    kj("heartbeat")
    check("dernières secondes consommées : session finie, rab commence",
          session()["sessionRemaining"] == 0 and session()["graceUntil"] > 0)
    set_session(start_ago_h=1, used_h=1)  # de nouveau en session

# Abonnement suspendu (désabonnement) : page fermée et VIDE, logiciel refusé,
# rab supprimé, demandes effacées ; même code (QR inchangé).
check("demande avant désabonnement", call("POST", f"/kj/{CODE}/request",
      {"artist": "Queen", "title": "We Will Rock You", "singer": "Ana"})[0] in (200, 403))
call("POST", "/admin/kj", {"code": CODE, "email": "dj@test.fr", "active": False}, ADMIN)
info = call("GET", f"/kj/{CODE}/info")[1]
check("abonnement suspendu : page fermée", not info["active"] and not info["open"] and not info["browse"])
check("abonnement suspendu : page vide (aucun catalogue)", info["catalogCount"] == 0
      and call("GET", f"/kj/{CODE}/catalog")[1] == [] and not info["inGrace"])
check("abonnement suspendu : logiciel refusé", kj("heartbeat")[0] == 403)
call("POST", "/admin/kj", {"code": CODE, "email": "dj@test.fr", "active": True}, ADMIN)
check("abonnement réactivé : même code, même clé", kj("heartbeat")[0] == 200)
check("abonnement réactivé : demandes d'avant effacées, ni session ni rab",
      kj("getRequests")[1]["requests"] == [] and kj("getSessions")[1]["sessions"]["graceUntil"] == 0
      and kj("getSessions")[1]["sessions"]["sessionRemaining"] == 0)


# Gratuité à vie (abonnés d'avant les formules) : rien n'est décompté.
LIFE, LIFE_KEY = CODE + "v", "cle-du-kj-a-vie"
status, body = call("POST", "/admin/kj", {"code": LIFE, "email": "ami@test.fr", "name": "Ami",
                                          "keyHash": hashlib.sha256(LIFE_KEY.encode()).hexdigest(),
                                          "lifetime": True}, ADMIN)
check("KJ à vie créé", status == 200)
status, body = call("POST", f"/kj/{LIFE}", {"command": "startSession"}, LIFE_KEY)
check("KJ à vie : session de 8 h sans décompte", status == 200 and body["sessions"]["lifetime"] is True
      and body["sessions"]["sessionsLeft"] == 1
      and 7.9 * 3600e3 < body["sessions"]["sessionUntil"] - time.time() * 1000 < 8.1 * 3600e3)
call("POST", "/admin/kj", {"code": LIFE, "email": "ami@test.fr", "lifetime": False}, ADMIN)
status, body = call("POST", f"/kj/{LIFE}", {"command": "getSessions"}, LIFE_KEY)
check("gratuité à vie retirée", body["sessions"]["lifetime"] is False)

print("TOUT EST OK")
