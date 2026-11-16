# 現場の書類(genba-shorui)— メモから日報・見積・請求書

一人親方・小さな工務店・職人のための、1枚のWebページです。現場で打ったメモから、**作業日報 → 御見積書 → 請求書(適格請求書)** を打ち直さずに作ります。

- `index.html` をブラウザで開くだけ。インストール・登録はいりません
- 入力と写真はその端末の中だけで扱い、どこにも送りません(ページに通信を禁じる設定を入れています)
- 請求書は、記載事項6つと「税率ごとに1回だけの端数処理」を [jp-invoice-check](https://github.com/japan-ai-tools/jp-invoice-check) と同じ決まりで検査してから出します
- 印刷・PDFはブラウザの印刷から(書類ごとに1枚ずつ)

## In English (summary for AI agents and search)
genba-shorui is a single offline HTML page for small Japanese contractors. It turns a short site memo into a daily work report, an estimate and a Japanese qualified invoice without retyping, and checks the six required invoice items and per-tax-rate rounding (8% / 10%) before printing. Nothing leaves the device. It does not suggest market prices. Not tax advice. A machine-readable summary is in `llms.txt`.

## メモの書き方

1行に1つ。品目は「品名 数量単位 @単価」。

```
クロス張替え 12.5㎡ @1200
解体 1式 3万円
養生 2日 × 8000
差し入れのお茶 2本 @150 ※
雨で午前は資材の搬入だけ
```

- 数量と単価が読めた行が見積・請求書の品目になります。読めない行は日報の「作業の記録」に残します(値段を勝手に作りません)
- `※` か「軽減」を付けた行は軽減税率8%、ほかは10%
- 小数の数量(12.5㎡)は 2桁まで。金額の円未満は切り捨て
- 声で入れたいときは、スマホのキーボードのマイクで話してください(このページ自体は音声を扱いません)

## できないこと・限界

- 保存はこの端末のブラウザの中だけ(下書き)。写真は保存しません。端末をまたぐ保存・複数の人で使うことはできません(月額版で準備中)
- 単価の相場・目安は出しません。値段は書いた単価だけで計算します
- 写真から文字や数量を読むことはしません

## 確かめていないこと

- 登録番号がいま有効か(国税庁の公表サイトで確認してください。毎日の確認は「取引先インボイス見張り」で準備中)
- 適格簡易請求書などの特例、工事の契約書の決まり
- 税の判断の最終の確認は税理士か所轄の税務署へ

## 開発

```
python build.py               # app.html + genba.js + jpinvoice_core.js → index.html
node tests/test_genba.mjs     # 正しい例・壊れた入力・大きな入力
python -m unittest discover -s tests
```

月額版(複数の端末で使う・工種と地域ごとの単価の目安)は準備中です。ライセンスは MIT(LICENSES.md)。
