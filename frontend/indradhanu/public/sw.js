/* Indradhanu service worker.
 *
 * This exists for one situation: somebody opens the app during a flood, on a
 * phone, on a network that is congested or gone. What it has to do in that
 * situation is not "be fast" — it is **not lose the report**.
 *
 * Three behaviours, in order of how much they matter:
 *
 *   1. **A report survives having no signal.** A failed POST of a report is
 *      written to IndexedDB and replayed when connectivity returns, through
 *      Background Sync where the browser supports it and on the next load where
 *      it does not. The report carries its own `occurredAt`, and the intake
 *      pipeline already accepts one, so a report that syncs an hour late is
 *      still scored against the moment it was made rather than the moment it
 *      arrived. That is the same store-and-forward the mesh path assumes.
 *   2. **The last known world is readable offline.** Guidance and surroundings
 *      are cached as they are fetched, and served stale with a header saying so
 *      when the network fails. Stale information clearly marked as stale beats a
 *      spinner.
 *   3. **The shell loads.** Standard precache, so the app opens on a dead
 *      network instead of showing the browser's offline page.
 *
 * Deliberately *not* cached: anything under /api/v1/demo or /config. A control
 * room screen must never show a stale world silently, and a configuration
 * screen must never write against a stale one.
 */

const VERSION = "indradhanu-v1"
const SHELL = `${VERSION}-shell`
const DATA = `${VERSION}-data`

/* Enough to boot. Vite's hashed assets are picked up by the runtime cache
 * below rather than listed here, because their names change every build. */
const SHELL_URLS = ["/", "/citizen", "/field", "/manifest.webmanifest"]

/* Requests whose responses are worth keeping to show offline. */
const CACHEABLE_GET = [
  "/api/v1/citizen/state",
  "/api/v1/field/state",
  "/api/v1/field/status-kinds",
  "/api/v1/taxonomy",
]

/* Posts that must not be lost. */
const QUEUEABLE_POST = [
  "/api/v1/citizen/report",
  "/api/v1/citizen/report/voice",
  "/api/v1/field/status",
]

// --------------------------------------------------------------- lifecycle --
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      // A shell URL that 404s during install would otherwise abort the whole
      // installation and leave the app with no worker at all.
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  )
})

// ------------------------------------------------------------------- queue --
/* A tiny IndexedDB queue. No library: this file must work before anything else
 * on the page has loaded, and a dependency here is a dependency that can fail
 * exactly when it is needed. */
const DB_NAME = "indradhanu-outbox"
const STORE = "requests"

function openDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true })
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
}

async function enqueue(entry) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).add(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function drain() {
  const db = await openDb()
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly")
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })

  let sent = 0
  for (const entry of all) {
    try {
      const response = await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body,
      })
      // A 4xx means the server has seen it and refused it. Retrying forever
      // would be a queue that never empties, so it is dropped and reported.
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        await remove(db, entry.id)
        if (response.ok) sent += 1
      }
    } catch {
      // Still offline. Leave the rest for the next attempt.
      break
    }
  }

  if (sent > 0) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true })
    for (const client of clients) {
      client.postMessage({ type: "outbox-sent", count: sent })
    }
  }
  return sent
}

function remove(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function queued() {
  const db = await openDb()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly")
    const req = tx.objectStore(STORE).count()
    req.onsuccess = () => resolve(req.result || 0)
    req.onerror = () => resolve(0)
  })
}

// ------------------------------------------------------------------- fetch --
self.addEventListener("fetch", (event) => {
  const { request } = event
  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin

  if (request.method === "POST" && QUEUEABLE_POST.some((p) => url.pathname.endsWith(p))) {
    event.respondWith(postOrQueue(request))
    return
  }

  if (request.method !== "GET") return

  // Never serve a control room or configuration screen from cache.
  if (url.pathname.includes("/demo/") || url.pathname.includes("/config/")) return

  if (CACHEABLE_GET.some((p) => url.pathname.endsWith(p))) {
    event.respondWith(networkFirst(request))
    return
  }

  // Navigations: the app shell, so a cold start on a dead network still opens.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/citizen").then((r) => r || caches.match("/"))
      )
    )
    return
  }

  if (sameOrigin) event.respondWith(cacheFirst(request))
})

async function postOrQueue(request) {
  const clone = request.clone()
  try {
    return await fetch(request)
  } catch {
    const body = await clone.text()
    const headers = {}
    clone.headers.forEach((v, k) => { headers[k] = v })
    await enqueue({
      url: clone.url, method: clone.method, headers, body,
      queuedAt: new Date().toISOString(),
    })
    if ("sync" in self.registration) {
      try { await self.registration.sync.register("indradhanu-outbox") } catch { /* */ }
    }
    const n = await queued()
    // 202: accepted, not done. The client shows "saved, will send when you have
    // signal" rather than a success it cannot honour.
    return new Response(
      JSON.stringify({
        queued: true,
        queueLength: n,
        message:
          "No signal. This is saved on your phone and will be sent the moment " +
          "you are back online.",
      }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    )
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(DATA)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    if (!cached) throw new Error("offline and nothing cached")
    // Marked, so the interface can say how old this is rather than presenting
    // it as current.
    const headers = new Headers(cached.headers)
    headers.set("X-Indradhanu-Stale", "1")
    return new Response(cached.body, {
      status: cached.status, statusText: cached.statusText, headers,
    })
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok && new URL(request.url).origin === self.location.origin) {
    const cache = await caches.open(SHELL)
    cache.put(request, response.clone())
  }
  return response
}

// -------------------------------------------------------------------- sync --
self.addEventListener("sync", (event) => {
  if (event.tag === "indradhanu-outbox") event.waitUntil(drain())
})

self.addEventListener("message", (event) => {
  if (event.data?.type === "drain-outbox") event.waitUntil(drain())
  if (event.data?.type === "skip-waiting") self.skipWaiting()
})
