// node tests/test_genba.mjs — 正しい例・壊れた入力・大きな入力
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const G = require("../genba.js");
const J = require("../jpinvoice_core.js");
let n = 0;
function t(name, fn) { fn(); n++; }
const ISSUER = { name: "見本 田中内装", registration_number: "T9000000000000" };

t("メモの行を品目に読む", () => {
  const r = G.parseLine("クロス張替え 12.5㎡ @1,200");
  assert.deepEqual(r.item, { description: "クロス張替え", qty100: 1250, unit: "㎡", unit_price: 1200, rate: 10, reduced: false });
  assert.equal(G.parseLine("解体 1式 3万円").item.unit_price, 30000);
  assert.equal(G.parseLine("養生 2日 × 8000").item.qty100, 200);
  assert.equal(G.parseLine("ボード ２０枚 ＠８５０").item.unit_price, 850);   // 全角
  assert.equal(G.parseLine("下地 3 m2 単価 2000").item.unit, "㎡");
  const tea = G.parseLine("お茶 2本 @150 ※").item;
  assert.equal(tea.rate, 8); assert.equal(tea.reduced, true);
});
t("値段が読めない行は品目にしない(値段を作らない)", () => {
  assert.ok(G.parseLine("雨で午後は室内作業").note);
  assert.ok(G.parseLine("クロス 12㎡").note);           // 単価なし
  assert.ok(G.parseLine("クロス 0㎡ @1200").note);      // 数量0
  assert.equal(G.parseLine("   "), null);
});
t("小数の数量は円未満を切り捨てる", () => {
  assert.equal(G.lineAmount({ description: "x", qty100: 1233, unit_price: 333 }), 4105); // 12.33*333=4105.89
  assert.equal(G.qtyText(1250), "12.5"); assert.equal(G.qtyText(1205), "12.05"); assert.equal(G.qtyText(300), "3");
});
t("正しい例: 日報→見積→請求書が流れ、検査を通る", () => {
  const out = G.fromMemo({ site: "見本 山田様邸", date: "2026-11-16", memo: "クロス張替え 12.5㎡ @1200\n養生 1式 8000円\n雨で午前は搬入\nお茶 2本 @150 ※", workers: [{ name: "田中", hours: "7.5" }] }, ISSUER, { buyer: "見本 山田 太郎 様" });
  assert.equal(out.report.notes[0], "雨で午前は搬入");
  assert.equal(out.report.workers[0].hours100, 750);
  assert.deepEqual(out.estimate.totals, [{ rate: 10, amount: 23000, tax: 2300 }, { rate: 8, amount: 300, tax: 24 }]);
  assert.equal(out.invoice.grand_total, 25624);
  assert.equal(out.invoice.check.ok, true, JSON.stringify(out.invoice.check.errors));
  assert.equal(out.invoice.check.warnings.length, 0);
  assert.equal(out.estimate.items.length, out.invoice.invoice.items.length);   // 打ち直しなし
});
t("税は税率ごとの合計に1回だけ丸める(品目ごとに丸めない)", () => {
  const memo = "a 1式 @105\nb 1式 @105\nc 1式 @105";   // 品目ごとの切捨て 10+10+10=30、合計315の切捨て=31
  const out = G.fromMemo({ site: "s", date: "2026-11-16", memo }, ISSUER, { buyer: "b" });
  assert.equal(out.estimate.totals[0].tax, 31);
  assert.equal(J.checkInvoice(out.invoice.invoice, null, "issue").ok, true);
  const half = G.fromMemo({ site: "s", date: "2026-11-16", memo }, ISSUER, { buyer: "b", rounding: "ceil" });
  assert.equal(half.estimate.totals[0].tax, 32);
});
t("壊れた入力は日本語のエラー", () => {
  assert.throws(() => G.makeReport({ site: "", date: "2026-11-16" }), /現場名/);
  assert.throws(() => G.makeReport({ site: "s", date: "2026-02-30" }), /暦にある日/);
  assert.throws(() => G.makeReport({ site: "s", date: "16/11/2026" }), /日付/);
  assert.throws(() => G.makeReport({ site: "s", date: "2026-11-16", workers: [{ name: "田中", hours: "25" }] }), /0〜24/);
  assert.throws(() => G.makeReport({ site: "s", date: "2026-11-16", workers: [{ name: "", hours: "8" }] }), /名前/);
  assert.throws(() => G.makeEstimate(G.makeReport({ site: "s", date: "2026-11-16", memo: "片付け" })), /品目がありません/);
  assert.throws(() => G.lineAmount({ description: "x", qty100: 100000000, unit_price: 100000000 }), /大きすぎ/);
});
t("請求書の記載漏れは検査が名前で返す", () => {
  const out = G.fromMemo({ site: "s", date: "2026-11-16", memo: "a 1式 @1000" }, { name: "", registration_number: "123" }, {});
  const codes = out.invoice.check.errors.map((e) => e.code);
  assert.ok(codes.includes("E_ISSUER_NAME_MISSING"));
  assert.ok(codes.includes("E_REGNO_FORMAT"));
  assert.ok(codes.includes("E_BUYER_MISSING"));
  assert.equal(out.invoice.check.ok, false);
});
t("大きな入力: 300件までは作れて、301件は止める", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `品目${i} 1.5㎡ @${1000 + i}`).join("\n");
  const out = G.fromMemo({ site: "s", date: "2026-11-16", memo: lines }, ISSUER, { buyer: "b" });
  assert.equal(out.estimate.items.length, 300);
  assert.equal(out.invoice.check.ok, true);
  assert.throws(() => G.parseMemo(lines + "\n追加 1式 @1"), /多すぎ/);
  assert.equal(G.parseMemo("x".repeat(200000)).items.length, 0);   // 長い1行でも固まらない
});
t("見積の内訳: 区分の札と人工を読む", () => {
  assert.equal(G.parseLine("[材料] クロス 12.5㎡ @600").item.category, "材料費");
  assert.equal(G.parseLine("【労務】 クロス張り 1人工 @25000").item.category, "労務費");
  assert.equal(G.parseLine("大工 2人工 @28000").item.category, "労務費");            // 人工は労務費
  assert.equal(G.parseLine("法定福利費相当額 1式 @3800 [法定福利]").item.category, "法定福利費");
  assert.equal(G.parseLine("[安全] 安全帯 1式 @2000").item.description, "安全帯");   // 札は品名に残さない
  assert.equal(G.parseLine("クロス 1㎡ @600").item.category, undefined);
  assert.ok(G.parseLine("[労務] 片付け").note);                                     // 値段なしは品目にしない
});
t("見積の内訳: 区分ごとの合計とお知らせ", () => {
  const memo = "[材料] クロス 12.5㎡ @600\n[労務] クロス張り 1人工 @25000\n[法定福利] 法定福利費相当額 1式 @3800\n解体 1式 3万円";
  const out = G.fromMemo({ site: "s", date: "2026-11-16", memo }, ISSUER, { buyer: "b" });
  assert.deepEqual(out.estimate.breakdown, [{ category: "材料費", amount: 7500 }, { category: "労務費", amount: 25000 }, { category: "法定福利費", amount: 3800 }, { category: "その他", amount: 30000 }]);
  assert.equal(out.estimate.breakdown.reduce((s, b) => s + b.amount, 0), out.estimate.totals.reduce((s, t) => s + t.amount, 0));
  assert.deepEqual(out.estimate.notices.map((x) => x.code), ["I_LABOR_DAY_RATE"]);   // 人工の行があるときは単価の比べ方だけ知らせる
  assert.equal(out.invoice.check.ok, true);
  const noLabor = G.fromMemo({ site: "s", date: "2026-11-16", memo: "クロス 1㎡ @600" }, ISSUER, { buyer: "b" });
  assert.deepEqual(noLabor.estimate.notices.map((x) => x.code), ["I_LABOR_NOT_SHOWN"]);
  const noWelfare = G.fromMemo({ site: "s", date: "2026-11-16", memo: "大工 1人工 @28000" }, ISSUER, { buyer: "b" });
  assert.deepEqual(noWelfare.estimate.notices.map((x) => x.code), ["I_WELFARE_NOT_SHOWN", "I_LABOR_DAY_RATE"]);
});
t("1人工あたりの単価: 設計労務単価と比べるときの注意(判断はしない)", () => {
  const out = G.fromMemo({ site: "s", date: "2026-11-17", memo: "大工 2人工 @28000\n[労務] 手元 1人工 @18000\n[法定福利] 法定福利費相当額 1式 @5000" }, ISSUER, { buyer: "b" });
  const m = out.estimate.notices.find((x) => x.code === "I_LABOR_DAY_RATE");
  assert.ok(m.message_ja.includes("大工 28,000円"), m.message_ja);
  assert.ok(m.message_ja.includes("手元 18,000円"));
  assert.ok(m.message_ja.includes("必要経費"));
  assert.ok(!/安い|高い|下回|違反/.test(m.message_ja));                         // 金額の妥当さは言わない
  const noDay = G.fromMemo({ site: "s", date: "2026-11-17", memo: "[労務] 片付け 1式 @9000\n[法定福利] 法定福利 1式 @1000" }, ISSUER, { buyer: "b" });
  assert.equal(noDay.estimate.notices.length, 0);                                 // 人工の行がなければ出さない
  const many = Array.from({ length: 8 }, (_, i) => `職人${i} 1人工 @2000${i}`).join("\n");
  const big = G.fromMemo({ site: "s", date: "2026-11-17", memo: many + "\n[法定福利] 法定福利 1式 @1000" }, ISSUER, { buyer: "b" });
  assert.ok(big.estimate.notices[0].message_ja.includes("ほか3行"));             // 長くしすぎない
});
t("0.4.0 画面: はじめて開くと見本が入り、1回押すと3つの書類ができる(簡単な偽の画面で動かす)", () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const page = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "index.html"), "utf8");
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  scripts.forEach((s) => new Function(s));                                          // 文法の誤りがない
  const els = {}, store = {};
  const el = (id) => els[id] || (els[id] = { id, value: "", innerHTML: "", textContent: "", files: [], h: {},
    addEventListener(ev, fn) { this.h[ev] = fn; }, appendChild() {}, scrollIntoView() { this.scrolled = true; } });
  const ctx = { document: { getElementById: el, body: { className: "" }, createElement: () => ({}) },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    navigator: {}, location: { protocol: "file:" }, confirm: () => { throw new Error("はじめての時は確かめを出さない"); } };
  ctx.window = ctx; vm.createContext(ctx);
  scripts.forEach((s) => vm.runInContext(s, ctx));
  assert.match(el("site").value, /^見本/);                                            // 見本が最初から入る
  assert.ok(store["genba-shorui:draft:v1"]);
  el("try-make").h.click();
  const docs = el("docs").innerHTML;
  for (const w of ["作業日報", "御見積書", "請求書", "記載事項はそろっています", "data-png='invoice'"]) assert.ok(docs.includes(w), w);
  assert.equal(el("msg").innerHTML, "");
  assert.ok(el("docs").scrolled);
});
console.log(`genba tests ok: ${n}`);
