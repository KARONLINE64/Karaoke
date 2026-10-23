"""Ajoute des titres au catalogue de la page (songs.json + fichier de la langue),
sans doublon, puis publie sur GitHub (la page se met à jour en quelques minutes).

Lancé par AJOUTER_TITRES.bat (double-clic). Les fichiers gardent exactement leur
mise en forme : seules les nouvelles lignes apparaissent dans l'historique.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALL_SONGS = "songs.json"
LANGUAGES = {
    "FR": ("Français", "francais.json"),
    "EN": ("Anglais", "english.json"),
    "NL": ("Néerlandais", "nederlands.json"),
    "IT": ("Italien", "italiano.json"),
    "ES": ("Espagnol", "español.json"),
}


def normalize(text: str) -> str:
    """Comparaison sans casse, accents, ponctuation ni espaces en trop."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).casefold()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def song_key(song: dict) -> tuple[str, str]:
    return normalize(song.get("artist", "")), normalize(song.get("title", ""))


def load(name: str) -> tuple[list[dict], bool]:
    raw = (ROOT / name).read_bytes()
    return json.loads(raw), raw.endswith(b"\n")


def save(name: str, songs: list[dict], final_newline: bool) -> None:
    text = json.dumps(songs, indent=2, ensure_ascii=False) + ("\n" if final_newline else "")
    (ROOT / name).write_bytes(text.encode("utf-8"))


def insert_sorted(songs: list[dict], song: dict) -> None:
    """Range le titre à sa place (ordre artiste puis titre), sans retrier le reste."""
    key = song_key(song)
    for index, other in enumerate(songs):
        if song_key(other) > key:
            songs.insert(index, song)
            return
    songs.append(song)


# Lignes de l'affichage de l'outil, collées par erreur avec les titres.
TOOL_MESSAGES = ("format attendu", "titre(s) à ajouter", "publier sur la page", "langue",
                 "tapez un titre", "ligne vide", "annulé", "publié", "appuyez sur")


def clean_line(line: str) -> str | None:
    """Ligne tapée ou collée → « Artiste - Titre », ou None si ce n'est pas
    un titre (message de l'outil copié avec le reste)."""
    line = line.strip()
    while line[:1] in (">", "✓", "=", "✗", "•"):
        line = line[1:].strip()
    lower = line.casefold()
    if lower.startswith("déjà dans le catalogue :"):
        line = line.split(":", 1)[1].strip()
        lower = line.casefold()
    if any(message in lower for message in TOOL_MESSAGES):
        return None
    return line


def parse_line(line: str) -> dict | None:
    """« Artiste - Titre » (le premier « - » entouré d'espaces sépare)."""
    artist, sep, title = line.partition(" - ")
    artist, title = " ".join(artist.split()), " ".join(title.split())
    if not sep or not artist or not title:
        return None
    return {"artist": artist, "title": title}


def git(*args: str) -> bool:
    return subprocess.run(["git", *args], cwd=ROOT).returncode == 0


def unpublished_commits() -> int:
    """Ajouts enregistrés sur ce PC mais pas encore envoyés sur GitHub
    (ex. première connexion à GitHub interrompue)."""
    result = subprocess.run(["git", "rev-list", "--count", "@{u}..HEAD"], cwd=ROOT,
                            capture_output=True, text=True)
    try:
        return int(result.stdout.strip() or 0)
    except ValueError:
        return 0


def ask_yes_no(question: str) -> bool:
    while True:
        answer = input(question).strip().upper()
        if answer in ("O", "OUI", "Y", "YES"):
            return True
        if answer in ("N", "NON", "NO"):
            return False
        print("   Répondez O (oui) ou N (non).")


def main() -> int:
    print("=== Ajouter des titres au catalogue de la page karaoké ===\n")
    if not git("pull", "--ff-only", "-q"):
        print("\nARRÊT : impossible de récupérer la dernière version (git pull).")
        return 1
    pending = unpublished_commits()
    if pending:
        print(f"Envoi sur GitHub de {pending} ajout(s) resté(s) sur ce PC...")
        if not git("push", "-q"):
            print("\nARRÊT : envoi sur GitHub impossible. Envoyez ce message à Claude.")
            return 1
        print("Envoyé : la page sera à jour d'ici quelques minutes.\n")
    print("Langue des titres :")
    for code, (label, _file) in LANGUAGES.items():
        print(f"  {code} = {label}")
    code = input("Langue (FR, EN, NL, IT ou ES) : ").strip().upper()
    if code not in LANGUAGES:
        print("Langue inconnue : rien n'a été modifié.")
        return 1
    label, lang_file = LANGUAGES[code]

    print("\nTapez un titre par ligne, sous la forme :  Artiste - Titre")
    print("(ligne vide pour terminer)\n")
    all_songs, all_nl = load(ALL_SONGS)
    lang_songs, lang_nl = load(lang_file)
    known = {song_key(s) for s in all_songs} | {song_key(s) for s in lang_songs}
    added: list[dict] = []
    while True:
        raw = input("> ")
        if not raw.strip():
            break
        line = clean_line(raw)
        if line is None or line.upper() in LANGUAGES:
            continue  # message de l'outil ou code de langue collé : ignoré
        song = parse_line(line)
        if song is None:
            print("   ✗ format attendu : Artiste - Titre (avec un tiret entouré d'espaces)")
            continue
        if song_key(song) in known:
            print(f"   = déjà dans le catalogue : {song['artist']} - {song['title']}")
            continue
        known.add(song_key(song))
        added.append(song)
        print(f"   ✓ {song['artist']} - {song['title']}")

    if not added:
        print("\nAucun nouveau titre : rien n'a été modifié.")
        return 0
    print(f"\n{len(added)} titre(s) à ajouter en {label} :")
    for song in added:
        print(f"   {song['artist']} - {song['title']}")
    if not ask_yes_no("\nPublier sur la page maintenant ? (O/N) "):
        print("Annulé : rien n'a été modifié.")
        return 0

    for song in added:
        insert_sorted(all_songs, dict(song))
        insert_sorted(lang_songs, dict(song))
    save(ALL_SONGS, all_songs, all_nl)
    save(lang_file, lang_songs, lang_nl)
    message = f"Catalogue : {len(added)} titre(s) ajouté(s) en {label}"
    if not (git("add", ALL_SONGS, lang_file) and git("commit", "-q", "-m", message)
            and git("push", "-q")):
        print("\nARRÊT : publication impossible (git). Envoyez ce message à Claude.")
        return 1
    print(f"\nPUBLIÉ : {message}. La page se met à jour d'ici quelques minutes "
          "(Ctrl+F5 pour la recharger).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        print("\nAnnulé : rien n'a été modifié.")
        sys.exit(1)
