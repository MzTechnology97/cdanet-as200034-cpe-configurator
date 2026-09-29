const CACHE='cda-cpe-v0.1.0-tc2-offline-1';
const SHELL=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./assets/cda-net-logo.svg','./assets/icon.svg'];
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)))});
self.addEventListener('activate',event=>event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))])));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  // API/auth/provisioning responses can contain sensitive/session data: network only, never Cache Storage.
  if(url.pathname.startsWith('/api/')){event.respondWith(fetch(req));return;}
  // Only same-origin static application shell is cacheable.
  if(url.origin!==self.location.origin)return;
  event.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(resp=>{
    if(resp.ok&&resp.type==='basic'){const copy=resp.clone();caches.open(CACHE).then(cache=>cache.put(req,copy));}
    return resp;
  }).catch(()=>req.mode==='navigate'?caches.match('./index.html'):Promise.reject(new Error('offline')))));
});
