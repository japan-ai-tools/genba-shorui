"""現場の書類: node の試験を走らせ、1枚の index.html が元と同じで、外に通信しないことを確かめる。"""
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import build  # noqa: E402


class TestGenba(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node がない")
    def test_node(self):
        r = subprocess.run(["node", str(ROOT / "tests" / "test_genba.mjs")], capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_index_is_built(self):
        self.assertEqual((ROOT / "index.html").read_text(encoding="utf-8"), build.build(), "python build.py で index.html を作り直してください")

    def test_no_network(self):
        page = build.build()
        self.assertNotRegex(page, r"\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|<script[^>]+src=|<link[^>]+href=")
        self.assertIn("connect-src 'none'", page)
        for url in re.findall(r"https?://[^\s\"'<)]+", page):
            self.assertTrue(url.startswith("https://www.nta.go.jp/"), url)   # 出典の表示だけ

    def test_no_speech_api(self):
        # 声はOSのキーボードの音声入力に任せる(ブラウザの音声認識は外のサーバーに送る場合がある)
        self.assertNotIn("SpeechRecognition", build.build())


if __name__ == "__main__":
    unittest.main()
