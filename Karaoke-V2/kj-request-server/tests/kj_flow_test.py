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

# Stock d'heures : FREE (4 h offertes), puis UN WEEKEND (16 h) / UN MOIS (64 h)
# / UN AN (768 h) achetés.
H = 3600e3
sessions = kj("getSessions")[1]["sessions"]
check("FREE : 4 h offertes, pas de soirée en cours", sessions["hoursLeft"] == 4 * H
      and not sessions["showRunning"] and sessions["lifetime"] is False)
status, body = kj("startSession")
check("soirée démarrée : rien de décompté au départ", status == 200 and body["sessions"]["started"]
      and body["sessions"]["showRunning"] and body["sessions"]["hoursLeft"] == 4 * H)
status, body = kj("startSession")
check("2e clic pendant la soirée : rien de décompté", status == 200 and not body["sessions"]["started"])
status, info = call("GET", f"/kj/{CODE}/info")
check("page : demandes ouvertes pendant la soirée", info["open"] and info["inSession"])
check("formule refusée sans jeton", call("POST", "/admin/kj/packs", {"code": CODE, "plan": "day"})[0] == 401)
check("formule inconnue refusée", call("POST", "/admin/kj/packs", {"code": CODE, "plan": "x"}, ADMIN)[0] == 400)
status, body = call("POST", "/admin/kj/packs", {"code": CODE, "plan": "weekend"}, ADMIN)
weekend = [p for p in body["sessions"]["packs"] if p["plan"] == "weekend"][0]
check("UN WEEKEND ajouté (16 h, sans date avant la 1re utilisation)", status == 200
      and body["sessions"]["hoursLeft"] == 20 * H and weekend["expiresAt"] == 0)
status, body = call("POST", "/admin/kj/packs", {"code": CODE, "plan": "month"}, ADMIN)
month = [p for p in body["sessions"]["packs"] if p["plan"] == "month"][0]
check("UN MOIS ajouté (64 h, 30 jours)", body["sessions"]["hoursLeft"] == 84 * H
      and 29.9 * 86400e3 < month["expiresAt"] - time.time() * 1000 < 30.1 * 86400e3)
status, body = call("POST", "/admin/kj/packs", {"code": CODE, "plan": "year"}, ADMIN)
year = [p for p in body["sessions"]["packs"] if p["plan"] == "year"][0]
check("UN AN ajouté (768 h, 365 jours)", body["sessions"]["hoursLeft"] == 852 * H
      and 364.9 * 86400e3 < year["expiresAt"] - time.time() * 1000 < 365.1 * 86400e3)
status, body = call("POST", "/admin/kj/sessions", {"code": CODE}, ADMIN)
check("stock d'heures (karolive.com)", status == 200 and body["sessions"]["hoursLeft"] == 852 * H)

songs = [{"id": "a1", "artist": "ABBA", "title": "Waterloo"},
         {"id": "a1b", "artist": "abba", "title": "waterloo"},  # doublon (casse)
         {"id": "q1", "artist": "Queen", "title": "Bohemian Rhapsody"}]
status, body = call("PUT", f"/kj/{CODE}/catalog", {"songs": songs}, KEY)
check("publication du catalogue (doublon retiré)", status == 200 and body["count"] == 2)
status, catalog = call("GET", f"/kj/{CODE}/catalog")
check("catalogue public", [s["title"] for s in catalog] == ["Waterloo", "Bohemian Rhapsody"])
with_lang = [{"id": "a1", "artist": "ABBA", "title": "Waterloo", "lang": "English"},
             {"id": "j1", "artist": "Johnny Hallyday", "title": "Allumer le feu", "lang": "Français"},
             {"id": "q1", "artist": "Queen", "title": "Bohemian Rhapsody"}]
call("PUT", f"/kj/{CODE}/catalog", {"songs": with_lang}, KEY)
status, catalog = call("GET", f"/kj/{CODE}/catalog")
check("langues publiées (rubriques de la page)",
      [(s["title"], s.get("lang")) for s in catalog] == [
          ("Waterloo", "English"), ("Allumer le feu", "Français"), ("Bohemian Rhapsody", None)])
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

# Compteur du stock : logiciel ouvert seulement, pause à la fermeture, compte
# du logiciel retenu s'il est plus grand, stock épuisé → rab de 2 h.
# (état de la soirée modifié directement dans la base locale)
def sql(statement):
    subprocess.run(["npx", "wrangler", "d1", "execute", "karolive-kj", "--local", "--command", statement],
                   check=True, capture_output=True, cwd=HERE, shell=(os.name == "nt"))


def now_ms():
    return int(time.time() * 1000)


def set_show(running=1, used_ms=0, beat_ago_s=5, done_ago_h=None):
    done = 0 if done_ago_h is None else now_ms() - int(done_ago_h * H)
    beat = now_ms() - beat_ago_s * 1000 if running else 0
    sql(f"UPDATE kjs SET show_running = {running}, show_used = {int(used_ms)}, session_beat = {beat}, "
        f"show_done = {done}, last_heartbeat = {now_ms() - 20000} WHERE code = '{CODE}'")


def stock():
    return kj("getSessions")[1]["sessions"]


