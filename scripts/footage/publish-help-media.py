#!/usr/bin/env python3
"""Publish Mac mini help recordings, source-frame stills, stamps and captions.

Requires ffmpeg/ffprobe and Pillow on the encoding machine. The input MUST be
a completed new help-media.sh recording, never an existing website asset.
App pixels come only from ScreenCaptureKit footage on the Mac mini. The sole
added pixels are a clearly separate footer bearing the captured version/locale.
"""
import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
LOCALES = {
    "en": {
        "search-local": ["Search local messages for Priya and display matching mail", "Enter Priya in the search field.", "Run the search and review matching messages stored on this computer."],
        "privacy-mode": ["Enable privacy mode to hide names and addresses", "Select the privacy shield in the sidebar.", "Privacy mode masks names and email addresses in the mailbox."],
        "manual-backup": ["Back up all accounts and verify completion", "Select Back up all accounts in Backup settings.", "Watch backup progress until the run finishes."],
    },
    "de": {
        "search-local": ["Lokale Nachrichten nach Priya durchsuchen und Treffer anzeigen", "Priya in das Suchfeld eingeben.", "Die Suche starten und die lokal gespeicherten Treffer ansehen."],
        "privacy-mode": ["Datenschutzmodus aktivieren, um Namen und Adressen zu verbergen", "Das Datenschutz-Schild in der Seitenleiste auswählen.", "Der Datenschutzmodus verdeckt Namen und E-Mail-Adressen."],
        "manual-backup": ["Alle Konten sichern und den Abschluss prüfen", "In den Sicherungseinstellungen die Sicherung aller Konten starten.", "Den Fortschritt bis zum Abschluss der Sicherung verfolgen."],
    },
    "fr": {
        "search-local": ["Rechercher Priya dans les messages locaux et afficher les résultats", "Saisir Priya dans le champ de recherche.", "Lancer la recherche et consulter les messages enregistrés sur cet ordinateur."],
        "privacy-mode": ["Activer le mode confidentialité pour masquer les noms et les adresses", "Sélectionner le bouclier de confidentialité dans la barre latérale.", "Le mode confidentialité masque les noms et les adresses e-mail."],
        "manual-backup": ["Sauvegarder tous les comptes et vérifier la fin de l’opération", "Lancer la sauvegarde de tous les comptes dans les paramètres de sauvegarde.", "Suivre la progression jusqu’à la fin de la sauvegarde."],
    },
    "es": {
        "search-local": ["Buscar a Priya en los mensajes locales y mostrar los resultados", "Escribir Priya en el campo de búsqueda.", "Iniciar la búsqueda y revisar los mensajes guardados en este equipo."],
        "privacy-mode": ["Activar el modo de privacidad para ocultar nombres y direcciones", "Seleccionar el escudo de privacidad en la barra lateral.", "El modo de privacidad oculta nombres y direcciones de correo."],
        "manual-backup": ["Crear una copia de todas las cuentas y comprobar que termina", "Iniciar la copia de seguridad de todas las cuentas en los ajustes de copia de seguridad.", "Seguir el progreso hasta que termine la copia."],
    },
    "it": {
        "search-local": ["Cercare Priya nei messaggi locali e mostrare i risultati", "Digitare Priya nel campo di ricerca.", "Avviare la ricerca e consultare i messaggi salvati su questo computer."],
        "privacy-mode": ["Attivare la modalità privacy per nascondere nomi e indirizzi", "Selezionare lo scudo della privacy nella barra laterale.", "La modalità privacy nasconde nomi e indirizzi e-mail."],
        "manual-backup": ["Eseguire il backup di tutti gli account e verificarne il completamento", "Avviare il backup di tutti gli account nelle impostazioni di backup.", "Seguire l’avanzamento fino al completamento del backup."],
    },
    "ja": {
        "search-local": ["ローカルのメールからPriyaを検索して結果を表示する", "検索欄にPriyaと入力します。", "検索を実行し、このコンピュータに保存されたメールを確認します。"],
        "privacy-mode": ["プライバシーモードを有効にして名前とアドレスを隠す", "サイドバーのプライバシーシールドを選択します。", "プライバシーモードにより名前とメールアドレスが隠されます。"],
        "manual-backup": ["すべてのアカウントをバックアップして完了を確認する", "バックアップ設定ですべてのアカウントのバックアップを開始します。", "バックアップが完了するまで進行状況を確認します。"],
    },
    "ko": {
        "search-local": ["로컬 메시지에서 Priya를 검색하고 결과 표시", "검색창에 Priya를 입력합니다.", "검색을 실행하고 이 컴퓨터에 저장된 메시지를 확인합니다."],
        "privacy-mode": ["개인정보 보호 모드를 켜서 이름과 주소 숨기기", "사이드바에서 개인정보 보호 방패를 선택합니다.", "개인정보 보호 모드가 이름과 이메일 주소를 가립니다."],
        "manual-backup": ["모든 계정을 백업하고 완료 확인", "백업 설정에서 모든 계정의 백업을 시작합니다.", "백업이 끝날 때까지 진행 상황을 확인합니다."],
    },
    "zh": {
        "search-local": ["在本地邮件中搜索Priya并显示结果", "在搜索框中输入Priya。", "运行搜索并查看保存在此电脑上的匹配邮件。"],
        "privacy-mode": ["启用隐私模式以隐藏姓名和地址", "选择侧边栏中的隐私盾牌。", "隐私模式会遮蔽姓名和电子邮件地址。"],
        "manual-backup": ["备份所有账户并确认完成", "在备份设置中开始备份所有账户。", "查看进度，直到备份完成。"],
    },
    "pt-br": {
        "search-local": ["Pesquisar Priya nas mensagens locais e exibir os resultados", "Digite Priya no campo de pesquisa.", "Execute a pesquisa e veja as mensagens salvas neste computador."],
        "privacy-mode": ["Ativar o modo de privacidade para ocultar nomes e endereços", "Selecione o escudo de privacidade na barra lateral.", "O modo de privacidade oculta nomes e endereços de e-mail."],
        "manual-backup": ["Fazer backup de todas as contas e confirmar a conclusão", "Inicie o backup de todas as contas nas configurações de backup.", "Acompanhe o progresso até a conclusão do backup."],
    },
}


