// Scrambl service worker: offline shell and push notifications.
// Only the app's own files are cached; messages and attachments are never stored here.
// Every path is relative to where this file is served from, so the app works both at the
// root of its own server and in a sub-folder (for example on GitHub Pages).
const CACHE_NAME = 'scrambl-cache-v6';
const BASE = self.registration.scope;
const at = (name) => new URL(name, BASE).href;
const ASSETS = ['', 'client.html', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'].map(at);

self.addEventListener('install', (e) => {
  // Cache what is there; a missing optional file must not stop the worker installing.
  e.waitUntil(caches.open(CACHE_NAME)
    .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = req.url.split('#')[0].split('?')[0];
  if (req.method !== 'GET' || !ASSETS.includes(url)) return;
  // The saved copy is shown at once, so the app starts without waiting for the network
  // (the page is half a megabyte). The server's copy is fetched alongside; if it turns
  // out to be different, it replaces the saved one and the open page is told, which then
  // switches to it. A reload that asks for the newest copy goes to the network first.
  const wantsNewest = req.cache === 'reload' || req.cache === 'no-cache' || req.cache === 'no-store';
  const isPage = url === at('') || url === at('client.html');
  const job = (async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = wantsNewest ? null : await cache.match(url);
    // A second copy to compare with: the first is used up by being shown.
    const before = saved && isPage ? saved.clone() : null;
    // Resolves to the server's answer when it is fit to show, otherwise to null.
    const refresh = (async () => {
      // Where the server can say "unchanged" (it names each version with an ETag), the
      // half megabyte is not downloaded again just to find out.
      const tag = saved ? saved.headers.get('etag') : '';
      const net = await fetch(url, { cache: 'no-store', headers: tag ? { 'If-None-Match': tag } : {} });
      // Not a plain answer from this site (an error, "unchanged", or a redirect, which a
      // browser will not show as a page): the saved copy stays as it is.
      if (!net.ok || net.redirected || net.type !== 'basic') return null;
      let now = '';
      if (isPage) {
        // Only the whole app replaces the saved app: never a placeholder or half a page.
        now = await net.clone().text();
        if (!now.includes('apple-mobile-web-app-title" content="Scrambl"') || !now.trimEnd().endsWith('</html>')) return null;
      }
      let ref = '';
      if (before && (await before.text()) !== now) {
        const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(now)));
        ref = Array.from(h.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
      }
      // If it cannot be saved, the old copy is dropped so the next start asks the server.
      try { await cache.put(url, net.clone()); }
      catch { await cache.delete(url).catch(() => {}); }
      if (ref) {
        // Told to the open page, and also left as a note in case the page was not listening yet.
        await cache.put(at('page-updated'), new Response(JSON.stringify({ ref, at: Date.now() }))).catch(() => {});
        for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'scrambl-page-updated', ref });
      }
      return net;
    })();
    refresh.catch(() => {});
    return { cache, saved, refresh };
  })();
  e.respondWith(job.then(async ({ cache, saved, refresh }) => {
    if (saved) return saved;
    try { const net = await refresh; if (net) return net; } catch {}
    return (await cache.match(url)) || (await cache.match(at('client.html'))) || (await cache.match(at(''))) || fetch(req);
  }));
  // Keeps the worker alive until the saved copy has been renewed.
  e.waitUntil(job.then(({ refresh }) => refresh).catch(() => {}));
});

// ---------- push notifications ----------
// A push says which chat has something new. The page keeps a small table of chat names
// on this device so the notification can say which chat it is.
// When the message is small enough the push carries it too, still encrypted with the
// chat's key, which the server does not have: a push never holds readable message text.
// The page also keeps each chat's key and your nicknames here, so the notification can
// say who wrote and what, worked out on this device.
function openTable() {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('scrambl-sw', 2);
      open.onupgradeneeded = () => { for (const n of ['names', 'keys', 'people']) if (!open.result.objectStoreNames.contains(n)) open.result.createObjectStore(n); };
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
      open.onsuccess = () => resolve(open.result);
    } catch (_) { resolve(null); }
  });
}
const lookUp = (db, table, key) => new Promise((resolve) => {
  try {
    const get = db.transaction(table).objectStore(table).get(key);
    get.onsuccess = () => resolve(get.result);
    get.onerror = () => resolve(undefined);
  } catch (_) { resolve(undefined); }
});
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// The same short code the app shows for a person, worked out from their public key.
async function friendCode(pk) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64(pk)));
  let out = '', acc = 0, n = 0;
  for (const b of h.subarray(0, 10)) {
    acc = (acc << 8) | b; n += 8;
    while (n >= 5) { out += B32[(acc >>> (n - 5)) & 31]; n -= 5; }
    acc &= (1 << n) - 1;
  }
  return out.match(/.{4}/g).join('-');
}
// What to call the chat, and what the message says if it can be read: { name, text }.
async function describe(room, blob) {
  const db = await openTable();
  if (!db) return null;
  const out = { name: null, text: null };
  try {
    const name = await lookUp(db, 'names', room);
    if (typeof name === 'string' && name) out.name = name;
    const k = blob ? await lookUp(db, 'keys', room) : null;
    if (k && k.key) {
      const raw = fromB64(blob);
      const m = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, k.key, raw.subarray(12))));
      const what = m.kind === 'text' && typeof m.text === 'string' ? m.text.replace(/\s+/g, ' ').slice(0, 140)
        : m.kind === 'file' && m.file ? 'sent ' + String(m.file.name).slice(0, 80)
        : m.kind === 'snap' ? 'sent a Blip'
        : m.kind === 'keep' ? 'saved a Blip in chat' : '';
      if (what) {
        let who = String(m.a || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Someone';
        if (typeof m.pk === 'string' && m.pk.length <= 200) {
          const nick = await lookUp(db, 'people', await friendCode(m.pk));
          if (typeof nick === 'string' && nick) who = nick;
        }
        // In a private chat the title already says who it is from.
        out.text = k.dm && m.kind === 'text' ? what : who + (m.kind === 'text' ? ': ' : ' ') + what;
      }
    }
  } catch (_) {}
  try { db.close(); } catch (_) {}
  return out;
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let d = {};
    try { d = e.data.json(); } catch (_) {}
    const room = typeof d.room === 'string' ? d.room : '';
    // Every push must end in a notification: an iPhone cancels the registration of an app
    // whose pushes show nothing. So looking up the chat's name is never allowed to hold it up.
    let info = null;
    if (!d.inbox && room) info = await Promise.race([describe(room, typeof d.blob === 'string' ? d.blob : '').catch(() => null), new Promise((r) => setTimeout(() => r(null), 2000))]);
    const title = d.inbox ? 'New friend request' : ((info && info.name) || 'Scrambl');
    const body = d.inbox ? 'Open Scrambl to answer it.' : ((info && info.text) || 'New messages');
    try {
      await self.registration.showNotification(title, { body, tag: room || 'scrambl', renotify: true, icon: at('icon-192.png'), badge: at('icon-192.png'), data: { room, inbox: !!d.inbox } });
    } catch (_) {
      await self.registration.showNotification(title, { body });
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const room = (e.notification.data && e.notification.data.room) || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        await w.focus();
        w.postMessage({ openRoom: room });
        return;
      }
    }
    await self.clients.openWindow(BASE + '#open=' + encodeURIComponent(room));
  })());
});
