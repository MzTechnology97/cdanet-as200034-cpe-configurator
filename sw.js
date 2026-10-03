const CACHE='cda-cpe-pwa-v0.4.0-refresh-1';
const SHELL=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./assets/cda-net-logo.svg','./assets/icon.svg'];

self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
});

self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
  ]));
});

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);

  // API/auth/provisioning: never cache session or provisioning data.
  if(url.pathname.startsWith('/api/')){
    event.respondWith(fetch(req));
    return;
  }

  if(url.origin!==self.location.origin) return;

  // Navigations and executable UI assets are network-first so a deployed
  // correction is visible immediately; cached copies remain the offline fallback.
  const isUi=req.mode==='navigate' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/app.js') ||
    url.pathname.endsWith('/styles.css') ||
    url.pathname.endsWith('/manifest.webmanifest');

  if(isUi){
    event.respondWith(
      fetch(req,{cache:'no-store'}).then(resp=>{
        if(resp.ok&&resp.type==='basic'){
          const copy=resp.clone();
          event.waitUntil(caches.open(CACHE).then(cache=>cache.put(req,copy)));
        }
        return resp;
      }).catch(async()=>{
        return (await caches.match(req)) ||
          (req.mode==='navigate' ? await caches.match('./index.html') : Response.error());
      })
    );
    return;
  }

  // Images/static shell: cache-first with background refresh.
  event.respondWith(caches.match(req).then(hit=>{
    const refresh=fetch(req).then(resp=>{
      if(resp.ok&&resp.type==='basic'){
        const copy=resp.clone();
        event.waitUntil(caches.open(CACHE).then(cache=>cache.put(req,copy)));
      }
      return resp;
    }).catch(()=>null);
    return hit || refresh.then(resp=>resp||Response.error());
  }));
});
