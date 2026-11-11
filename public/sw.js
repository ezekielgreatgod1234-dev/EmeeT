/* EmeeT service worker.
   - Pages: always fetched from the network, so a new deploy shows up right away.
     If the device is offline, a small offline page is shown instead.
   - Same-origin static files (icons, built JS/CSS): served from cache while a
     fresh copy is fetched in the background.
   - Everything on other domains (PeerJS, Metered, Tailwind, OCR data) goes
     straight to the network and is never cached here. */

const VERSION = 'emeet-v1'
const SHELL = [
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png'
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then(cache =>
        Promise.all(SHELL.map(url => cache.add(url).catch(() => undefined)))
      )
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Page loads
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html'))
    )
    return
  }

  // Static files
  event.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(request)

      const network = fetch(request)
        .then(response => {
          if (response.ok && response.type === 'basic') {
            cache.put(request, response.clone())
          }
          return response
        })
        .catch(() => cached)

      return cached || network
    })
  )
})