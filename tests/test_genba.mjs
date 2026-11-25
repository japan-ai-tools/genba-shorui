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
  assert.deepEqual(out.estimate.notices.map((x) => x.code), ["I_LABOR_DAY_RATE", "I_PUBLIC_FIVE_ITEMS"]);   // 人工の行の単価の比べ方と、5項目の残り
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
  assert.deepEqual(noDay.estimate.notices.map((x) => x.code), ["I_PUBLIC_FIVE_ITEMS"]);   // 人工の行がなければ単価の注意は出さない
  const many = Array.from({ length: 8 }, (_, i) => `職人${i} 1人工 @2000${i}`).join("\n");
  const big = G.fromMemo({ site: "s", date: "2026-11-17", memo: many + "\n[法定福利] 法定福利 1式 @1000" }, ISSUER, { buyer: "b" });
  assert.ok(big.estimate.notices[0].message_ja.includes("ほか3行"));             // 長くしすぎない
});
t("0.6.1 公共工事の見積内訳書の5項目: 労務費と法定福利費を分けた人にだけ、残りを知らせる(止めない)", () => {
  const part = G.fromMemo({ site: "s", date: "2026-11-25", memo: "[材料] クロス 1㎡ @600\n[労務] 片付け 1式 @9000\n[法定福利] 法定福利 1式 @1000" }, ISSUER, { buyer: "b" });
  const m = part.estimate.notices.find((x) => x.code === "I_PUBLIC_FIVE_ITEMS");
  assert.ok(m.message_ja.includes("無い項目: 安全衛生経費・建退共掛金"), m.message_ja);
  assert.ok(m.message_ja.includes("福島県") && m.message_ja.includes("計上不可"));
  assert.ok(!/違反|安い|高い/.test(m.message_ja));                                // 判断はしない
  const all = G.fromMemo({ site: "s", date: "2026-11-25", memo: "[材料] クロス 1㎡ @600\n[労務] 片付け 1式 @9000\n[法定福利] 法定福利 1式 @1000\n[安全] 安全帯 1式 @2000\n[建退共] 掛金 1式 @500" }, ISSUER, { buyer: "b" });
  assert.equal(all.estimate.notices.length, 0);                                   // 5項目そろえば出さない
  const plain = G.fromMemo({ site: "s", date: "2026-11-25", memo: "クロス 1㎡ @600" }, ISSUER, { buyer: "b" });
  assert.ok(!plain.estimate.notices.some((x) => x.code === "I_PUBLIC_FIVE_ITEMS"));   // 内訳を使わない人には出さない
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

t("0.5.0 話した文を行に分ける: 1続きの文 → 品目と作業の記録", () => {
  const m = G.fromSpeech("クロス張り替え12.5平米単価1200円次養生一式8000円次雨で午前は搬入だけ");
  assert.equal(m, "クロス張り替え 12.5㎡ @1200\n養生 1式 8000円\n雨で午前は搬入だけ");
  const p = G.parseMemo(m);
  assert.equal(p.items.length, 2); assert.deepEqual(p.notes, ["雨で午前は搬入だけ"]);
  assert.equal(p.items[0].qty100, 1250); assert.equal(p.items[1].unit_price, 8000);
});
t("0.5.0 話した文: 内訳の札・小数の「点」・人工・かける・軽減", () => {
  assert.equal(G.fromSpeech("材料、クロス12点5平米単価600円。労務、クロス張り一人工単価25000円"), "[材料] クロス 12.5㎡ @600\n[労務] クロス張り 1人工 @25000");
  assert.equal(G.fromSpeech("養生2日かける8000"), "養生 2日 × 8000");
  const tea = G.parseLine(G.fromSpeech("お茶2本単価150円軽減")).item;
  assert.equal(tea.rate, 8); assert.equal(tea.unit_price, 150);
  assert.equal(G.parseLine(G.fromSpeech("石膏ボード9.5mm20枚単価850円")).item.description, "石膏ボード9.5mm");
});
t("0.5.0 話した文: 名前の漢数字・「次回」・3万円は壊さない", () => {
  assert.equal(G.fromSpeech("一宮の現場は雨。解体1式3万円"), "一宮の現場は雨\n解体 1式 3万円");
  assert.equal(G.fromSpeech("次回の打ち合わせは月曜"), "次回の打ち合わせは月曜");
  assert.equal(G.kanjiToInt("二万五千"), 25000); assert.equal(G.kanjiToInt("千二百"), 1200); assert.equal(G.kanjiToInt("一宮"), null);
  assert.equal(G.fromSpeech("単価千二百円でクロス"), "@1200でクロス");   // 読めない形は品目にならない(値段を作らない)
  assert.ok(G.parseLine(G.fromSpeech("単価千二百円でクロス")).note);
  assert.equal(G.fromSpeech(""), "");
  assert.throws(() => G.fromSpeech("あ".repeat(20001)), /長すぎ/);
  const big = G.fromSpeech("クロス1平米単価100円次".repeat(250));   // 大きな入力でも固まらない
  assert.equal(big.split("\n").length, 250);
});

// ---------------- 0.6.0 ----------------
const X = require("../xlsx_fill.js");
const zlib = require("node:zlib");
async function ta(name, fn) { try { await fn(); } catch (e) { e.message = name + ": " + e.message; throw e; } n++; }
const NSM = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", NSR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
// 試験の中でひな形を作る(共有文字列と inlineStr の両方・結合・数式・印刷範囲)
function testTemplate(opts = {}) {
  const ss = ["{{書類名}}", "{{お客様}}", "現場: {{現場名}}", "{{品名}}", "{{数量}}", "{{単位}}", "{{単価}}", "{{金額}}", "合計", "{{請求金額}}", "備考", "No"];
  const s = (i) => `t="s"><v>${i}</v>`;
  const item = `<row r="5" ht="20" customHeight="1"><c r="A5" s="2" t="inlineStr"><is><t>{{No}}</t></is></c><c r="B5" s="2" ${s(3)}</c><c r="C5" s="2"/><c r="D5" s="3" ${s(4)}</c><c r="E5" s="2" ${s(5)}</c><c r="F5" s="3" ${s(6)}</c><c r="G5" s="3" ${s(7)}</c><c r="H5" s="3"><f>D5*F5</f><v>0</v></c></row>`;
  const slots = (opts.slots || 0) ? Array.from({ length: opts.slots }, (_, i) => `<row r="${6 + i}" ht="20" customHeight="1"><c r="A${6 + i}" s="2"/><c r="B${6 + i}" s="2"/><c r="C${6 + i}" s="2"/><c r="D${6 + i}" s="3"/><c r="E${6 + i}" s="2"/><c r="F${6 + i}" s="3"/><c r="G${6 + i}" s="3"/><c r="H${6 + i}" s="3"/></row>`).join("") : "";
  const L = 5 + (opts.slots || 0), sumRow = L + 2;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NSM}" xmlns:r="${NSR}"><dimension ref="A1:H${sumRow + 1}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="2" max="3" width="20" customWidth="1"/></cols><sheetData>` +
    `<row r="1"><c r="A1" s="1" ${s(0)}</c></row><row r="2"><c r="A2" ${s(1)}</c><c r="E2" t="inlineStr"><is><t>{{日付}}</t></is></c></row><row r="3"><c r="A3" ${s(2)}</c></row>` +
    `<row r="4"><c r="A4" ${s(11)}</c></row>` + item + slots +
    `<row r="${sumRow}"><c r="F${sumRow}" ${s(8)}</c><c r="G${sumRow}"><f>SUM(G5:G${L})</f><v>0</v></c><c r="H${sumRow}" ${s(9)}</c></row>` +
    `<row r="${sumRow + 1}"><c r="A${sumRow + 1}" ${s(10)}</c><c r="B${sumRow + 1}" t="inlineStr"><is><t>{{備考}}</t></is></c></row></sheetData>` +
    `<mergeCells count="4"><mergeCell ref="A1:H1"/><mergeCell ref="B5:C5"/><mergeCell ref="F${sumRow}:G${sumRow}"/><mergeCell ref="B${sumRow + 1}:H${sumRow + 1}"/></mergeCells>` +
    `<conditionalFormatting sqref="G5:G${L}"><cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>0</formula></cfRule></conditionalFormatting>` +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${opts.table ? '<tableParts count="1"><tablePart r:id="rId9"/></tableParts>' : ""}</worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NSM}" count="${ss.length}" uniqueCount="${ss.length}">` + ss.map((x) => `<si><t>${x}</t></si>`).join("") + "</sst>";
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NSM}" xmlns:r="${NSR}"><sheets><sheet name="請求" sheetId="1" r:id="rId1"/><sheet name="控え" sheetId="2" r:id="rId4"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'請求'!$A$1:$H$${sumRow + 1}</definedName></definedNames><calcPr calcId="191029"/></workbook>`;
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NSM}"><sheetData><row r="1"><c r="A1"><f>'請求'!H${sumRow}</f><v>0</v></c><c r="B1"><f>請求!G${sumRow}</f></c></row></sheetData></worksheet>`;
  const rel = (id, type, target) => `<Relationship Id="${id}" Type="${NSR}/${type}" Target="${target}"/>`;
  const rels = (b) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${b}</Relationships>`;
  const ov = (p, t) => `<Override PartName="${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${t}+xml"/>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    ov("/xl/workbook.xml", "sheet.main") + ov("/xl/worksheets/sheet1.xml", "worksheet") + ov("/xl/worksheets/sheet2.xml", "worksheet") + ov("/xl/sharedStrings.xml", "sharedStrings") + ov("/xl/calcChain.xml", "calcChain") + "</Types>";
  return [
    { name: "[Content_Types].xml", data: ct },
    { name: "_rels/.rels", data: rels(rel("rId1", "officeDocument", "xl/workbook.xml")) },
    { name: "xl/workbook.xml", data: wb },
    { name: "xl/_rels/workbook.xml.rels", data: rels(rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId4", "worksheet", "worksheets/sheet2.xml") + rel("rId2", "sharedStrings", "sharedStrings.xml") + rel("rId3", "calcChain", "calcChain.xml")) },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    { name: "xl/worksheets/sheet2.xml", data: sheet2 },
    { name: "xl/sharedStrings.xml", data: sst },
    { name: "xl/calcChain.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<calcChain xmlns="${NSM}"><c r="G${sumRow}" i="1"/></calcChain>` },
  ];
}
// ZIP を自前の読み方とは別に(node:zlib で)開いて、CRC32 と大きさを確かめる
function checkZip(buf) {
  const b = Buffer.from(buf), eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "終わりの印");
  const count = b.readUInt16LE(eocd + 10); let p = b.readUInt32LE(eocd + 16); const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(p), 0x02014b50);
    const method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), cs = b.readUInt32LE(p + 20), us = b.readUInt32LE(p + 24);
    const nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42), name = b.subarray(p + 46, p + 46 + nl).toString("utf8");
    assert.equal(b.readUInt32LE(off), 0x04034b50);
    assert.equal(b.readUInt32LE(off + 14), crc, name + " の局所ヘッダの CRC");
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28), raw = b.subarray(start, start + cs);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : assert.fail("method " + method);
    assert.equal(data.length, us, name + " の大きさ");
    assert.equal(zlib.crc32 ? zlib.crc32(data) : X.crc32(data), crc, name + " の CRC32");
    out[name] = data.toString("utf8");
    p += 46 + nl + xl + cl;
  }
  return out;
}
const ITEMS = [
  { No: 1, 品名: "クロス張替え(寝室)", 数量: 12.5, 単位: "㎡", 単価: 1200, 金額: 15000 },
  { No: 2, 品名: "既存クロス撤去 & <養生>", 数量: 12.5, 単位: "㎡", 単価: 300, 金額: 3750 },
  { No: 3, 品名: "養生", 数量: 1, 単位: "式", 単価: 8000, 金額: 8000 },
  { No: 4, 品名: "差し入れのお茶 ※", 数量: 2, 単位: "本", 単価: 150, 金額: 300 },
];
const FIELDS = { 書類名: "請求書", お客様: "見本 山田 太郎 様", 現場名: "見本 山田様邸 2階", 日付: "2026年11月16日", 請求金額: 29674, 備考: "月末締め・翌月末払い" };