def read(path):
    return json.loads(path.read_text())


def media_translations(locale):
    """Seed exact English-source keys before extraction sees the new recordings."""
    headings = {
        "de": ["In MailVault ansehen", "Videotranskript"],
        "fr": ["Voir dans MailVault", "Transcription de la vidéo"],
        "es": ["Verlo en MailVault", "Transcripción del vídeo"],
        "it": ["Guarda in MailVault", "Trascrizione del video"],
        "ja": ["MailVaultで確認する", "動画の文字起こし"],
        "ko": ["MailVault에서 보기", "동영상 대본"],
        "zh": ["在 MailVault 中查看", "视频文字稿"],
        "pt-br": ["Veja no MailVault", "Transcrição do vídeo"],
    }
    values = {}
    for name, translated in LOCALES[locale].items():
        english = LOCALES["en"][name]
        values[english[0]] = translated[0]
        values[" ".join(english[1:])] = " ".join(translated[1:])
    values.update(zip(["See it in MailVault", "Video transcript"], headings[locale]))
    return {hashlib.sha1(" ".join(source.split()).encode()).hexdigest()[:12]: target for source, target in values.items()}


def run(*args):
    return subprocess.run(args, check=True, capture_output=True).stdout


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stamp(width, text):
    height = round(width * 44 / 960)
    footer = Image.new("RGB", (width, height), "#171717")
    font = ImageFont.truetype("/System/Library/Fonts/SFNSMono.ttf", round(width * 19 / 960))
    draw = ImageDraw.Draw(footer)
    draw.line((0, 0, width, 0), fill="#424242")
    draw.text((round(width * 18 / 960), height // 2), text, font=font, fill="#eeeeee", anchor="lm")
    return footer


def clock(seconds):
    milliseconds = round(seconds * 1000)
    return f"{milliseconds // 3600000:02}:{milliseconds // 60000 % 60:02}:{milliseconds // 1000 % 60:02}.{milliseconds % 1000:03}"


def publish(source):
    job = read(source / "job.json")
    if job.get("appVersion") != "2.20.0" or job.get("builds") != 1 or job.get("groups") != ["help-media"]:
        raise ValueError("not the approved 2.20.0 single-build help-media capture")
    if (source / "exit.txt").read_text().strip() != "job exit 0":
        raise ValueError("capture job did not finish successfully")
    evidence = "assets/help-media/capture-evidence.json"
    manifest = {
        "version": job["appVersion"], "captureCommit": job["sourceCommit"], "evidence": "/" + evidence,
        "captureKind": "capture", "recordedAt": job["startedLocal"], "captureHost": job["host"],
        "provenance": [
            "New ScreenCaptureKit recordings of the real Tauri app running on the Mac mini through testq + minijob.",
            "UI language and fictional demo mailbox use the locale catalog. Dark graphite theme; fresh profile per locale.",
            "The capture build enables webdriver; the harness hides the sidebar version and button focus rings. No app UI is redrawn.",
            "Search is prepared with a local archive and cut between query entry and results. Backup destination is a write-tested temporary folder, not a physical external drive; setup is off camera, and longer waits may be cut.",
            "Images and posters are decoded from these new raw recordings at a representative moment; the manifest records the source time and crop. Search stills retain the query panel alongside the results. MP4s use the feature-card crops and trims from those same recordings. A version/locale footer is added below the UI.",
        ], "locales": {},
    }
    audit = {"job": job, "locales": {}}
    guard_path = source / "preflight-guard.json"
    if guard_path.exists():
        audit["preflightGuard"] = read(guard_path)
    display_log = source / "display-adjustment.log"
    if display_log.exists():
        audit["displayAdjustment"] = display_log.read_text().strip().splitlines()
        manifest["provenance"].append("The Mac mini display was temporarily switched to its existing 2x mode before recording; the adjustment log is retained with the evidence.")
    outroot = ROOT / "website/assets/help-media"
    for locale, workflows in LOCALES.items():
        local = source / locale
        checks = read(local / "check.json")
        assertions = read(local / "record/verify.json")
        geometry = read(local / "record/help-media/geometry.json")
        facts = read(local / "record/help-media/web-clips.facts.json")
        expected_locale = {"pt-br": "pt-BR", "zh": "zh-Hans"}.get(locale, locale)
        if facts["locale"] != expected_locale or job["appVersion"] not in (geometry.get("versionLabel", {}).get("text") or ""):
            raise ValueError(f"locale/build evidence mismatch: {locale}")
        audit["locales"][locale] = {"checks": checks, "assertions": assertions, "geometry": geometry, "facts": facts, "recordings": {}}
        launch_guard = local / "record/help-media/launch-guard.json"
        if launch_guard.exists():
            audit["locales"][locale]["launchGuard"] = read(launch_guard)
        out = outroot / locale
        out.mkdir(parents=True, exist_ok=True)
        manifest["locales"][locale] = {"appLocale": facts["locale"], "workflows": {}}
        for name, (description, action, outcome) in workflows.items():
            check = next(c for c in checks["clips"] if c["clip"] == name)
            verdict = next(c for c in assertions["clips"] if c["clip"] == name)
            if not check["ok"] or not verdict["pass"]:
                raise ValueError(f"unverified recording: {locale}/{name}: {check}")
            report = read(local / f"web/{name}.report.json")
            spec = read(local / f"web/{name}.spec.json")
            poster_time = report["poster"]["t"]
            if name == "search-local":
                elapsed = 0
                for segment in spec["segments"]:
                    length = segment["t1"] - segment["t0"]
                    if segment.get("label") == "results":
                        poster_time = elapsed + length / 2
                        break
                    elapsed += length
            stats = read(local / f"takes/{name}.stats.json")
            recorder = read(local / f"takes/{name}.mov.json")
            census = read(local / f"takes/{name}.census.json")
            if stats.get("blankSuspect") or recorder.get("blankSuspect"):
                raise ValueError(f"blank recording: {locale}/{name}")
            if census["probe"].get("theme") != "dark":
                raise ValueError(f"wrong theme: {locale}/{name}")
            audit["locales"][locale]["recordings"][name] = {"recorder": recorder, "frames": stats, "census": census}
            label = f"MailVault version {job['appVersion']} {locale}"
            alt = f"{description} · {label}"
            base = f"/assets/help-media/{locale}/{name}"
            video = out / f"{name}.mp4"
            with tempfile.TemporaryDirectory(prefix="mv-help-encode-") as temporary:
                temp = Path(temporary)
                footer = temp / "footer.png"
                stamp(960, label).save(footer)
                run("ffmpeg", "-y", "-v", "error", "-i", str(local / f"web/{name}.mp4"), "-i", str(footer),
                    "-filter_complex", "[0:v]pad=iw:ih+44:0:0:color=0x171717[p];[p][1:v]overlay=0:H-h:format=auto,format=yuv420p[v]",
                    "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "19", "-preset", "slow", "-movflags", "+faststart", str(video))
                t = poster_time
                for segment in spec["segments"]:
                    duration = segment["t1"] - segment["t0"]
                    if t < duration:
                        source_time = segment["t0"] + t
                        crop = segment.get("crop", spec["crop"])
                        break
                    t -= duration
                else:
                    raise ValueError("poster outside source segments")
                if name == "search-local":
                    # Help stills retain the query panel alongside the genuine
                    # results. Feature-card video crops intentionally omit it.
                    crop = next(segment["crop"] for segment in spec["segments"] if segment.get("label") == "typing")
                scale = spec.get("scale", 2)
                x, y, width, height = [round(value * scale) for value in crop]
                raw = temp / "source.png"
                run("ffmpeg", "-y", "-v", "error", "-ss", str(source_time), "-i", str(local / f"takes/{name}.mov"),
                    "-frames:v", "1", "-vf", f"crop={width}:{height}:{x}:{y},scale=1440:990:flags=lanczos", str(raw))
                image = Image.open(raw).convert("RGB")
                footer_image = stamp(image.width, label)
                final = Image.new("RGB", (image.width, image.height + footer_image.height))
                final.paste(image, (0, 0))
                final.paste(footer_image, (0, image.height))
                final.save(out / f"{name}.webp", "WEBP", quality=90, method=6)
                final.resize((960, 704), Image.Resampling.LANCZOS).save(out / f"{name}.jpg", "JPEG", quality=91, optimize=True)
            probe = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video)))
            stream = probe["streams"][0]
            if stream["codec_name"] != "h264" or stream["width"] != 960 or stream["height"] != 704 or len(probe["streams"]) != 1:
                raise ValueError("invalid final media")
            duration = float(probe["format"]["duration"])
            split = min(spec["segments"][0]["t1"] - spec["segments"][0]["t0"], duration / 2) if name == "search-local" else duration / 2
            captions = f"WEBVTT\n\n00:00:00.000 --> {clock(split)}\n{action}\n\n{clock(split)} --> {clock(duration)}\n{outcome}\n"
            (out / f"{name}.vtt").write_text(captions)
            files = {ext: out / f"{name}.{ext}" for ext in ["mp4", "webp", "jpg", "vtt"]}
            manifest["locales"][locale]["workflows"][name] = {
                "image": base + ".webp", "imageAlt": alt, "video": base + ".mp4", "videoLabel": alt,
                "poster": base + ".jpg", "posterAlt": alt, "captions": base + ".vtt", "transcript": [action, outcome],
                "duration": duration, "imageSize": [1440, 1056], "videoSize": [960, 704], "stamp": label,
                "captureVersion": job["appVersion"], "captureCommit": job["sourceCommit"], "captureLocale": facts["locale"],
                "recordingVerified": True, "recordingFrames": stats.get("frames"), "sourceSHA256": digest(local / f"takes/{name}.mov"),
                "posterSeconds": round(poster_time, 4), "sourceFrameSeconds": round(source_time, 4), "sourceCropPixels": [x, y, width, height],
                "sha256": {ext: digest(path) for ext, path in files.items()},
            }
            print(f"Published {locale}/{name}: {duration:.2f}s")
    (ROOT / "website" / evidence).write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "website/help-media.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    for locale in LOCALES:
        if locale == "en":
            continue
        dictionary = ROOT / f"website/i18n/locales/{locale}/help-center.json"
        values = read(dictionary) if dictionary.exists() else {}
        values.update(media_translations(locale))
        dictionary.write_text(json.dumps(values, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    publish(parser.parse_args().source.resolve())
