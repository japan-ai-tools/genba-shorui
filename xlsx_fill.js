/* 現場の書類 0.6.0: 自社の Excel のひな形(.xlsx)に {{現場名}} などの差し込みを入れて、新しい .xlsx を作る。
   ブラウザの標準の部品だけ(ZIP は自前で読み書き・展開は DecompressionStream・圧縮は CompressionStream)。
   通信しない。罫線・結合・フォント・列の幅などの書式は元の XML をそのまま残し、値の入る所だけを書き換える。
   Node 18 以降でも動く(試験用)。MIT・nexus-tools */
(function (root) {
  "use strict";
  var MAX_ZIP = 20 * 1024 * 1024;        // ひな形のファイル 20MB まで
  var MAX_PART = 60 * 1024 * 1024;       // 展開後の1つの部品 60MB まで
  var ITEM_KEYS = ["No", "品名", "数量", "単位", "単価", "金額", "税率", "区分"];
  var PH_RE = /[{｛]{2}\s*([^{}｛｝\r\n]{1,40}?)\s*[}｝]{2}/g;
  var MSG_BAD = "Excel の .xlsx のひな形として読めませんでした(古い .xls・パスワード付き・壊れたファイルは使えません)。Excel で「名前を付けて保存」→「Excel ブック(.xlsx)」で保存し直してください。";

  function jerr(m) { var e = new Error(m); e.ja = true; return e; }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function nfkc(s) { return String(s == null ? "" : s).normalize("NFKC"); }
  function defaultNorm(s) { return nfkc(s).replace(/\s+/g, ""); }

  // ---- CRC32(ZIP の検査値) ----
  var CRC_T = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- 展開・圧縮(ブラウザの標準の stream) ----
  function pipe(stream, data, limit) {
    var w = stream.writable.getWriter(), r = stream.readable.getReader(), chunks = [], total = 0, quiet = function () {};
    w.write(data).catch(quiet); w.close().catch(quiet);
    function pump() {
      return r.read().then(function (x) {
        if (x.done) {
          var out = new Uint8Array(total), o = 0;
          chunks.forEach(function (c) { out.set(c, o); o += c.length; });
          return out;
        }
        total += x.value.length;
        if (limit && total > limit) { r.cancel().catch(quiet); throw jerr("ひな形が大きすぎます(展開後 60MB まで)。"); }
        chunks.push(x.value);
        return pump();
      });
    }
    return pump();
  }
  function inflate(data) {
    if (typeof DecompressionStream === "undefined") return Promise.reject(jerr("このブラウザは .xlsx を開く機能(DecompressionStream)がありません。新しい Chrome・Safari・Edge で開いてください。"));
    return pipe(new DecompressionStream("deflate-raw"), data, MAX_PART).catch(function (e) { throw e && e.ja ? e : jerr(MSG_BAD); });
  }
  function deflate(data) {
    if (typeof CompressionStream === "undefined") return Promise.resolve(null);
    return pipe(new CompressionStream("deflate-raw"), data, 0).catch(function () { return null; });
  }

  // ---- ZIP を読む(中央ディレクトリから) ----
  function unzip(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length > MAX_ZIP) return Promise.reject(jerr("ひな形のファイルが大きすぎます(20MB まで)。"));
    if (b.length < 22 || u32(b, 0) !== 0x04034b50) return Promise.reject(jerr(MSG_BAD));
    var e = -1, min = Math.max(0, b.length - 65557);
    for (var i = b.length - 22; i >= min; i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
    if (e < 0) return Promise.reject(jerr(MSG_BAD));
    var n = u16(b, e + 10), p = u32(b, e + 16), list = [];
    if (n === 0xFFFF || p === 0xFFFFFFFF) return Promise.reject(jerr("ひな形が大きすぎます(ZIP64 は使えません)。"));
    var dec = new TextDecoder("utf-8");
    for (i = 0; i < n; i++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) return Promise.reject(jerr(MSG_BAD));
      var nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32);
      list.push({name: dec.decode(b.subarray(p + 46, p + 46 + nl)), flags: u16(b, p + 8), method: u16(b, p + 10), crc: u32(b, p + 16), csize: u32(b, p + 20), usize: u32(b, p + 24), offset: u32(b, p + 42)});
      p += 46 + nl + xl + cl;
    }
    return list.reduce(function (pr, ent) {
      return pr.then(function (acc) {
        if (ent.flags & 1) throw jerr("パスワード付きのひな形は使えません。パスワードを外して保存し直してください。");
        var o = ent.offset;
        if (o + 30 > b.length || u32(b, o) !== 0x04034b50) throw jerr(MSG_BAD);
        var start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
        if (start + ent.csize > b.length || ent.usize > MAX_PART) throw jerr(MSG_BAD);
        var raw = b.subarray(start, start + ent.csize);
        var got = ent.method === 0 ? Promise.resolve(raw.slice()) : ent.method === 8 ? inflate(raw) : Promise.reject(jerr(MSG_BAD));
        return got.then(function (data) {
          if (crc32(data) !== ent.crc) throw jerr("ひな形のファイルが壊れています(検査値が合いません)。");
          acc.push({name: ent.name, data: data});
          return acc;
        });
      });
    }, Promise.resolve([]));
  }

  // ---- ZIP を書く(圧縮できる時は deflate・できない時は無圧縮。CRC32 を付ける) ----
  function dosTime(d) {
    return {time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
      date: ((Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF};
  }
  function zip(files, opts) {
    opts = opts || {};
    var enc = new TextEncoder(), dt = dosTime(opts.date || new Date());
    return files.reduce(function (pr, f) {
      return pr.then(function (acc) {
        var data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
        var want = opts.deflate !== false && data.length > 64;
        return (want ? deflate(data) : Promise.resolve(null)).then(function (z) {
          var useZ = z && z.length < data.length;
          acc.push({name: enc.encode(f.name), data: data, body: useZ ? z : data, method: useZ ? 8 : 0, crc: crc32(data)});
          return acc;
        });
      });
    }, Promise.resolve([])).then(function (ents) {
      var size = 22;
      ents.forEach(function (e) { size += 30 + e.name.length + e.body.length + 46 + e.name.length; });
      var out = new Uint8Array(size), dv = new DataView(out.buffer), o = 0, cd = [];
      function w16(v) { dv.setUint16(o, v, true); o += 2; }
      function w32(v) { dv.setUint32(o, v >>> 0, true); o += 4; }
      ents.forEach(function (e) {
        cd.push(o);
        w32(0x04034b50); w16(20); w16(0x0800); w16(e.method); w16(dt.time); w16(dt.date);
        w32(e.crc); w32(e.body.length); w32(e.data.length); w16(e.name.length); w16(0);
        out.set(e.name, o); o += e.name.length; out.set(e.body, o); o += e.body.length;
      });
      var cdStart = o;
      ents.forEach(function (e, i) {
        w32(0x02014b50); w16(20); w16(20); w16(0x0800); w16(e.method); w16(dt.time); w16(dt.date);
        w32(e.crc); w32(e.body.length); w32(e.data.length); w16(e.name.length); w16(0); w16(0); w16(0); w16(0); w32(0); w32(cd[i]);
        out.set(e.name, o); o += e.name.length;
      });
      var cdSize = o - cdStart;
      w32(0x06054b50); w16(0); w16(0); w16(ents.length); w16(ents.length); w32(cdSize); w32(cdStart); w16(0);
      return out;
    });
  }

  // ---- XML の小さな道具 ----
  function escXml(s) {
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/[&<>"]/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]; });
  }
  function unescXml(s) {
    return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (a, k) {
      if (k[0] === "#") { var cp = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return String.fromCodePoint(cp); } catch (e) { return a; } }
      return {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'"}[k];
    });
  }
  function getAttr(attrs, name) {
    var m = new RegExp("(?:^|\\s)" + name.replace(":", "\\:") + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1").exec(attrs || "");
    return m ? unescXml(m[2]) : null;
  }
  function setAttr(attrs, name, val) {
    var re = new RegExp("\\s+" + name.replace(":", "\\:") + "\\s*=\\s*([\"'])[\\s\\S]*?\\1");
    attrs = (attrs || "").replace(re, "");
    return val == null ? attrs : attrs + " " + name + "=\"" + escXml(val) + "\"";
  }
  function textOfRuns(xml) {
    var s = String(xml || "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, ""), out = "", m, re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
    while ((m = re.exec(s))) out += m[1] || "";
    return unescXml(out).replace(/_x([0-9A-Fa-f]{4})_/g, function (a, h) { return String.fromCharCode(parseInt(h, 16)); });
  }

  // ---- セルの番地 ----
  function colNum(s) { var n = 0; for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
  function colName(n) { var s = ""; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function splitRef(ref) { var m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref); return m ? {col: colNum(m[1]), row: +m[2]} : null; }

  // 行を足した時の番地のずらし方。L 行目の下に k 行を足す
  //  範囲(数式・印刷範囲・書式の範囲など): L より下は k 下げ、L の行を含む範囲は終わりを k 伸ばす
  //   (品目の行だけの SUM(F11:F11) や、品目の行の条件付き書式も、足した行まで広がる)
  //  結合(merge): L より下は k 下げ、L をまたぐ結合だけ伸ばす(L の行の中の結合は伸ばさない)
  function shiftRowPair(r1, r2, L, k, merge) {
    if (r1 > L) return [r1 + k, r2 + k];
    if (merge ? r2 > L : r2 >= L) return [r1, r2 + k];
    return [r1, r2];
  }
  function shiftA1(text, L, k, merge) {
    // 「A1」「$A$1:$B$2」「3:5」を1つ
    var m = /^(\$?[A-Z]{1,3})(\$?)(\d+)(?::(\$?[A-Z]{1,3})(\$?)(\d+))?$/.exec(text);
    if (m) {
      if (m[4] == null) { var r = +m[3]; return m[1] + m[2] + (r > L ? r + k : r); }
      var p = shiftRowPair(+m[3], +m[6], L, k, merge);
      return m[1] + m[2] + p[0] + ":" + m[4] + m[5] + p[1];
    }
    m = /^(\$?)(\d+):(\$?)(\d+)$/.exec(text);
    if (m) { var q = shiftRowPair(+m[2], +m[4], L, k, merge); return m[1] + q[0] + ":" + m[3] + q[1]; }
    return text;
  }
  function shiftSqref(s, L, k, merge) { return String(s).split(/\s+/).map(function (x) { return x ? shiftA1(x, L, k, merge) : x; }).join(" "); }

  // 数式の中の番地を探して書き換える(文字列 "…" の中は触らない)
  var REF_RE = /(?<![A-Za-z0-9_.\u00C0-\uFFFF$'!\]])((?:'(?:[^']|'')+'|[A-Za-z_\u00C0-\uFFFF][A-Za-z0-9_.\u00C0-\uFFFF]*)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?\d+:\$?\d+)(?![A-Za-z0-9_(\u00C0-\uFFFF!])/g;
  function sheetOfPrefix(p) { if (!p) return null; p = p.slice(0, -1); return (p[0] === "'" ? p.slice(1, -1).replace(/''/g, "'") : p).toLowerCase(); }
  function mapFormula(f, fn) {
    return String(f).split(/("(?:[^"]|"")*")/).map(function (seg, i) {
      return i % 2 ? seg : seg.replace(REF_RE, function (all, pre, ref) { return (pre || "") + fn(sheetOfPrefix(pre), ref); });
    }).join("");
  }
  function shiftFormula(f, sheetName, own, L, k) {
    var nm = String(sheetName).toLowerCase();
    return mapFormula(f, function (sh, ref) { return (sh == null ? own : sh === nm) ? shiftA1(ref, L, k, false) : ref; });
  }
  // 行を写した時(Excel の行のコピーと同じ): 相対の行番号($ の付かない行)を d ずらす
  function copyFormula(f, d) {
    return mapFormula(f, function (sh, ref) {
      return ref.replace(/(\$?[A-Z]{1,3})?(\$?)(\d+)/g, function (a, c, abs, r) { return (c || "") + abs + (abs ? r : Math.max(1, +r + d)); });
    });
  }

  // ---- 部品の場所 ----
  function resolve(base, target) {
    if (/^\//.test(target)) return target.slice(1);
    var parts = (base + target).split("/"), out = [];
    parts.forEach(function (p) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); });
    return out.join("/");
  }
  function relsOf(xml) {
    var out = [], m, re = /<Relationship\b([^>]*?)\/?>/g;
    while ((m = re.exec(xml || ""))) out.push({id: getAttr(m[1], "Id"), type: getAttr(m[1], "Type") || "", target: getAttr(m[1], "Target") || "", mode: getAttr(m[1], "TargetMode")});
    return out;
  }
  function relsPath(path) { var i = path.lastIndexOf("/"); return path.slice(0, i + 1) + "_rels/" + path.slice(i + 1) + ".rels"; }
  function dirOf(path) { return path.slice(0, path.lastIndexOf("/") + 1); }

  function Book(entries) {
    var dec = new TextDecoder("utf-8"), self = this;
    this.entries = entries;
    this.idx = {};
    entries.forEach(function (e, i) { self.idx[e.name.replace(/^\/+/, "").toLowerCase()] = i; });
    this.text = function (path) {
      var i = self.idx[String(path).toLowerCase()];
      if (i == null) return null;
      var e = self.entries[i];
      if (e.text == null) e.text = dec.decode(e.data);
      return e.text;
    };
    this.put = function (path, text) { var i = self.idx[String(path).toLowerCase()]; if (i == null) { self.idx[path.toLowerCase()] = self.entries.length; self.entries.push({name: path, text: text, dirty: true}); } else { self.entries[i].text = text; self.entries[i].dirty = true; } };
    this.remove = function (path) { var i = self.idx[String(path).toLowerCase()]; if (i != null) { self.entries[i].removed = true; } };
    var ct = this.text("[Content_Types].xml");
    if (ct == null) throw jerr(MSG_BAD);
    if (/macroEnabled/i.test(ct)) throw jerr("マクロ付きのブック(.xlsm)は使えません。マクロなしの .xlsx で保存し直してください。");
    var rootRels = relsOf(this.text("_rels/.rels"));
    var wbRel = rootRels.filter(function (r) { return /\/officeDocument$/.test(r.type); })[0];
    this.wbPath = wbRel ? resolve("", wbRel.target) : "xl/workbook.xml";
    this.wb = this.text(this.wbPath);
    if (this.wb == null) throw jerr(MSG_BAD);
    this.wbRelsPath = relsPath(this.wbPath);
    this.wbRels = relsOf(this.text(this.wbRelsPath));
    var base = dirOf(this.wbPath), byId = {};
    this.wbRels.forEach(function (r) { byId[r.id] = r; });
    var sst = this.wbRels.filter(function (r) { return /\/sharedStrings$/.test(r.type); })[0];
    this.sst = [];
    var sx = sst ? this.text(resolve(base, sst.target)) : null, m, re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
    while (sx && (m = re.exec(sx))) this.sst.push(textOfRuns(m[1] || ""));
    this.sheets = [];
    re = /<sheet\b([^>]*?)\/?>/g;
    while ((m = re.exec(this.wb))) {
      var rid = getAttr(m[1], "r:id"), rel = byId[rid];
      if (rel && /\/worksheet$/.test(rel.type)) this.sheets.push({name: getAttr(m[1], "name") || "", path: resolve(base, rel.target)});
    }
    if (!this.sheets.length) throw jerr(MSG_BAD);
  }

  // ---- シートを行とセルに分ける ----
  function parseSheet(xml) {
    var m = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
    if (!m) return null;
    var rows = [], rm, rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, lastR = 0;
    while ((rm = rowRe.exec(m[1] || ""))) {
      var r = parseInt(getAttr(rm[1], "r"), 10) || lastR + 1; lastR = r;
      var cells = [], cm, cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, lastC = 0;
      while ((cm = cellRe.exec(rm[2] || ""))) {
        var ref = splitRef(getAttr(cm[1], "r") || ""), col = ref ? ref.col : lastC + 1; lastC = col;
        cells.push({col: col, attrs: setAttr(cm[1], "r", null), inner: cm[2] == null ? null : cm[2]});
      }
      rows.push({r: r, attrs: setAttr(rm[1], "r", null), cells: cells});
    }
    rows.sort(function (a, b) { return a.r - b.r; });
    return {head: xml.slice(0, m.index), tail: xml.slice(m.index + m[0].length), rows: rows};
  }
  function writeSheet(model) {
    var rows = model.rows.slice().sort(function (a, b) { return a.r - b.r; });
    return model.head + "<sheetData>" + rows.map(function (row) {
      var cells = row.cells.slice().sort(function (a, b) { return a.col - b.col; }).map(function (c) {
        return "<c r=\"" + colName(c.col) + row.r + "\"" + c.attrs + (c.inner == null ? "/>" : ">" + c.inner + "</c>");
      }).join("");
      return "<row r=\"" + row.r + "\"" + row.attrs + (cells ? ">" + cells + "</row>" : "/>");
    }).join("") + "</sheetData>" + model.tail;
  }
  function cellText(c, sst) {
    var inner = c.inner || "";
    if (/<f\b/.test(inner)) return null;
    var t = getAttr(c.attrs, "t");
    if (t === "s") { var v = /<v>([\s\S]*?)<\/v>/.exec(inner); return v ? (sst[parseInt(v[1], 10)] != null ? sst[parseInt(v[1], 10)] : null) : null; }
    if (t === "inlineStr") { var is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner); return is ? textOfRuns(is[1]) : ""; }
    return null;
  }
  function placeholdersIn(text, norm) {
    var out = [], m; PH_RE.lastIndex = 0;
    while ((m = PH_RE.exec(text))) out.push({raw: m[1], key: norm(m[1])});
    return out;
  }
  function blankRow(row) { return row.cells.every(function (c) { return c.inner == null || !/<(v|f|is)\b/.test(c.inner); }); }
  function rowShape(row) { return row.cells.map(function (c) { return c.col + ":" + (getAttr(c.attrs, "s") || "0"); }).join(","); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function fmtNum(v) {
    var neg = v < 0, s = String(Math.abs(v)).split("."), i = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + i + (s[1] ? "." + s[1] : "");
  }
  function setString(c, s) {
    var a = setAttr(c.attrs, "t", null);
    if (s === "") { c.attrs = a; c.inner = null; return; }
    c.attrs = setAttr(a, "t", "inlineStr");
    c.inner = "<is><t xml:space=\"preserve\">" + escXml(s) + "</t></is>";
  }
  function setNumber(c, v) { c.attrs = setAttr(c.attrs, "t", null); c.inner = "<v>" + String(v) + "</v>"; }

  // 1つのセルの差し込みを値に替える。全体が1つの差し込みで値が数なら、数のセルにする(Excel で計算できる)
  function fillCell(c, text, lookup, unknown) {
    var whole = /^\s*[{｛]{2}[^{}｛｝]+[}｝]{2}\s*$/.test(text);
    var single = null, any = false;
    PH_RE.lastIndex = 0;
    var s = text.replace(PH_RE, function (all, raw) {
      var v = lookup(raw);
      if (v === undefined) { unknown[raw] = true; return all; }
      any = true; single = v;
      return v == null ? "" : isNum(v) ? fmtNum(v) : String(v);
    });
    if (!any) return false;
    if (whole && isNum(single)) setNumber(c, single); else setString(c, s);
    return true;
  }

  function sheetRels(book, path) { return relsOf(book.text(relsPath(path))); }
  function drawingPaths(book, path) {
    var base = dirOf(path);
    return sheetRels(book, path).filter(function (r) { return /\/drawing$/.test(r.type) && r.mode !== "External"; }).map(function (r) { return resolve(base, r.target); });
  }
  function unsafeReasons(book, sh, model, tplRow) {
    var out = [], all = model.head + model.tail;
    if (/<tablePart\b/.test(all)) out.push("テーブル(Excel の「テーブル」機能)");
    if (/<legacyDrawing\b/.test(all)) out.push("コメント(メモ)");
    if (sheetRels(book, sh.path).some(function (r) { return /\/pivotTable$/.test(r.type); })) out.push("ピボットテーブル");
    if (drawingPaths(book, sh.path).some(function (p) { return /<(\w+:)?chart\b|graphicFrame/.test(book.text(p) || ""); })) out.push("グラフ");
    if (tplRow.cells.some(function (c) { return /<f\b[^>]*t="shared"[^>]*(\/>|>\s*<\/f>)/.test(c.inner || ""); })) out.push("品目の行の共有の数式");
    return out;
  }

  function copyCells(row, d) {
    return row.cells.map(function (c) {
      var inner = c.inner == null ? null : c.inner.replace(/<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/, function (all, fa, ft) {
        var t = getAttr(fa, "t"), a = fa;
        if (t === "shared") a = setAttr(setAttr(setAttr(a, "t", null), "ref", null), "si", null);
        if (t === "array") { var rr = getAttr(a, "ref"); a = setAttr(a, "ref", rr ? copyFormula(rr, d) : null); }
        return "<f" + a + ">" + escXml(copyFormula(unescXml(ft || ""), d)) + "</f>";
      });
      return {col: c.col, attrs: c.attrs, inner: inner, text: c.text, ph: c.ph};
    });
  }

  // ---- 1つのシートに差し込む ----
  function fillSheet(book, sh, data, ctx) {
    var xml = book.text(sh.path);
    if (xml == null) return;
    var model = parseSheet(xml);
    if (!model) return;
    ctx.newMerges = [];
    var norm = ctx.norm, itemSet = ctx.itemSet, rows = model.rows, tIdx = -1, extraItemRows = [], touched = false;
    rows.forEach(function (row, i) {
      row.cells.forEach(function (c) {
        var tx = cellText(c, book.sst);
        if (tx == null) return;
        var ph = placeholdersIn(tx, norm);
        if (!ph.length) return;
        c.text = tx; c.ph = ph;
        if (ph.some(function (p) { return itemSet[p.key]; })) row.item = true;
      });
      if (row.item) { if (tIdx < 0) tIdx = i; else extraItemRows.push(row.r); }
    });
    var fieldLookup = function (raw) { var k = norm(raw); if (itemSet[k]) return ""; return Object.prototype.hasOwnProperty.call(data.fields, k) ? data.fields[k] : undefined; };
    var shift = null;
    if (tIdx >= 0) {
      ctx.itemSheets++;
      var tpl = rows[tIdx], T = tpl.r, slots = 0, shape = rowShape(tpl);
      for (var j = tIdx + 1; j < rows.length; j++) {
        if (rows[j].r !== T + slots + 1 || rows[j].item || !blankRow(rows[j]) || rowShape(rows[j]) !== shape) break;
        slots++;
      }
      var items = data.items || [], N = items.length, avail = 1 + slots, need = Math.max(1, N), extra = Math.max(0, need - avail), L = T + slots, write = need;
      if (extra > 0) {
        var why = unsafeReasons(book, sh, model, tpl);
        if (why.length) {
          write = avail;
          ctx.warnings.push({level: "ng", code: "W_ITEM_ROWS_SHORT", message_ja: "シート「" + sh.name + "」は " + why.join("・") + " があるため行を増やせませんでした。品目 " + N + " 件のうち " + avail + " 件だけ入れています(残り " + (N - avail) + " 件は入っていません)。ひな形の品目の行の下に、同じ形の空の行を " + (N - avail) + " 行以上足してください。"});
          extra = 0;
        }
      }
      if (extra > 0) {
        shift = {L: L, k: extra};
        rows.forEach(function (row) {
          if (row.r > L) row.r += extra;
          row.cells.forEach(function (c) { if (c.inner && /<f\b/.test(c.inner)) c.inner = shiftCellFormula(c.inner, sh.name, L, extra); });
        });
      }
      // 品目の行を写す(すき間の空の行も同じ形にする)
      var tplMerges = [], mm, mre = /<mergeCell\b([^>]*?)\/?>/g, existing = {};
      while ((mm = mre.exec(model.tail))) {
        var ref = getAttr(mm[1], "ref") || "", pr = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref.replace(/\$/g, ""));
        if (pr) { existing[ref] = true; if (+pr[2] === T && +pr[4] === T) tplMerges.push(pr); }
      }
      var newMerges = [], byRow = {}, pristine = copyCells(tpl, 0);
      rows.forEach(function (row) { byRow[row.r] = row; });
      for (var i = 0; i < write; i++) {
        var rr = T + i, row;
        if (i === 0) row = tpl;
        else {
          var cells = copyCells({cells: pristine}, i);
          if (byRow[rr]) { row = byRow[rr]; row.cells = cells; }
          else { row = {r: rr, attrs: tpl.attrs, cells: cells}; rows.push(row); byRow[rr] = row; }
          tplMerges.forEach(function (p) { var nr = p[1] + rr + ":" + p[3] + rr; if (!existing[nr]) { existing[nr] = true; newMerges.push(nr); } });
        }
        var it = items[i] || {};
        var lk = function (raw) { var k = norm(raw); if (itemSet[k]) return Object.prototype.hasOwnProperty.call(it, k) ? it[k] : ""; return fieldLookup(raw); };
        row.cells.forEach(function (c) { if (c.ph && fillCell(c, c.text, lk, ctx.unknown)) touched = true; c.done = true; });
        row.done = true;
      }
      ctx.itemRows.push({sheet: sh.name, items: N, written: Math.min(N, write), slots: slots, inserted: extra});
      if (extraItemRows.length) ctx.warnings.push({level: "warn", code: "W_ITEM_MORE_ROWS", message_ja: "シート「" + sh.name + "」の " + extraItemRows.join("・") + " 行目にも品目の差し込みがあります。品目は最初の行(" + T + " 行目)から下へ1行ずつ入れるので、ほかの行の品目の差し込みは空にしました。"});
      ctx.newMerges = newMerges;
    }
    rows.forEach(function (row) {
      if (row.done) return;
      row.cells.forEach(function (c) { if (c.ph && !c.done && fillCell(c, c.text, fieldLookup, ctx.unknown)) touched = true; });
    });
    // 数式の前の計算結果は古くなるので消す(開いた時に計算し直す)
    rows.forEach(function (row) {
      row.cells.forEach(function (c) {
        if (c.inner && /<f\b/.test(c.inner) && /<v\b/.test(c.inner)) {
          c.inner = c.inner.replace(/<v\b[^>]*?(?:\/>|>[\s\S]*?<\/v>)/g, "");
          c.attrs = setAttr(c.attrs, "t", null);
          ctx.formulas = true; touched = true;
        }
      });
    });
    if (shift) {
      model.head = shiftOutside(model.head, sh.name, shift.L, shift.k);
      model.tail = shiftOutside(model.tail, sh.name, shift.L, shift.k);
      drawingPaths(book, sh.path).forEach(function (p) {
        var dx = book.text(p);
        if (dx) book.put(p, dx.replace(/<((?:\w+:)?)row>(\d+)<\/\1row>/g, function (a, pre, v) { return "<" + pre + "row>" + (+v >= shift.L ? +v + shift.k : v) + "</" + pre + "row>"; }));
      });
      ctx.shifts.push({sheet: sh.name, L: shift.L, k: shift.k});
      touched = true;
    }
    // 写した行の結合は、ずらした後に足す(足した結合までずらさないように)
    if (ctx.newMerges.length) { model.tail = addMerges(model.tail, ctx.newMerges); touched = true; }
    if (touched) book.put(sh.path, writeSheet(model));
  }
  function shiftCellFormula(inner, name, L, k) {
    return inner.replace(/<f\b([^>]*?)(\/>|>([\s\S]*?)<\/f>)/g, function (all, fa, end, ft) {
      var ref = getAttr(fa, "ref");
      if (ref) fa = setAttr(fa, "ref", shiftSqref(ref, L, k, false));
      return end === "/>" ? "<f" + fa + "/>" : "<f" + fa + ">" + escXml(shiftFormula(unescXml(ft), name, true, L, k)) + "</f>";
    });
  }
  function addMerges(tail, refs) {
    var add = refs.map(function (r) { return "<mergeCell ref=\"" + r + "\"/>"; }).join("");
    return tail.replace(/<mergeCells\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mergeCells>)/, function (all, a, inner) {
      var body = (inner || "") + add, n = (body.match(/<mergeCell\b/g) || []).length;
      return "<mergeCells" + setAttr(a, "count", String(n)) + ">" + body + "</mergeCells>";
    });
  }
  // sheetData の外(結合・印刷の改ページ・条件付き書式・入力規則・ハイパーリンク・使う範囲)の番地をずらす
  function shiftOutside(xml, name, L, k) {
    xml = xml.replace(/<mergeCell\b([^>]*?)(\/?)>/g, function (all, a, sl) { var r = getAttr(a, "ref"); return "<mergeCell" + (r ? setAttr(a, "ref", shiftSqref(r, L, k, true)) : a) + sl + ">"; });
    xml = xml.replace(/<(?!mergeCell\b)([A-Za-z][\w:.-]*)\b([^<>]*?)(\/?)>/g, function (all, tag, a, sl) {
      if (!/\s(ref|sqref|activeCell|topLeftCell)\s*=/.test(a)) return all;
      ["ref", "sqref", "activeCell", "topLeftCell"].forEach(function (n) { var v = getAttr(a, n); if (v != null) a = setAttr(a, n, shiftSqref(v, L, k, false)); });
      return "<" + tag + a + sl + ">";
    });
    // 改ページ(行の改ページだけ。列の改ページ colBreaks は触らない)
    xml = xml.replace(/<rowBreaks\b[\s\S]*?<\/rowBreaks>/g, function (blk) {
      return blk.replace(/<brk\b([^>]*?)(\/?)>/g, function (all, a, sl) { var id = parseInt(getAttr(a, "id"), 10); return "<brk" + (id > L ? setAttr(a, "id", String(id + k)) : a) + sl + ">"; });
    });
    return xml.replace(/<((?:\w+:)?formula[12]?)>([\s\S]*?)<\/\1>/g, function (all, tag, f) { return "<" + tag + ">" + escXml(shiftFormula(unescXml(f), name, true, L, k)) + "</" + tag + ">"; });
  }

  // ---- 入口: 差し込みの一覧 ----
  function scan(bytes, opts) {
    opts = opts || {};
    var norm = opts.normalize || defaultNorm;
    return unzip(bytes).then(function (entries) {
      var book = new Book(entries), names = [], seen = {}, raw = [], itemRow = false;
      book.sheets.forEach(function (sh) {
        var model = parseSheet(book.text(sh.path) || "");
        if (!model) return;
        model.rows.forEach(function (row) {
          row.cells.forEach(function (c) {
            var tx = cellText(c, book.sst);
            if (tx == null) return;
            placeholdersIn(tx, norm).forEach(function (p) {
              if (ITEM_KEYS.indexOf(p.key) >= 0 || (opts.itemKeys && opts.itemKeys.indexOf(p.key) >= 0)) itemRow = true;
              if (!seen[p.key]) { seen[p.key] = true; names.push(p.key); raw.push(p.raw); }
            });
          });
        });
      });
      return {names: names, raw: raw, sheets: book.sheets.map(function (s) { return s.name; }), hasItemRow: itemRow};
    });
  }
  function listPlaceholders(bytes, opts) { return scan(bytes, opts).then(function (r) { return r.names; }); }

  // ---- 入口: 差し込んで新しい .xlsx を作る ----
  // data = {fields: {現場名: "…", 合計: 23000, …}, items: [{品名: "…", 数量: 12.5, …}, …]}
  function fill(bytes, data, opts) {
    opts = opts || {};
    data = {fields: (data && data.fields) || {}, items: (data && data.items) || []};
    var norm = opts.normalize || defaultNorm, itemSet = {};
    (opts.itemKeys || ITEM_KEYS).forEach(function (k) { itemSet[norm(k)] = true; });
    var fields = {}, items;
    Object.keys(data.fields).forEach(function (k) { fields[norm(k)] = data.fields[k]; });
    items = data.items.map(function (it) { var o = {}; Object.keys(it).forEach(function (k) { o[norm(k)] = it[k]; }); return o; });
    return unzip(bytes).then(function (entries) {
      var book = new Book(entries);
      var ctx = {norm: norm, itemSet: itemSet, warnings: [], unknown: {}, itemRows: [], shifts: [], itemSheets: 0, formulas: false};
      book.sheets.forEach(function (sh) { fillSheet(book, sh, {fields: fields, items: items}, ctx); });
      // ほかのシートの数式・名前の定義(印刷範囲など)の中の、行を足したシートへの番地もずらす
      ctx.shifts.forEach(function (s) {
        book.sheets.forEach(function (o) {
          if (o.name === s.sheet) return;
          var x = book.text(o.path);
          if (x && /<f\b/.test(x)) book.put(o.path, x.replace(/<f((?:\s[^>]*?)?)(?<!\/)>([\s\S]*?)<\/f>/g, function (a, fa, ft) { return "<f" + fa + ">" + escXml(shiftFormula(unescXml(ft), s.sheet, false, s.L, s.k)) + "</f>"; }));
        });
        book.wb = book.wb.replace(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g, function (a, da, ft) { return "<definedName" + da + ">" + escXml(shiftFormula(unescXml(ft), s.sheet, false, s.L, s.k)) + "</definedName>"; });
      });
      if (items.length && !ctx.itemSheets) ctx.warnings.push({level: "warn", code: "W_NO_ITEM_ROW", message_ja: "ひな形に品目の差し込み({{品名}} {{数量}} {{金額}} など)がないので、品目は入れていません。品目の表の1行目に書いてください。"});
      var unk = Object.keys(ctx.unknown);
      if (unk.length) ctx.warnings.push({level: "warn", code: "W_UNKNOWN_PLACEHOLDER", message_ja: "このアプリが知らない差し込みはそのまま残しました: " + unk.map(function (u) { return "{{" + u + "}}"; }).join(" ") + "(書き方は「使える差し込み」を見てください)。"});
      // 開いた時に計算し直す・古い計算の順番(calcChain)は捨てる
      book.wb = /<calcPr\b/.test(book.wb) ? book.wb.replace(/<calcPr\b([^>]*?)(\/?)>/, function (a, ca, sl) { return "<calcPr" + setAttr(ca, "fullCalcOnLoad", "1") + sl + ">"; })
        : book.wb.replace(/(<(?:oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>)/, "<calcPr fullCalcOnLoad=\"1\"/>$1");
      book.put(book.wbPath, book.wb);
      var cc = book.wbRels.filter(function (r) { return /\/calcChain$/.test(r.type); })[0];
      if (cc) {
        var ccPath = resolve(dirOf(book.wbPath), cc.target);
        book.remove(ccPath);
        book.put(book.wbRelsPath, book.text(book.wbRelsPath).replace(/<Relationship\b[^>]*\/calcChain"[^>]*\/>/g, ""));
        book.put("[Content_Types].xml", book.text("[Content_Types].xml").replace(new RegExp("<Override\\b[^>]*PartName=\"/" + ccPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "\"[^>]*/>", "i"), ""));
      }
      var enc = new TextEncoder();
      var files = book.entries.filter(function (e) { return !e.removed; }).map(function (e) { return {name: e.name, data: e.dirty ? enc.encode(e.text) : e.data}; });
      return zip(files, {date: opts.date}).then(function (out) {
        return {bytes: out, warnings: ctx.warnings, unknown: unk, itemRows: ctx.itemRows, shifts: ctx.shifts};
      });
    });
  }

  // ---- 試験と確かめ用: できた .xlsx の中身を読む ----
  function readBook(bytes) {
    return unzip(bytes).then(function (entries) {
      var book = new Book(entries);
      return {entries: entries.map(function (e) { return e.name; }), workbook: book.wb, sheets: book.sheets.map(function (sh) {
        var xml = book.text(sh.path), model = parseSheet(xml), cells = {}, merges = [], m, re = /<mergeCell\b([^>]*?)\/?>/g;
        model.rows.forEach(function (row) {
          row.cells.forEach(function (c) {
            var ref = colName(c.col) + row.r, inner = c.inner || "", t = getAttr(c.attrs, "t"), f = /<f(?:\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/f>/.exec(inner), v = /<v>([\s\S]*?)<\/v>/.exec(inner);
            var o = {s: getAttr(c.attrs, "s")};
            if (f) o.f = unescXml(f[1]);
            if (t === "s" && v) o.v = book.sst[+v[1]]; else if (t === "inlineStr") o.v = cellText(c, book.sst); else if (v) o.v = t === "str" ? unescXml(v[1]) : Number(v[1]);
            cells[ref] = o;
          });
        });
        while ((m = re.exec(model.tail))) merges.push(getAttr(m[1], "ref"));
        var dim = /<dimension\b([^>]*?)\/?>/.exec(model.head);
        return {name: sh.name, path: sh.path, xml: xml, cells: cells, merges: merges, rows: model.rows.map(function (r) { return r.r; }), dimension: dim ? getAttr(dim[1], "ref") : null};
      })};
    });
  }

  // ---- 請求書として使う時: ひな形に適格請求書の記載事項6つの差し込みがあるか ----
  // names = scan の names。rates = 品目にある税率(例 [10, 8])。足りない物を日本語で返す(止めない。日報・見積では呼ばない)
  // 国税庁「適格請求書等保存方式の概要」の記載事項: ①発行者の名前と登録番号 ②取引の日 ③取引の内容(軽減税率の対象ならその旨)
  // ④税率ごとに分けた合計と税率 ⑤税率ごとの消費税額 ⑥受け取る人の名前
  var FIELD_KEYS = ["書類名", "現場名", "日付", "天気", "お客様", "自分の名前", "登録番号", "住所", "電話", "振込先", "備考", "合計", "10%対象", "消費税10%", "8%対象", "消費税8%", "請求金額", "軽減の注記", "作業した人", "作業の記録", "有効期限"];
  function invoiceMissing(names, rates, opts) {
    var norm = (opts && opts.normalize) || defaultNorm, has = {};
    (names || []).forEach(function (n) { has[norm(n)] = true; });
    rates = (rates && rates.length) ? rates : [10];
    var need = [
      {no: 1, label: "発行する人の名前と登録番号", keys: ["自分の名前", "登録番号"]},
      {no: 2, label: "取引の日", keys: ["日付"]},
      {no: 3, label: "取引の内容", keys: ["品名"]},
      {no: 4, label: "税率ごとに分けた合計と税率", keys: rates.map(function (r) { return r + "%対象"; })},
      {no: 5, label: "税率ごとの消費税額", keys: rates.map(function (r) { return "消費税" + r + "%"; })},
      {no: 6, label: "受け取る人(お客様)の名前", keys: ["お客様"]}
    ];
    if (rates.indexOf(8) >= 0) need[2].alt = ["税率", "軽減の注記"];   // 軽減税率の対象である旨
    var out = [];
    need.forEach(function (n) {
      var miss = n.keys.filter(function (k) { return !has[norm(k)]; });
      if (n.alt && !n.alt.some(function (k) { return has[norm(k)]; })) miss.push(n.alt.join("|"));   // どれか1つあればよい
      if (miss.length) out.push({no: n.no, label: n.label, missing: miss});
    });
    return out;
  }
  function invoiceMissingText(list) {
    if (!list.length) return "";
    return "このひな形には、適格請求書の記載事項のうち次の差し込みがありません: " + list.map(function (m) {
      return "(" + m.no + ")" + m.label + " → " + m.missing.map(function (k) { return k.split("|").map(function (x) { return "{{" + x + "}}"; }).join(" または "); }).join(" ");
    }).join(" / ") + "。このままでは請求書として記載が足りません(ひな形に書き足すか、書類を手で補ってください)。日報・見積として使う時は気にしなくてかまいません。";
  }

  // ---- 見本のひな形(ひな形の見本.xlsx)をこの場で作る ----
  var NS = "http://schemas.openxmlformats.org/";
  function sampleFiles() {
    var strings = [], sIdx = {};
    function si(s) { if (sIdx[s] == null) { sIdx[s] = strings.length; strings.push(s); } return sIdx[s]; }
    var cells = {};   // "A1": [text, style]
    function put(ref, text, style) { cells[ref] = [text, style]; }
    put("A1", "{{書類名}}", 1);
    put("A3", "{{お客様}}", 2); put("A4", "現場: {{現場名}}", 0); put("A5", "天気: {{天気}}", 0);
    put("E3", "{{日付}}", 3); put("E4", "{{自分の名前}}", 4); put("E5", "登録番号 {{登録番号}}", 3); put("E6", "{{住所}}", 3); put("E7", "{{電話}}", 3);
    put("A8", "ご請求金額(税込)", 4); put("C8", "{{請求金額}}", 10);
    ["No", "品名", "数量", "単位", "単価", "金額", "税率"].forEach(function (h, i) { put(colName(i + 1) + "10", h, 5); });
    put("A11", "{{No}}", 8); put("B11", "{{品名}}", 6); put("C11", "{{数量}}", 8); put("D11", "{{単位}}", 6); put("E11", "{{単価}}", 7); put("F11", "{{金額}}", 7); put("G11", "{{税率}}", 6);
    [["小計(税抜)", "{{合計}}"], ["10%対象", "{{10%対象}}"], ["消費税(10%)", "{{消費税10%}}"], ["8%対象", "{{8%対象}}"], ["消費税(8%)", "{{消費税8%}}"], ["合計(税込)", "{{請求金額}}"]].forEach(function (p, i) {
      put("E" + (13 + i), p[0], 8); put("F" + (13 + i), p[1], 9);
    });
    put("A19", "{{軽減の注記}}", 0);
    put("A20", "振込先", 4); put("B20", "{{振込先}}", 0);
    put("A21", "備考", 4); put("B21", "{{備考}}", 0);
    put("A23", "作業の記録: {{作業の記録}}", 0);
    var merges = ["A1:G1", "A3:D3", "E3:G3", "E4:G4", "E5:G5", "E6:G6", "E7:G7", "A8:B8", "C8:E8", "F13:G13", "F14:G14", "F15:G15", "F16:G16", "F17:G17", "F18:G18", "A19:G19", "B20:G20", "B21:G21", "A23:G23"];
    var styleOfEmpty = {"C8": 10, "D8": 10, "E8": 10};
    for (var r = 13; r <= 18; r++) styleOfEmpty["G" + r] = 9;
    var byRow = {};
    Object.keys(cells).concat(Object.keys(styleOfEmpty)).forEach(function (ref) { var p = splitRef(ref); (byRow[p.row] = byRow[p.row] || {})[p.col] = ref; });
    var rowsXml = Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; }).map(function (r) {
      var ht = r === 1 ? " ht=\"30\" customHeight=\"1\"" : r === 8 ? " ht=\"24\" customHeight=\"1\"" : "";
      return "<row r=\"" + r + "\"" + ht + ">" + Object.keys(byRow[r]).map(Number).sort(function (a, b) { return a - b; }).map(function (c) {
        var ref = byRow[r][c], cl = cells[ref];
        if (!cl) return "<c r=\"" + ref + "\" s=\"" + styleOfEmpty[ref] + "\"/>";
        return "<c r=\"" + ref + "\" s=\"" + cl[1] + "\" t=\"s\"><v>" + si(cl[0]) + "</v></c>";
      }).join("") + "</row>";
    }).join("");
    var sheet = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"" + NS + "spreadsheetml/2006/main\" xmlns:r=\"" + NS + "officeDocument/2006/relationships\">" +
      "<sheetPr><pageSetUpPr fitToPage=\"1\"/></sheetPr><dimension ref=\"A1:G23\"/><sheetViews><sheetView workbookViewId=\"0\"/></sheetViews><sheetFormatPr defaultRowHeight=\"18\"/>" +
      "<cols><col min=\"1\" max=\"1\" width=\"5\" customWidth=\"1\"/><col min=\"2\" max=\"2\" width=\"26\" customWidth=\"1\"/><col min=\"3\" max=\"3\" width=\"8\" customWidth=\"1\"/><col min=\"4\" max=\"4\" width=\"6\" customWidth=\"1\"/><col min=\"5\" max=\"5\" width=\"12\" customWidth=\"1\"/><col min=\"6\" max=\"6\" width=\"13\" customWidth=\"1\"/><col min=\"7\" max=\"7\" width=\"9\" customWidth=\"1\"/></cols>" +
      "<sheetData>" + rowsXml + "</sheetData>" +
      "<mergeCells count=\"" + merges.length + "\">" + merges.map(function (m) { return "<mergeCell ref=\"" + m + "\"/>"; }).join("") + "</mergeCells>" +
      "<pageMargins left=\"0.6\" right=\"0.5\" top=\"0.7\" bottom=\"0.6\" header=\"0.3\" footer=\"0.3\"/><pageSetup paperSize=\"9\" orientation=\"portrait\" fitToWidth=\"1\" fitToHeight=\"0\"/></worksheet>";
    var font = function (sz, b, u) { return "<font>" + (b ? "<b/>" : "") + (u ? "<u/>" : "") + "<sz val=\"" + sz + "\"/><name val=\"游ゴシック\"/><family val=\"3\"/><charset val=\"128\"/></font>"; };
    var thin = "<border><left style=\"thin\"><color auto=\"1\"/></left><right style=\"thin\"><color auto=\"1\"/></right><top style=\"thin\"><color auto=\"1\"/></top><bottom style=\"thin\"><color auto=\"1\"/></bottom><diagonal/></border>";
    var xf = function (font, fill, border, numFmt, align) { return "<xf numFmtId=\"" + numFmt + "\" fontId=\"" + font + "\" fillId=\"" + fill + "\" borderId=\"" + border + "\" xfId=\"0\"" + (numFmt ? " applyNumberFormat=\"1\"" : "") + (font ? " applyFont=\"1\"" : "") + (fill ? " applyFill=\"1\"" : "") + (border ? " applyBorder=\"1\"" : "") + (align ? " applyAlignment=\"1\"><alignment " + align + "/></xf>" : "/>"); };
    var styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<styleSheet xmlns=\"" + NS + "spreadsheetml/2006/main\">" +
      "<numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"&quot;¥&quot;#,##0\"/></numFmts>" +
      "<fonts count=\"4\">" + font(11) + font(18, true) + font(11, true) + font(13, false, true) + "</fonts>" +
      "<fills count=\"3\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFDCE6F2\"/><bgColor indexed=\"64\"/></patternFill></fill></fills>" +
      "<borders count=\"3\"><border><left/><right/><top/><bottom/><diagonal/></border>" + thin + "<border><left/><right/><top/><bottom style=\"medium\"><color auto=\"1\"/></bottom><diagonal/></border></borders>" +
      "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"11\">" +
      xf(0, 0, 0, 0) + xf(1, 0, 0, 0, "horizontal=\"center\" vertical=\"center\"") + xf(3, 0, 2, 0) + xf(0, 0, 0, 0, "horizontal=\"right\"") + xf(2, 0, 0, 0, "horizontal=\"right\"") +
      xf(2, 2, 1, 0, "horizontal=\"center\"") + xf(0, 0, 1, 0, "vertical=\"center\" wrapText=\"1\"") + xf(0, 0, 1, 3) + xf(0, 0, 1, 0, "horizontal=\"right\"") + xf(0, 0, 1, 3) + xf(1, 0, 2, 164, "horizontal=\"center\"") +
      "</cellXfs><cellStyles count=\"1\"><cellStyle name=\"標準\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>";
    var sst = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<sst xmlns=\"" + NS + "spreadsheetml/2006/main\" count=\"" + strings.length + "\" uniqueCount=\"" + strings.length + "\">" + strings.map(function (s) { return "<si><t xml:space=\"preserve\">" + escXml(s) + "</t></si>"; }).join("") + "</sst>";
    var wb = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<workbook xmlns=\"" + NS + "spreadsheetml/2006/main\" xmlns:r=\"" + NS + "officeDocument/2006/relationships\"><bookViews><workbookView/></bookViews><sheets><sheet name=\"ひな形\" sheetId=\"1\" r:id=\"rId1\"/></sheets>" +
      "<definedNames><definedName name=\"_xlnm.Print_Area\" localSheetId=\"0\">'ひな形'!$A$1:$G$23</definedName></definedNames><calcPr calcId=\"191029\"/></workbook>";
    var rel = function (id, type, target) { return "<Relationship Id=\"" + id + "\" Type=\"" + NS + "officeDocument/2006/relationships/" + type + "\" Target=\"" + target + "\"/>"; };
    var rels = function (body) { return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"" + NS + "package/2006/relationships\">" + body + "</Relationships>"; };
    var ct = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"" + NS + "package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
      "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>" +
      "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\"/></Types>";
    return [
      {name: "[Content_Types].xml", data: ct},
      {name: "_rels/.rels", data: rels(rel("rId1", "officeDocument", "xl/workbook.xml"))},
      {name: "xl/workbook.xml", data: wb},
      {name: "xl/_rels/workbook.xml.rels", data: rels(rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId2", "styles", "styles.xml") + rel("rId3", "sharedStrings", "sharedStrings.xml"))},
      {name: "xl/worksheets/sheet1.xml", data: sheet},
      {name: "xl/styles.xml", data: styles},
      {name: "xl/sharedStrings.xml", data: sst}
    ];
  }
  function buildSample(opts) { return zip(sampleFiles(), opts); }

  // 端末に覚えておくための base64(大きなファイルでも止まらないように分けて変換)
  function toBase64(u8) { var s = "", CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function fromBase64(b64) { var s = atob(String(b64 || "")), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

  var api = {FIELD_KEYS: FIELD_KEYS, invoiceMissing: invoiceMissing, invoiceMissingText: invoiceMissingText, crc32: crc32, unzip: unzip, zip: zip, scan: scan, listPlaceholders: listPlaceholders, fill: fill, readBook: readBook, buildSample: buildSample, sampleFiles: sampleFiles,
    shiftFormula: shiftFormula, copyFormula: copyFormula, shiftA1: shiftA1, toBase64: toBase64, fromBase64: fromBase64, ITEM_KEYS: ITEM_KEYS, MAX_ZIP: MAX_ZIP};
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.XlsxFill = api;
})(this);
