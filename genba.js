/* 現場の書類(genba-shorui)の中心: 現場のメモ → 日報 → 見積 → 請求書(適格請求書)。
   通信しない・標準の部品だけ。請求書の検査は jp-invoice-check と同じ決まり(JPInvoice)を使う。MIT・nexus-tools */
(function (root) {
  "use strict";
  var VERSION = "0.1.0";
  var MAX_ITEMS = 300;              // 1つの書類の品目の上限(大きすぎる入力で固まらないため)
  var MAX_YEN = 100000000000;       // 1行の金額の上限 1,000億円(打ち間違いを止める)
  var J = root.JPInvoice || (typeof require === "function" ? require("./jpinvoice_core.js") : null);

  function nfkc(s) { return String(s == null ? "" : s).normalize("NFKC"); }
  function err(m) { var e = new Error(m); e.ja = true; return e; }

  // 単位(よく使うもの)。数字の直後に来たら単位として読む
  var UNITS = ["m2", "m²", "㎡", "平米", "m3", "㎥", "m", "メートル", "本", "枚", "箇所", "ヶ所", "か所", "カ所", "個", "台", "式", "人工", "人", "日", "時間", "h", "kg", "t", "袋", "缶", "巻", "セット", "組", "坪", "回", "件", "缶"];
  var UNIT_NORMAL = {"m2": "㎡", "m²": "㎡", "平米": "㎡", "m3": "㎥", "メートル": "m", "ヶ所": "箇所", "か所": "箇所", "カ所": "箇所", "h": "時間"};

  // 数量は小数2桁まで(12.5㎡ など)。内部は100倍した整数で持ち、丸めの誤差を出さない
  function parseQty(s) {
    var t = nfkc(s).replace(/,/g, "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    var p = t.split("."), frac = (p[1] || "").padEnd(2, "0");
    return parseInt(p[0], 10) * 100 + parseInt(frac || "0", 10);
  }
  function parseYen(s) {
    var t = nfkc(s).replace(/[,円¥\\\s]/g, "");
    var m = /^(\d+)(万)?$/.exec(t);
    if (!m) return null;
    var v = parseInt(m[1], 10) * (m[2] ? 10000 : 1);
    return Number.isSafeInteger(v) ? v : null;
  }
  function qtyText(q100) { var i = Math.floor(q100 / 100), f = q100 % 100; return f ? i + "." + String(f).padStart(2, "0").replace(/0$/, "") : String(i); }

  // 1行の金額 = 数量 × 単価。円未満は切り捨て(小数の数量のときだけ起きる)
  function lineAmount(item) {
    var v = Math.floor(item.qty100 * item.unit_price / 100);
    if (!Number.isSafeInteger(v) || v > MAX_YEN) throw err("「" + item.description + "」の金額が大きすぎます(1行 " + MAX_YEN.toLocaleString("ja-JP") + "円まで)。");
    return v;
  }

  // メモの1行を品目に読む。例: 「クロス張替え 12.5㎡ @1,200」「解体 1式 3万円」「養生 2日 × 8000」
  // 数量と単価が読めない行は品目にせず、日報の「作業の記録」に残す(勝手に値段を作らない)
  var UNIT_RE = UNITS.slice().sort(function (a, b) { return b.length - a.length; }).map(function (u) { return u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|");
  var LINE_RE = new RegExp("^(.+?)[\\s ]+(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*(" + UNIT_RE + ")\\s*(?:[@×xX*]|単価)\\s*([\\d,]+(?:万)?)\\s*円?\\s*$");
  var LINE_RE2 = new RegExp("^(.+?)[\\s ]+(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*(" + UNIT_RE + ")\\s+([\\d,]+(?:万)?)\\s*円\\s*$");
  function parseLine(line) {
    var t = nfkc(line).trim();
    if (!t) return null;
    var reduced = /※|軽減/.test(t);
    t = t.replace(/※|\(軽減\)|軽減/g, "").trim();
    var m = LINE_RE.exec(t) || LINE_RE2.exec(t);
    if (!m) return {note: nfkc(line).trim()};
    var qty = parseQty(m[2]), price = parseYen(m[4]);
    if (qty == null || price == null || qty === 0) return {note: nfkc(line).trim()};
    var unit = UNIT_NORMAL[m[3]] || m[3];
    return {item: {description: m[1].trim(), qty100: qty, unit: unit, unit_price: price, rate: reduced ? 8 : 10, reduced: reduced}};
  }

  function parseMemo(text) {
    var lines = nfkc(text).split(/\r?\n/), items = [], notes = [];
    lines.forEach(function (l) {
      var r = parseLine(l);
      if (!r) return;
      if (r.item) items.push(r.item); else notes.push(r.note);
    });
    if (items.length > MAX_ITEMS) throw err("品目が多すぎます(" + items.length + "件)。1つの書類は " + MAX_ITEMS + " 件までです。");
    return {items: items, notes: notes};
  }

  // ---- 日報 ----
  function makeReport(input) {
    input = input || {};
    var site = nfkc(input.site).trim();
    if (!site) throw err("現場名を入れてください。");
    var date = nfkc(input.date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z")) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) throw err("日付は 2026-11-16 の形で、暦にある日を入れてください。");
    var memo = parseMemo(input.memo || "");
    var workers = (input.workers || []).map(function (w) {
      var name = nfkc(w.name).trim(), h = parseQty(w.hours == null ? "" : String(w.hours));
      if (!name) throw err("作業した人の名前が空です。");
      if (h == null || h > 2400) throw err(name + " さんの作業時間は 0〜24 の数で入れてください(例: 8 や 7.5)。");
      return {name: name, hours100: h};
    });
    return {kind: "report", site: site, date: date, weather: nfkc(input.weather).trim(), workers: workers,
      notes: memo.notes, items: memo.items, photos: (input.photos || []).map(function (p) { return nfkc(p).trim(); }).filter(Boolean)};
  }

  // ---- 見積(日報の品目をそのまま流す。打ち直さない) ----
  function makeEstimate(report, opts) {
    opts = opts || {};
    var items = (report.items || []).map(function (it) {
      var c = {description: it.description, qty100: it.qty100, unit: it.unit, unit_price: it.unit_price, rate: it.rate, reduced: !!it.reduced};
      c.amount = lineAmount(c);
      return c;
    });
    if (!items.length) throw err("見積にする品目がありません。メモに「品名 数量単位 @単価」の行を書いてください(例: クロス張替え 12㎡ @1200)。");
    var est = {kind: "estimate", site: report.site, date: opts.date || report.date, buyer: nfkc(opts.buyer).trim(),
      valid_days: opts.valid_days || 30, price_basis: "exclusive", rounding: opts.rounding || "floor", items: items};
    est.totals = totalsByRate(items, est.price_basis, est.rounding);
    return est;
  }

  // 税率ごとに合計してから1回だけ端数処理する(品目ごとに丸めない)
  function totalsByRate(items, basis, rounding) {
    var sums = {};
    items.forEach(function (it) { sums[it.rate] = (sums[it.rate] || 0) + it.amount; });
    return Object.keys(sums).map(Number).sort(function (a, b) { return b - a; }).map(function (rate) {
      return {rate: rate, amount: sums[rate], tax: J.expectedTax(sums[rate], rate, basis, rounding)};
    });
  }

  // ---- 請求書(適格請求書)。作ったら jp-invoice-check と同じ決まりで検査して返す ----
  function makeInvoice(estimate, issuer, opts) {
    opts = opts || {};
    issuer = issuer || {};
    var inv = {
      issuer: {name: nfkc(issuer.name).trim(), registration_number: nfkc(issuer.registration_number).replace(/[\s\-‐−ー―]/g, "").toUpperCase()},
      buyer: {name: nfkc(opts.buyer || estimate.buyer).trim()},
      date: opts.date || estimate.date,
      price_basis: estimate.price_basis, rounding: estimate.rounding,
      items: estimate.items.map(function (it) { return {description: it.description + "(" + qtyText(it.qty100) + it.unit + " × " + it.unit_price.toLocaleString("ja-JP") + "円)", amount: it.amount, rate: it.rate, reduced: it.reduced}; }),
      totals: estimate.totals.map(function (t) { return {rate: t.rate, amount: t.amount, tax: t.tax}; })
    };
    var check = J.checkInvoice(inv, null, "issue");
    var total = inv.totals.reduce(function (s, t) { return s + t.amount + t.tax; }, 0);
    return {kind: "invoice", site: estimate.site, invoice: inv, check: check, grand_total: total};
  }

  // メモ1つから3つの書類をまとめて作る(画面とテストの入口)
  function fromMemo(input, issuer, opts) {
    var r = makeReport(input), e = makeEstimate(r, opts), i = makeInvoice(e, issuer, opts);
    return {report: r, estimate: e, invoice: i};
  }

  var api = {VERSION: VERSION, MAX_ITEMS: MAX_ITEMS, parseLine: parseLine, parseMemo: parseMemo, parseQty: parseQty, parseYen: parseYen, qtyText: qtyText,
    lineAmount: lineAmount, makeReport: makeReport, makeEstimate: makeEstimate, makeInvoice: makeInvoice, totalsByRate: totalsByRate, fromMemo: fromMemo};
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Genba = api;
})(this);