await ta("0.6.0 CRC32 の検査値は標準どおり", async () => {
  assert.equal(X.crc32(new TextEncoder().encode("123456789")), 0xCBF43926);
  assert.equal(X.crc32(new Uint8Array(0)), 0);
});
await ta("0.6.0 ひな形: 往復(値・品目の行を下へ増やす・結合・数式・印刷範囲・日本語・CRC)", async () => {
  const tplBytes = await X.zip(testTemplate());
  checkZip(tplBytes);
  const sc = await X.scan(tplBytes);
  assert.ok(sc.hasItemRow);
  for (const k of ["書類名", "お客様", "現場名", "日付", "品名", "金額", "請求金額", "No"]) assert.ok(sc.names.includes(k), k);
  const r = await X.fill(tplBytes, { fields: FIELDS, items: ITEMS });
  const parts = checkZip(r.bytes);
  assert.ok(!("xl/calcChain.xml" in parts), "古い計算の順番は捨てる");
  assert.ok(!parts["[Content_Types].xml"].includes("calcChain"));
  assert.ok(!parts["xl/_rels/workbook.xml.rels"].includes("calcChain"));
  assert.deepEqual(r.itemRows, [{ sheet: "請求", items: 4, written: 4, slots: 0, inserted: 3 }]);
  assert.deepEqual(r.warnings, []);
  const b = await X.readBook(r.bytes), sh = b.sheets[0], c = sh.cells;
  assert.equal(c.A1.v, "請求書"); assert.equal(c.A1.s, "1");                         // 書式(s)はそのまま
  assert.equal(c.A2.v, "見本 山田 太郎 様"); assert.equal(c.E2.v, "2026年11月16日");   // inlineStr の差し込み
  assert.equal(c.A3.v, "現場: 見本 山田様邸 2階");                                   // 文の中の差し込み
  assert.equal(c.A4.v, "No");                                                           // 差し込みでない文字は触らない
  for (let i = 0; i < 4; i++) {
    const r0 = 5 + i, it = ITEMS[i];
    assert.equal(c["A" + r0].v, it.No); assert.equal(c["B" + r0].v, it.品名); assert.equal(c["D" + r0].v, it.数量);
    assert.equal(c["E" + r0].v, it.単位); assert.equal(c["F" + r0].v, it.単価); assert.equal(c["G" + r0].v, it.金額);
    assert.equal(typeof c["G" + r0].v, "number");                                        // 金額は数のセル
    assert.equal(c["D" + r0].s, "3"); assert.equal(c["B" + r0].s, "2");                  // 罫線などの書式を写す
    assert.equal(c["H" + r0].f, `D${r0}*F${r0}`);                                        // 行の数式は行に合わせる
  }
  assert.ok(sh.xml.includes('<row r="8" ht="20" customHeight="1"'), "行の高さも写す");
  assert.ok(sh.xml.includes("既存クロス撤去 &amp; &lt;養生&gt;"));                       // XML の特別な文字
  assert.equal(c.G10.f, "SUM(G5:G8)");                                                   // 合計の範囲が品目の行まで伸びる
  assert.equal(c.G10.v, undefined);                                                       // 古い計算結果は消す
  assert.equal(c.H10.v, 29674); assert.equal(c.F10.v, "合計"); assert.equal(c.B11.v, "月末締め・翌月末払い");
  assert.deepEqual(sh.merges.sort(), ["A1:H1", "B11:H11", "B5:C5", "B6:C6", "B7:C7", "B8:C8", "F10:G10"].sort());
  assert.equal(sh.dimension, "A1:H11");
  assert.ok(sh.xml.includes('sqref="G5:G8"'), "条件付き書式も伸ばす");
  assert.ok(b.workbook.includes("'請求'!$A$1:$H$11"), "印刷範囲");
  assert.ok(b.workbook.includes('fullCalcOnLoad="1"'));
  const s2 = b.sheets[1].cells;
  assert.equal(s2.A1.f, "'請求'!H10"); assert.equal(s2.B1.f, "請求!G10");                // ほかのシートからの参照もずらす
});
await ta("0.6.0 ひな形: 無圧縮で書いても読める・空の行があれば増やさない", async () => {
  const tplBytes = await X.zip(testTemplate({ slots: 4 }), { deflate: false });
  const parts = checkZip(tplBytes);
  assert.ok(parts["xl/workbook.xml"].includes("請求"));
  const r = await X.fill(tplBytes, { fields: FIELDS, items: ITEMS.slice(0, 2) });
  assert.deepEqual(r.itemRows, [{ sheet: "請求", items: 2, written: 2, slots: 4, inserted: 0 }]);
  const c = (await X.readBook(r.bytes)).sheets[0].cells;
  assert.equal(c.B6.v, ITEMS[1].品名); assert.equal(c.B7.v, undefined); assert.equal(c.G11.f, "SUM(G5:G9)");
});
await ta("0.6.0 ひな形: 安全に行を増やせない時はその場に入れて知らせる", async () => {
  const r = await X.fill(await X.zip(testTemplate({ table: true })), { fields: FIELDS, items: ITEMS });
  assert.equal(r.itemRows[0].written, 1); assert.equal(r.itemRows[0].inserted, 0);
  const w = r.warnings.find((x) => x.code === "W_ITEM_ROWS_SHORT");
  assert.ok(w && w.message_ja.includes("テーブル") && w.message_ja.includes("3 件は入っていません"), JSON.stringify(r.warnings));
  const c = (await X.readBook(r.bytes)).sheets[0].cells;
  assert.equal(c.B5.v, ITEMS[0].品名); assert.equal(c.H7.v, 29674);                    // 下の行はずらさない
});
await ta("0.6.0 ひな形: 壊れたファイル・知らない差し込みは日本語で", async () => {
  await assert.rejects(X.scan(new TextEncoder().encode("これは Excel ではない")), /xlsx/);
  const bad = Buffer.from(await X.zip(testTemplate(), { deflate: false }));
  const at = bad.indexOf("<sheetData>");
  assert.ok(at > 0);
  bad[at + 3] ^= 0x01;                          // 中身を1バイト壊す → 検査値(CRC32)が合わない
  await assert.rejects(X.fill(new Uint8Array(bad), { fields: {}, items: [] }), (e) => e.ja === true && /壊れて/.test(e.message));
  const r = await X.fill(await X.zip(testTemplate()), { fields: { 書類名: "x" }, items: [] });
  assert.ok(r.warnings.some((w) => w.code === "W_UNKNOWN_PLACEHOLDER" && w.message_ja.includes("{{お客様}}")));
});
await ta("0.6.0 見本のひな形: 画面のデータを入れると知らない差し込みが残らない", async () => {
  const sample = await X.buildSample();
  const sc = await X.scan(sample);
  assert.deepEqual(X.invoiceMissing(sc.names, [10, 8]), []);                            // 見本は記載事項6つがそろう
  const out = G.fromMemo({ site: "見本 山田様邸", date: "2026-11-16", memo: "クロス張替え 12.5㎡ @1200\nお茶 2本 @150 ※", workers: [{ name: "田中", hours: "8" }] }, ISSUER, { buyer: "見本 山田 太郎" });
  const data = G.docData(out, { address: "岡山県 見本町1-2", phone: "000-0000-0000", bank: "見本銀行 普通 0000000" }, "invoice");
  const r = await X.fill(sample, data);
  assert.deepEqual(r.warnings, []);
  const c = (await X.readBook(r.bytes)).sheets[0].cells;
  assert.equal(c.A1.v, "請求書"); assert.equal(c.C8.v, out.invoice.grand_total); assert.equal(c.C11.v, 12.5); assert.equal(c.B12.v, "お茶 ※");
  assert.equal(c.F15.v, 15000); assert.equal(c.F17.v, 300); assert.equal(c.F18.v, 24); assert.equal(c.B21.v, "見本銀行 普通 0000000");
});
t("0.6.0 請求書の差し込みが足りない時のお知らせ(記載事項6つ)", () => {
  const all = ["自分の名前", "登録番号", "日付", "品名", "10%対象", "消費税10%", "お客様"];
  assert.deepEqual(X.invoiceMissing(all, [10]), []);
  const m = X.invoiceMissing(["品名", "日付", "10%対象"], [10, 8]);
  assert.deepEqual(m.map((x) => x.no), [1, 3, 4, 5, 6]);
  assert.deepEqual(m.find((x) => x.no === 3).missing, ["税率|軽減の注記"]);            // 軽減税率の対象である旨
  const txt = X.invoiceMissingText(m);
  for (const w of ["{{登録番号}}", "{{8%対象}}", "{{消費税8%}}", "{{お客様}}", "{{税率}} または {{軽減の注記}}", "日報・見積"]) assert.ok(txt.includes(w), w);
  assert.equal(X.invoiceMissingText([]), "");
  assert.deepEqual(X.invoiceMissing(all.concat("軽減の注記"), [10, 8]).map((x) => x.no), [4, 5]);
});
t("0.6.0 自社の設定: 書き出しの形と読み込み", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const json = G.exportSettings({ name: "見本 田中内装", regno: "T9000000000000", address: "岡山県 見本町", phone: "000", bank: "見本銀行", footer: "ありがとうございます", logo: png, seal: png, accent: "#AA3300", columns: ["金額", "品名", "数量"] },
    { paper: "B5", fields: [{ key: "お客様", x: 20, y: 30 }] }, new Date("2026-11-23T00:00:00Z"));
  const o = JSON.parse(json);
  assert.deepEqual(Object.keys(o), ["app", "type", "format", "version", "exported_at", "settings", "paper"]);
  assert.equal(o.app, "genba-shorui"); assert.equal(o.type, "settings"); assert.equal(o.format, 1); assert.equal(o.version, G.VERSION);
  assert.equal(o.exported_at, "2026-11-23T00:00:00.000Z");
  assert.deepEqual(Object.keys(o.settings).sort(), ["accent", "address", "bank", "columns", "footer", "logo", "name", "phone", "regno", "seal"]);
  assert.equal(o.settings.accent, "#aa3300");
  assert.deepEqual(o.settings.columns, ["金額", "品名", "数量", "税率"]);                // 外せない列は足す
  assert.equal(o.paper.paper, "B5");
  const back = G.importSettings(json);
  assert.deepEqual(back.settings, o.settings); assert.deepEqual(back.paper, o.paper); assert.deepEqual(back.notes, []);
  assert.throws(() => G.importSettings("{}"), /設定のファイルではありません/);
  assert.throws(() => G.importSettings("not json"), /JSON/);
  assert.throws(() => G.importSettings(JSON.stringify({ app: "genba-shorui", type: "settings", format: 2 })), /新しい版/);
  const evil = G.importSettings(JSON.stringify({ app: "genba-shorui", type: "settings", format: 1, settings: { logo: "javascript:alert(1)", seal: "data:image/svg+xml;base64,PHN2Zz4=", accent: "red;}", name: "x".repeat(500) } }));
  assert.equal(evil.settings.logo, ""); assert.equal(evil.settings.seal, ""); assert.equal(evil.settings.accent, "#1f5fa8");
  assert.equal(evil.settings.name.length, 100); assert.equal(evil.notes.length, 2);
  assert.deepEqual(G.normalizeSettings(null), G.defaultSettings());
});
t("0.6.0 紙の用紙の配置: 保存の形・範囲・印字の位置", () => {
  const raw = { paper: "A4", kind: "invoice", dx: -1.5, dy: 2, font: 11, pitch: 8, rows: 3, fields: [{ key: "お客様", x: 25, y: 40 }, { key: "品名", x: 20, y: 100 }, { key: "金額", x: 190, y: 100, size: 9 }, { key: "8%対象", x: 150, y: 200 }, { key: "知らない", x: 1, y: 1 }, { key: "請求金額", x: 999, y: -5 }] };
  const p = G.normalizePaper(raw);
  assert.equal(p.fields.length, 5);                                                       // 知らない欄は捨てる
  assert.deepEqual(p.fields[4], { key: "請求金額", x: 210, y: 0 });                       // 用紙の中に収める
  assert.deepEqual(G.normalizePaper(JSON.parse(G.serializePaper(p))), p);                 // 往復しても同じ
  assert.deepEqual(G.normalizePaper("壊れた"), G.defaultPaper());
  assert.equal(G.normalizePaper({ paper: "A3", dx: 99 }).paper, "A4");
  assert.equal(G.normalizePaper({ dx: 99 }).dx, 30);
  const out = G.fromMemo({ site: "s", date: "2026-11-16", memo: "a 1式 @1000\nb 2本 @500\nc 1式 @100\nd 1式 @100" }, ISSUER, { buyer: "山田" });
  const res = G.paperTexts(p, G.docData(out, {}, "invoice"));
  assert.deepEqual(res.paper, G.PAPERS.A4);
  const buyer = res.texts.find((x) => x.key === "お客様");
  assert.deepEqual([buyer.text, buyer.x, buyer.y, buyer.size], ["山田 様", 23.5, 42, 11]);  // ずれの補正込み
  const names = res.texts.filter((x) => x.key === "品名");
  assert.deepEqual(names.map((x) => [x.text, x.y]), [["a", 102], ["b", 110], ["c", 118]]); // 行の間隔ずつ下へ・3行まで
  const amt = res.texts.filter((x) => x.key === "金額");
  assert.deepEqual(amt.map((x) => [x.text, x.align, x.size]), [["1,000", "right", 9], ["1,000", "right", 9], ["100", "right", 9]]);
  assert.ok(!res.texts.some((x) => x.key === "8%対象"));                                 // 軽減の品目がない時は 0 を印字しない
  assert.ok(res.warnings[0].includes("1 件は印字されません"));
  assert.equal(res.texts.find((x) => x.key === "請求金額").text, "2,420");
});
t("0.6.0 書類の値: 日付・お客様・税率ごとの合計", () => {
  const out = G.fromMemo({ site: "s", date: "2026-11-05", weather: "晴れ", memo: "a 1式 @1000\nお茶 2本 @150 ※\n雨", workers: [{ name: "田中", hours: "7.5" }] }, ISSUER, { buyer: "山田 御中" });
  const d = G.docData(out, { bank: "見本銀行", footer: "ありがとう" }, "estimate");
  assert.equal(d.fields.書類名, "御見積書"); assert.equal(d.fields.日付, "2026年11月5日"); assert.equal(d.fields.お客様, "山田 御中");
  assert.equal(d.fields.振込先, "");                                                      // 振込先は請求書だけ
  assert.equal(d.fields.有効期限, "発行から30日"); assert.equal(d.fields.作業した人, "田中 7.5時間"); assert.equal(d.fields.作業の記録, "雨");
  assert.deepEqual([d.fields["10%対象"], d.fields["消費税10%"], d.fields["8%対象"], d.fields["消費税8%"], d.fields.合計, d.fields.請求金額], [1000, 100, 300, 24, 1300, 1424]);
  assert.deepEqual(d.items[1], { No: 2, 品名: "お茶 ※", 数量: 2, 単位: "本", 単価: 150, 金額: 300, 税率: "8%(軽減)", 区分: "その他" });
  assert.equal(G.docData(out, { bank: "見本銀行" }, "invoice").fields.振込先, "見本銀行");
});

t("0.6.0 先に出た軽い版の会社の書式(genba-shorui:company:v1)を引き継ぐ", () => {
  const s = G.migrateCompany({ address: "東京都千代田区1-1", phone: "03-1234-5678", bank: "〇〇銀行 本店 普通 1234567", note: "いつもありがとうございます", color: "green", logo: "data:image/png;base64,iVBORw0KGgo=", seal: "javascript:alert(1)" });
  assert.equal(s.address, "東京都千代田区1-1");
  assert.equal(s.footer, "いつもありがとうございます");
  assert.equal(s.accent, "#2e7d4f");
  assert.equal(s.logo, "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(s.seal, "");                                  // 画像でない物は捨てる
  assert.equal(s.name, "");
  assert.deepEqual(G.migrateCompany(null).accent, "#1f5fa8");
});
console.log(`genba tests ok: ${n}`);
