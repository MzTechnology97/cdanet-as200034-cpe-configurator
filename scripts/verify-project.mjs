import fs from 'node:fs';

const read=p=>fs.readFileSync(p,'utf8');
const fail=[];
const ok=(cond,msg)=>{if(!cond)fail.push(msg)};
const version='0.5.0';
const code=50;

const index=read('index.html');
const app=read('app.js');
const sw=read('sw.js');
const server=read('server/src/server.js');
const tools=read('server/src/tools.js');
const ros=read('server/src/routeros.js');
const web=read('web-agent/server.mjs');
const android=read('.github/workflows/android-apk.yml');
const compose=read('deploy/docker-compose.yml');

ok(index.includes('v'+version),'index version');
ok(app.includes('v'+version),'app version');
ok(sw.includes('v'+version),'service worker cache version');
ok(server.includes("APP_VERSION='"+version+"'"),'backend version');
ok(JSON.parse(read('server/package.json')).version===version,'server package version');
ok(JSON.parse(read('android/package.json')).version===version,'android package version');
ok(JSON.parse(read('web-agent/package.json')).version===version,'web bridge package version');
ok(android.includes('versionCode '+code),'android versionCode');
ok(android.includes('versionName "'+version+'"'),'android versionName');

const sections=new Set([...index.matchAll(/<section id="([^"]+)"/g)].map(m=>m[1]));
const toolButtons=[...new Set([...index.matchAll(/data-tool="([^"]+)"/g)].map(m=>m[1]))];
for(const id of toolButtons)ok(sections.has(id),'missing section for tool '+id);

const nativeActions=[...new Set([...index.matchAll(/data-native="([^"]+)"/g)].map(m=>m[1]))];
for(const a of nativeActions)ok(app.includes("'"+a+"'")||app.includes('"'+a+'"'),'native UI action not handled: '+a);

const rosActions=[...new Set([...index.matchAll(/data-ros="([^"]+)"/g)].map(m=>m[1]))];
for(const a of rosActions){
  ok(ros.includes(a+':[')||ros.includes(a+': ['),'RouterOS backend action missing: '+a);
  ok(web.includes("case'"+a+"'")||web.includes('case"'+a+'"')||web.includes(a+':[')||web.includes(a+': ['),'Web Bridge RouterOS action missing: '+a);
}

for(const s of [
  '/api/mobile/update','/api/mobile/apk','androidUpdate:true',
  "watchdogHost:process.env.CPE_WATCHDOG_HOST||'8.8.8.8'",
  "contact:snmpContact","identity:{deviceName:snmpLocation}",
  "calculateEirpLimit:false","automaticPowerControl:true"
])ok(server.includes(s),'backend invariant missing: '+s);

for(const s of ['system.eirp.status','radio.1.obey','radio.1.atpc.sta.status','resolv.host.1.name','snmp.location','pwdog.host'])
  ok(android.includes(s),'Android CPE policy missing: '+s);
for(const s of ['system.eirp.status','radio.1.obey','radio.1.atpc.sta.status','resolv.host.1.name','snmp.location','pwdog.host'])
  ok(web.includes(s),'Web Bridge CPE policy missing: '+s);

for(const [name,text] of [['server',server],['android',android],['web',web],['env',read('deploy/.env.example')]]){
  ok(!text.includes('CPE_VLAN_ID'),name+' still contains CPE_VLAN_ID');
  ok(!text.includes('${VLAN_ID}'),name+' still contains VLAN placeholder');
  ok(!text.includes('ath0.87'),name+' still contains legacy VLAN interface');
}

for(const s of ['autoNativePermissions','autoNativeUpdate','checkUpdate','installUpdate'])
  ok(app.includes(s)||android.includes(s),'updater/permissions missing: '+s);
for(const s of ['REQUEST_INSTALL_PACKAGES','FileProvider','provider_paths.xml','ANDROID_KEYSTORE_BASE64','assembleRelease'])
  ok(android.includes(s),'Android release invariant missing: '+s);
ok(compose.includes('ANDROID_RELEASE_DIR: /opt/cdanet/releases'),'release mount env missing');
ok(compose.includes('/opt/cdanet/releases:ro'),'release mount missing');

ok(sw.includes("url.pathname.startsWith('/api/')")&&sw.includes('fetch(req)'),'service worker must never cache API');
ok(server.includes("loginAttempts")&&server.includes("too_many_attempts"),'login rate limiting missing');

const forbidden=['CdaNet@CdaNet','CADsystem.it2007','wagqTppuS1H8Lf6owQt5qAzcUmDMZI5g6ApsxO2jz3TYlIob'];
for(const [name,text] of [['index',index],['app',app],['server',server],['android',android],['web',web],['tools',tools],['routeros',ros]]){
  for(const x of forbidden)ok(!text.includes(x),name+' contains forbidden legacy secret material');
}

if(fail.length){
  console.error('PROJECT VERIFY FAILED');
  for(const x of fail)console.error(' - '+x);
  process.exit(1);
}
console.log('PROJECT VERIFY OK: '+version+' · '+toolButtons.length+' UI modules · '+nativeActions.length+' native actions · '+rosActions.length+' RouterOS sections');
