// 現場の書類: 電波のない現場でも開けるように、このページの部品だけを端末に残す。
// 入力・写真は扱わない(ページの中の下書きはブラウザの保存領域だけ)。外のサーバーには何も送らない。
"use strict";
var CACHE = "genba-shorui-0.6.1";
var FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("genba-shorui-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  // 同じ場所の GET だけを扱う。ほかの通信には手を出さない(このページは外へ通信しない)
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(req, {ignoreSearch: true}).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res && res.ok && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return caches.match("./index.html"); });
  }));
});
