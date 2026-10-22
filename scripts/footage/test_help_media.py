"""The published recordings must carry prose the static localizer can find."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("help_media", Path(__file__).with_name("publish-help-media.py"))
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)

class MediaTranslations(unittest.TestCase):
    def test_localized_description_and_transcript_use_english_source_keys(self):
        key = lambda text: hashlib.sha1(text.encode()).hexdigest()[:12]
        values = getattr(media, "media_translations", lambda locale: {})("de")
        self.assertEqual(values.get(key("Enable privacy mode to hide names and addresses")), "Datenschutzmodus aktivieren, um Namen und Adressen zu verbergen")
        self.assertEqual(values[key("Select the privacy shield in the sidebar. Privacy mode masks names and email addresses in the mailbox.")], "Das Datenschutz-Schild in der Seitenleiste auswählen. Der Datenschutzmodus verdeckt Namen und E-Mail-Adressen.")
        self.assertEqual(values[key("Video transcript")], "Videotranskript")

if __name__ == "__main__":
    unittest.main()