if LOCAL_DB:
    kj("setAccepting", accepting=True)
    before = stock()["hoursLeft"]
    set_show(beat_ago_s=600)  # logiciel fermé 10 min pendant la soirée
    kj("heartbeat")
    check("logiciel rouvert après une fermeture : pause, rien de décompté", stock()["hoursLeft"] == before)
    set_show(beat_ago_s=20)
    kj("heartbeat")
    used = before - stock()["hoursLeft"]
    check("logiciel ouvert : le temps est décompté du stock", 15000 < used < 25000)
    check("décompté d'abord sur la formule qui expire la première (UN MOIS)",
          [p for p in stock()["packs"] if p["plan"] == "month"][0]["msLeft"] == 64 * H - used
          and [p for p in stock()["packs"] if p["plan"] == "trial"][0]["msLeft"] == 4 * H)
    kj("heartbeat", usedMs=int(H + used))
    check("compte du logiciel plus grand (connexion coupée) : retenu",
          abs(before - stock()["hoursLeft"] - (H + used)) < 2000)
    kj("heartbeat", usedMs=1000)
    check("compte du logiciel plus petit : ignoré", abs(before - stock()["hoursLeft"] - (H + used)) < 25000)
    status, body = kj("endSession")
    check("« Terminer ma soirée » : compteur arrêté", status == 200 and not body["sessions"]["showRunning"]
          and body["sessions"]["graceUntil"] == 0)
    left = stock()["hoursLeft"]
    kj("heartbeat")
    check("soirée terminée : plus rien de décompté", stock()["hoursLeft"] == left)
    info = call("GET", f"/kj/{CODE}/info")[1]
    check("soirée terminée (stock restant) : demandes fermées, pas de rab", not info["open"])

    kj("startSession")
    set_show(beat_ago_s=7 * 3600)  # logiciel fermé 7 h : soirée terminée d'office
    kj("heartbeat")
    check("logiciel fermé plus de 6 h : soirée terminée, rien décompté",
          not stock()["showRunning"] and stock()["hoursLeft"] == left)

    # Stock épuisé en pleine soirée : fin de soirée et rab de 2 h.
    kj("startSession")
    set_show(used_ms=0, beat_ago_s=5)
    kj("heartbeat", usedMs=int(left + H))
    s2 = stock()
    check("stock épuisé : soirée finie, rab de 2 h", s2["hoursLeft"] == 0 and not s2["showRunning"]
          and 1.9 * H < s2["graceUntil"] - now_ms() < 2.1 * H)
    info = call("GET", f"/kj/{CODE}/info")[1]
    check("rab : demandes encore ouvertes", info["open"] and info["inGrace"] and not info["inSession"])
    check("plus d'heures : « Démarrer ma soirée » refusé", kj("startSession")[0] == 402)
    set_show(running=0, done_ago_h=3)
    info = call("GET", f"/kj/{CODE}/info")[1]
    check("après le rab : demandes fermées", not info["open"] and not info["inGrace"])
    status, body = call("POST", "/admin/kj/packs", {"code": CODE, "plan": "day"}, ADMIN)
    day = [p for p in body["sessions"]["packs"] if p["plan"] == "day"][0]
    check("UN JOUR acheté : 8 h, délai pas encore commencé", body["sessions"]["hoursLeft"] == 8 * H
          and day["expiresAt"] == 0)
    kj("startSession")
    set_show(beat_ago_s=20)
    kj("heartbeat")
    day = [p for p in stock()["packs"] if p["plan"] == "day"][0]
    check("UN JOUR : délai de 24 h à partir de la 1re utilisation",
          23.9 * H < day["expiresAt"] - now_ms() < 24.1 * H)

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
check("abonnement réactivé : demandes d'avant effacées, ni soirée ni rab",
      kj("getRequests")[1]["requests"] == [] and kj("getSessions")[1]["sessions"]["graceUntil"] == 0
      and not kj("getSessions")[1]["sessions"]["showRunning"])


# Gratuité à vie (abonnés d'avant les formules) : rien n'est décompté.
LIFE, LIFE_KEY = CODE + "v", "cle-du-kj-a-vie"
status, body = call("POST", "/admin/kj", {"code": LIFE, "email": "ami@test.fr", "name": "Ami",
                                          "keyHash": hashlib.sha256(LIFE_KEY.encode()).hexdigest(),
                                          "lifetime": True}, ADMIN)
check("KJ à vie créé", status == 200)
status, body = call("POST", f"/kj/{LIFE}", {"command": "startSession"}, LIFE_KEY)
check("KJ à vie : soirée sans décompte", status == 200 and body["sessions"]["lifetime"] is True
      and body["sessions"]["showRunning"] and body["sessions"]["hoursLeft"] == 4 * 3600e3)
call("POST", "/admin/kj", {"code": LIFE, "email": "ami@test.fr", "lifetime": False}, ADMIN)
status, body = call("POST", f"/kj/{LIFE}", {"command": "getSessions"}, LIFE_KEY)
check("gratuité à vie retirée", body["sessions"]["lifetime"] is False)

# UN MOIS PRO : 160 h à utiliser en 30 jours (KJ à part : stock de 4 h offertes).
PRO = CODE + "p"
call("POST", "/admin/kj", {"code": PRO, "email": "pro@test.fr", "name": "Pro",
                           "keyHash": hashlib.sha256(b"cle-pro").hexdigest()}, ADMIN)
status, body = call("POST", "/admin/kj/packs", {"code": PRO, "plan": "pro"}, ADMIN)
pro = [p for p in body["sessions"]["packs"] if p["plan"] == "pro"][0]
check("UN MOIS PRO ajouté (160 h, 30 jours)", status == 200 and pro["msLeft"] == 160 * 3600e3
      and body["sessions"]["hoursLeft"] == 164 * 3600e3
      and 29.9 * 86400e3 < pro["expiresAt"] - time.time() * 1000 < 30.1 * 86400e3)

print("TOUT EST OK")
