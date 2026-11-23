"""app.html に jpinvoice_core.js・genba.js・xlsx_fill.js を埋め込んで、1枚で動く index.html を作る(標準ライブラリだけ)。"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def build() -> str:
    page = (HERE / "app.html").read_text(encoding="utf-8")
    page = page.replace("/*JPINVOICE*/", (HERE / "jpinvoice_core.js").read_text(encoding="utf-8"))
    page = page.replace("/*GENBA*/", (HERE / "genba.js").read_text(encoding="utf-8"))
    page = page.replace("/*XLSX*/", (HERE / "xlsx_fill.js").read_text(encoding="utf-8"))
    return page


if __name__ == "__main__":
    (HERE / "index.html").write_text(build(), encoding="utf-8", newline="\n")
    print("index.html を作りました")
