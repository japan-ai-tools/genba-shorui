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
        self.assertNotRegex(page, r"\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|<script[^>]+src=")
        # link はホーム画面のアプリ用の、同じ場所の manifest とアイコンだけ(0.3.0)
        for href in re.findall(r"<link[^>]+href=\"([^\"]+)\"", page):
            self.assertIn(href, ("manifest.webmanifest", "icon-192.png"), href)
        self.assertIn("connect-src 'none'", page)
        for url in re.findall(r"https?://[^\s\"'<)]+", page):
            self.assertTrue(url.startswith("https://www.nta.go.jp/"), url)   # 出典の表示だけ

    def test_no_speech_api(self):
        # 声はOSのキーボードの音声入力に任せる(ブラウザの音声認識は外のサーバーに送る場合がある)
        self.assertNotIn("SpeechRecognition", build.build())

    def test_speech_split_button(self):
        # 0.5.0: 話した文を行に分けるボタン。声を文字にするのはキーボードで、外に送り得ることを画面に書く
        page = build.build()
        self.assertIn('id="speech-split"', page)
        self.assertIn("G.fromSpeech(", page)
        self.assertIn("このページは音声を扱いません", page)
        self.assertIn("外のサーバーで文字になります", page)


class TestFirstTen(unittest.TestCase):
    """0.4.0: 開いて10秒で結果(戦略 0h)。見本が最初から入り、1回で3つの書類・画像で保存"""

    def test_first_visit_has_sample_and_one_button(self):
        page = build.build()
        self.assertIn('id="try-make"', page)
        self.assertIn("if (firstVisit) fillSample();", page)
        # 見本の名前・番号は架空だと画面に書く
        self.assertIn("架空", page)

    def test_png_save_is_local(self):
        page = build.build()
        for k in ("report", "estimate", "invoice"):
            self.assertIn(f"data-png='{k}'", page)
        self.assertIn('toBlob(', page)
        self.assertIn("URL.createObjectURL", page)
        self.assertNotIn("toDataURL", page.split("function docToCanvas")[1].split("$(\"docs\").addEventListener")[0])

    def test_try_button_comes_before_inputs(self):
        page = build.build()
        self.assertLess(page.index('id="try"'), page.index("1. 今日の現場"))


class TestPwa(unittest.TestCase):
    """0.3.0: ホーム画面に入れて電波なしで開けるアプリの形(PWA)。通信しない約束は変えない"""

    def test_manifest(self):
        import json
        m = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(m["display"], "standalone")
        self.assertEqual(m["start_url"], "./")
        sizes = {i["sizes"] for i in m["icons"]}
        self.assertTrue({"192x192", "512x512"} <= sizes)
        self.assertTrue(any(i.get("purpose") == "maskable" for i in m["icons"]))
        for i in m["icons"]:
            p = ROOT / i["src"]
            self.assertTrue(p.exists(), i["src"])
            w, h = (int(x) for x in i["sizes"].split("x"))
            data = p.read_bytes()
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual((int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")), (w, h))

    def test_service_worker_stays_local(self):
        sw = (ROOT / "sw.js").read_text(encoding="utf-8")
        self.assertNotRegex(sw, r"https?://")                 # 外の場所を書かない
        self.assertIn("self.location.origin", sw)             # 同じ場所の GET だけを扱う
        self.assertIn('req.method !== "GET"', sw)
        self.assertNotRegex(sw, r"XMLHttpRequest|WebSocket|sendBeacon|importScripts|postMessage")
        cache = re.search(r'CACHE = "genba-shorui-([0-9.]+)"', sw).group(1)
        version = re.search(r'VERSION = "([0-9.]+)"', (ROOT / "genba.js").read_text(encoding="utf-8")).group(1)
        self.assertEqual(cache, version, "版を上げたら sw.js の CACHE も上げる(古い部品が残らないように)")
        for f in re.findall(r'"\./([^"]*)"', sw):
            if f:
                self.assertTrue((ROOT / f).exists(), f)

    def test_page_links_app_parts(self):
        page = build.build()
        self.assertIn('rel="manifest" href="manifest.webmanifest"', page)
        self.assertIn("manifest-src 'self'", page)
        self.assertIn("worker-src 'self'", page)
        self.assertIn('location.protocol === "https:"', page)  # ファイルを直接開いた時は登録しない


if __name__ == "__main__":
    unittest.main()
