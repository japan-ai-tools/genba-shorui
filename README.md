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

## 見積の内訳(材料費・労務費・法定福利費など)

改正建設業法(2025年12月12日に全面施行)では、材料費・労務費などの内訳を明示した見積を作ることが努力義務になりました。行の頭か終わりに区分の札を付けると、見積に「内訳(税抜)」の表を出します。

```
[材料] クロス 12.5㎡ @600
[労務] クロス張り 1人工 @25000
[法定福利] 法定福利費相当額 1式 @3800
[安全] 安全帯 1式 @2000
解体 1式 3万円
```

- 札は `[材料]` `[労務]` `[法定福利]` `[安全]` `[建退共]`(【】でも可)。単位が「人工」の行は札がなくても労務費。札のない行は「その他」
- 労務費の行がない、または労務費はあるのに法定福利費の行がないときは、画面にお知らせを出します(止めません。書くかどうかは使う人が決めます)
- 一人親方の国民健康保険・国民年金は本人の負担で、法定福利費そのものではありません。請負代金に反映させる「法定福利費相当額」として行を作る様式が、建設業の団体から出ています(例: [埼玉土建の一人親方向けの見積書の手引き](https://www.saitama-doken.or.jp/wordpress/wp-content/uploads/2026/03/5ba8ce50f9017207a5f1d24a1e3944ad.pdf))
- 単位が「人工」の行があると、1人工あたりの単価を並べて「比べるときの注意」を出します(0.2.1)。[公共工事設計労務単価](https://www.mlit.go.jp/report/press/tochi_fudousan_kensetsugyo14_hh_000001_00337.html)(令和8年3月から適用・47都道府県×51職種・8時間あたり)は、事業主が負担する必要経費(法定福利費の事業主負担分・安全管理費など)を**含まない**値で、それを加えた参考値は括弧書きで別に示されています。どちらと比べているかを取り違えやすいためです
- このページは金額の妥当さ(労務費の基準を著しく下回っていないか)は判断しません。法律の最終の確認は専門家へ

In English: optional cost-category tags (`[材料]` materials, `[労務]` labour, `[法定福利]` statutory welfare costs, `[安全]` safety, `[建退共]` retirement mutual aid) add a breakdown table to the estimate. Japan's amended Construction Business Act (fully in force 2025-12-12) asks contractors to make an effort to show such a breakdown. The page shows a non-blocking notice when labour or welfare lines are missing; it does not judge whether prices are adequate.

## 開いて10秒で試す・画像で保存(0.4.0)

はじめて開くと、欄に見本(架空の名前・番号)が入っています。上の「見本で3つの書類を作る」を1回押すと、日報・見積書・請求書ができます。どの書類も「画像で保存」で PNG にできます(画面の文字と表を端末の中で描き直すだけで、どこにも送りません)。自分の現場で使うときは「入力を消す」を押してから書き直してください。

In English: on first open the form is pre-filled with a fictional sample; one tap produces the daily report, estimate and invoice. Each document can be saved as a PNG drawn locally on a canvas (nothing is sent anywhere).

## スマホのホーム画面に入れる(アプリの形・0.3.0)

公開のページ(https で置いたもの)をスマホで開き、ホーム画面に入れると、アプリのようにアイコンから開けます。一度開いたあとは、電波のない現場でも開けます。

- Android(Chrome): メニュー →「ホーム画面に追加」または「アプリをインストール」
- iPhone(Safari): 共有ボタン →「ホーム画面に追加」
- 端末に残すのはこのページの部品(`index.html`・`manifest.webmanifest`・アイコン)だけです。入力・写真はこれまでどおりどこにも送りません(ページの通信の禁止はそのまま。`sw.js` は同じ場所の部品の読み込みだけを扱います)
- `index.html` をファイルとして直接開いた時は、これまでどおり1枚のページとして動きます(ホーム画面のアプリにはなりません)

In English: hosted over https, the page is an installable web app (PWA). Add it to the home screen and it opens like an app and works offline after the first visit. The service worker only caches the page's own files; network access from the page stays blocked.

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
