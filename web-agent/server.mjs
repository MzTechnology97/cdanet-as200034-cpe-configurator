import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {Client as SshClient} from 'ssh2';
import snmp from 'net-snmp';

const execFileP=promisify(execFile);
const PORT=Number(process.env.CDA_WEB_BRIDGE_PORT||18990);
const ORIGIN=process.env.CDA_WEB_BRIDGE_ORIGIN||'*';
const TOKEN=process.env.CDA_WEB_BRIDGE_TOKEN||randomBytes(24).toString('hex');
const platform=process.platform;

console.log('CDA Net Web Bridge v0.5.0');
console.log('Listening on http://127.0.0.1:'+PORT);
console.log('Pairing token: '+TOKEN);
if(ORIGIN==='*')console.log('WARNING: CDA_WEB_BRIDGE_ORIGIN not set; CORS allows any origin but token is still required.');

function headers(origin=''){
  const allow=ORIGIN==='*'?'*':(origin===ORIGIN?origin:'null');
  return {
    'Access-Control-Allow-Origin':allow,
    'Access-Control-Allow-Headers':'Content-Type, X-CDA-Bridge-Token, Authorization',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Private-Network':'true',
    'Cache-Control':'no-store',
    'Content-Type':'application/json; charset=utf-8'
  };
}
function send(res,status,obj,origin=''){res.writeHead(status,headers(origin));res.end(JSON.stringify(obj))}
async function body(req,limit=1024*1024){
  let n=0,s='';for await(const c of req){n+=c.length;if(n>limit)throw new Error('payload_too_large');s+=c}
  return s?JSON.parse(s):{};
}
function run(cmd,args=[],timeout=8000){
  return execFileP(cmd,args,{timeout,maxBuffer:256*1024,windowsHide:true}).then(x=>String(x.stdout||x.stderr||''));
}
function ipToInt(ip){return ip.split('.').reduce((n,x)=>((n<<8)|(Number(x)&255))>>>0,0)>>>0}
function intToIp(n){return [n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.')}
function private4(ip){
  if(net.isIP(ip)!==4)return false;const n=ipToInt(ip);
  return (n>>>24)===10||((n>>>20)===0xAC1)||((n>>>16)===0xC0A8)||((n>>>22)===0x191)||((n>>>16)===0xA9FE)||((n>>>24)===127);
}
async function resolve4(host){if(net.isIP(host)===4)return host;return (await dns.lookup(host,{family:4})).address}
function cidrRange(cidr){
  const m=String(cidr||'').match(/^((?:\d{1,3}\.){3}\d{1,3})\/(\d|[12]\d|3[0-2])$/);if(!m||net.isIP(m[1])!==4)throw new Error('CIDR non valido');
  const p=Number(m[2]);if(p<24)throw new Error('Scansione limitata a /24 o reti più piccole');
  const mask=(0xffffffff<<(32-p))>>>0,base=(ipToInt(m[1])&mask)>>>0;if(!private4(intToIp(base)))throw new Error('Rete privata/CGNAT richiesta');
  return {first:base+1,last:(base|(~mask>>>0))-1};
}
async function ping(host){
  const ip=await resolve4(host),started=Date.now(),args=platform==='win32'?['-n','1','-w','1600',ip]:['-c','1','-W','2',ip];
  try{const out=await run('ping',args,3000),m=out.match(/(?:time[=<]|tempo[=<])\s*([0-9.,]+)\s*ms/i);return {host,ip,reachable:true,ms:m?Number(m[1].replace(',','.')):Date.now()-started}}
  catch{return {host,ip,reachable:false,ms:null}}
}
async function trace(host){
  const ip=await resolve4(host),cmd=platform==='win32'?'tracert':'traceroute',args=platform==='win32'?['-d','-h','20','-w','1000',ip]:['-n','-q','1','-w','1','-m','20',ip];
  let out='';try{out=await run(cmd,args,26000)}catch(e){out=String(e?.stdout||e?.stderr||'')}
  const hops=[];for(const line of out.split(/\r?\n/)){
    const m=line.match(/^\s*(\d+)\s+.*?((?:\d{1,3}\.){3}\d{1,3})(?:\s+|$)/);if(!m)continue;
    const ms=(line.match(/([0-9.,]+)\s*ms/i)||[])[1],hip=m[2];let hostname='';try{hostname=(await dns.reverse(hip))[0]||''}catch{}
    hops.push({hop:Number(m[1]),ip:hip,hostname,ms:ms?Number(ms.replace(',','.')):undefined,reached:hip===ip});
  }
  return {target:ip,hops,reached:hops.some(x=>x.reached)};
}
async function interfaces(){
  const out={addresses:[],dns:dns.getServers(),wifi:false,cellular:false,validated:true,source:'web-bridge'};
  for(const [name,vals] of Object.entries(os.networkInterfaces()))for(const v of vals||[])if(!v.internal&&v.family==='IPv4'){
    out.addresses.push(v.address+(v.cidr?'/'+String(v.cidr).split('/')[1]:''));
    if(!out.interface){out.interface=name;out.cidr=v.cidr||''}
  }
  try{
    if(platform==='win32'){
      const r=await run('route',['print','0.0.0.0'],3000),m=r.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+((?:\d{1,3}\.){3}\d{1,3})/m);if(m)out.gateway=m[1];
    }else{
      const r=await run('ip',['route','show','default'],3000),m=r.match(/default via\s+(\S+)/);if(m)out.gateway=m[1];
    }
  }catch{}
  return out;
}
async function wifiScan(){
  const networks=[];
  if(platform==='win32'){
    const out=await run('netsh',['wlan','show','networks','mode=bssid'],7000);
    let ssid='',bssid='';for(const line of out.split(/\r?\n/)){
      let m=line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/i);if(m){ssid=m[1].trim();continue}
      m=line.match(/^\s*BSSID\s+\d+\s*:\s*([0-9A-Fa-f:]{17})/);if(m){bssid=m[1];networks.push({ssid,bssid});continue}
      m=line.match(/^\s*(?:Signal|Segnale)\s*:\s*(\d+)%/i);if(m&&networks.length){const q=Number(m[1]);networks[networks.length-1].rssi=Math.round(q/2-100)}
      m=line.match(/^\s*(?:Channel|Canale)\s*:\s*(\d+)/i);if(m&&networks.length)networks[networks.length-1].channel=Number(m[1]);
    }
  }else{
    const out=await run('nmcli',['-t','-f','SSID,BSSID,SIGNAL,FREQ,CHAN','dev','wifi','list','--rescan','yes'],8000);
    for(const line of out.split(/\r?\n/)){if(!line)continue;const p=line.split(/(?<!\\):/).map(x=>x.replace(/\\:/g,':'));if(p.length<5)continue;networks.push({ssid:p[0],bssid:p[1],rssi:Math.round(Number(p[2])/2-100),frequencyMHz:Number(p[3]),channel:Number(p[4])})}
  }
  return {networks,source:'web-bridge'};
}
async function neighbors(){
  const xs=[];
  if(platform==='win32'){
    const out=await run('arp',['-a'],5000);for(const line of out.split(/\r?\n/)){const m=line.match(/^\s*((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-f-]{17})\s+/i);if(m)xs.push({ip:m[1],mac:m[2].replace(/-/g,':').toUpperCase(),interface:'ARP'})}
  }else{
    const out=await run('ip',['neigh','show'],5000);for(const line of out.split(/\r?\n/)){const m=line.match(/^((?:\d{1,3}\.){3}\d{1,3})\s+dev\s+(\S+)(?:\s+lladdr\s+([0-9a-f:]{17}))?/i);if(m)xs.push({ip:m[1],interface:m[2],mac:m[3]?.toUpperCase()||''})}
  }
  return {neighbors:xs,source:'web-bridge'};
}
async function discover(cidr){
  const r=cidrRange(cidr),ips=[];for(let n=r.first;n<=r.last&&ips.length<254;n++)ips.push(intToIp(n>>>0));
  let pos=0;const hosts=[];async function worker(){while(pos<ips.length){const ip=ips[pos++],p=await ping(ip);if(p.reachable){let hostname='';try{hostname=(await dns.reverse(ip))[0]||''}catch{}hosts.push({ip,hostname:hostname||ip,state:'online'})}}}
  await Promise.all(Array.from({length:Math.min(32,ips.length)},worker));const nb=await neighbors(),macs=new Map(nb.neighbors.map(x=>[x.ip,x.mac]));for(const h of hosts)if(macs.get(h.ip))h.mac=macs.get(h.ip);hosts.sort((a,b)=>ipToInt(a.ip)-ipToInt(b.ip));return {cidr,hosts,source:'web-bridge'};
}
function snmpGet(host,community,oids){
  return new Promise(async(resolve,reject)=>{const ip=await resolve4(host);if(!private4(ip))return reject(new Error('Host SNMP privato/CGNAT richiesto'));
    const session=snmp.createSession(ip,community,{timeout:1800,retries:0,version:snmp.Version2c});
    session.get(oids,(err,varbinds)=>{session.close();if(err)return reject(err);const vals={};for(const v of varbinds){if(snmp.isVarbindError(v))continue;vals[v.oid]=String(v.value)}resolve(vals)});
  });
}
async function snmpTool(host,community){
  const oids=['1.3.6.1.2.1.1.1.0','1.3.6.1.2.1.1.5.0','1.3.6.1.2.1.1.3.0'],v=await snmpGet(host,community,oids);
  return {host,sysDescr:v[oids[0]]||'—',sysName:v[oids[1]]||'—',sysUpTime:v[oids[2]]||'—',source:'web-bridge'};
}
async function cameraProbe(host,rtspPort=554){
  const ip=await resolve4(host);if(!private4(ip))throw new Error('Target privato/CGNAT richiesto');const ports=[80,443,Number(rtspPort),8000,8080,8899],open=[];
  await Promise.all(ports.map(port=>new Promise(done=>{const s=net.createConnection({host:ip,port,timeout:600},()=>{open.push(port);s.destroy();done()});s.on('timeout',()=>{s.destroy();done()});s.on('error',()=>done())})));
  return {host,ip,openPorts:[...new Set(open)].sort((a,b)=>a-b),reachable:open.length>0,source:'web-bridge'};
}
async function udpDiscovery(kind){
  const devices=[],seen=new Set(),sock=dgram.createSocket('udp4');
  return new Promise((resolve,reject)=>{sock.on('error',e=>{try{sock.close()}catch{}reject(e)});sock.on('message',(b,r)=>{if(seen.has(r.address))return;seen.add(r.address);const text=b.toString('utf8'),x={ip:r.address};for(const tag of ['DeviceDescription','DeviceSN','MAC','IPv4Address','HttpPort','SoftwareVersion']){const m=text.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>','i'));if(m)x[tag]=m[1]}const xa=(text.match(/<[^>]*XAddrs[^>]*>([^<]+)/i)||[])[1];if(xa)x.xaddrs=xa;devices.push(x)});
    sock.bind(()=>{if(kind==='onvif'){const xml='<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:'+randomUUID()+'</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws:2005:04:discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';sock.send(Buffer.from(xml),3702,'239.255.255.250')}else{sock.setBroadcast(true);sock.send(Buffer.from('<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>'+randomUUID()+'</Uuid><Types>inquiry</Types></Probe>'),37020,'255.255.255.255')}});
    setTimeout(()=>{try{sock.close()}catch{}resolve({protocol:kind==='onvif'?'ONVIF WS-Discovery':'Hikvision discovery',devices,count:devices.length,source:'web-bridge'})},3300);
  });
}
function openExternal(uri){
  if(platform==='win32')spawn('cmd',['/c','start','',uri],{detached:true,stdio:'ignore',windowsHide:true}).unref();
  else if(platform==='darwin')spawn('open',[uri],{detached:true,stdio:'ignore'}).unref();
  else spawn('xdg-open',[uri],{detached:true,stdio:'ignore'}).unref();
  return {opened:true,uri,source:'web-bridge'};
}
function sshConnect({host,port=22,username,password}){
  return new Promise((resolve,reject)=>{const c=new SshClient();c.on('ready',()=>resolve(c)).on('error',reject).connect({host,port,username,password,readyTimeout:7000,hostVerifier:()=>true})});
}
function sshExec(conn,cmd,timeout=10000){
  return new Promise((resolve,reject)=>{conn.exec(cmd,(err,stream)=>{if(err)return reject(err);let out='',errout='',done=false;const t=setTimeout(()=>{if(!done){done=true;stream.close();reject(new Error('Timeout comando CPE'))}},timeout);stream.on('data',d=>out+=d);stream.stderr.on('data',d=>errout+=d);stream.on('close',code=>{if(done)return;done=true;clearTimeout(t);if(code!==0)return reject(new Error('Comando CPE fallito ('+code+'): '+errout.trim()));resolve(out)})})});
}
function cfgValue(v){v=String(v??'');if(v.length>4096||/[\r\n\0]/.test(v))throw new Error('Valore configurazione non valido');return v}
function cfgSet(text,key,value){value=cfgValue(value);const line=key+'='+value,rows=String(text).split(/\r?\n/);let found=false;for(let i=0;i<rows.length;i++){if(rows[i].startsWith(key+'=')){rows[i]=line;found=true;}}if(!found)rows.push(line);return rows.join('\n').replace(/\n*$/,'')+'\n'}
function roRedact(s=''){return String(s).replace(/((?:password|passwd|secret|private-key|passphrase|shared-secret|authentication-key|encryption-key)\\s*[=:]\\s*)(?:"[^"]*"|'[^']*'|\\S+)/gi,'$1***REDACTED***').replace(/(password|secret)\\s*=\\s*[^\\s]+/gi,'$1=***REDACTED***')}
const RO_ACTIONS={
  quickset:[['/system identity print','Identità'],['/system resource print','Risorse'],['/ip address print detail without-paging','Indirizzi IP'],['/ip route print detail without-paging','Routing'],['/ip dhcp-server print detail without-paging','DHCP'],['/interface pppoe-client print detail without-paging','PPPoE'],['/interface wireless print detail without-paging','Wireless']],
  capsman:[['/caps-man manager print','CAPsMAN Manager'],['/caps-man interface print detail without-paging','CAPsMAN Interfaces'],['/caps-man registration-table print detail without-paging','CAPsMAN Registrazioni']],
  interfaces:[['/interface print detail without-paging','Interfaces']],
  wireless:[['/interface wireless print detail without-paging','Wireless v6'],['/interface wireless registration-table print detail without-paging','Registrazioni Wireless'],['/interface wifi print detail without-paging','WiFi RouterOS v7']],
  bridge:[['/interface bridge print detail without-paging','Bridge'],['/interface bridge port print detail without-paging','Bridge Ports'],['/interface bridge host print detail without-paging','Bridge Hosts']],
  ppp:[['/ppp active print detail without-paging','PPP Active'],['/interface pppoe-client print detail without-paging','PPPoE Client'],['/interface pppoe-server server print detail without-paging','PPPoE Server']],
  switch:[['/interface ethernet switch print detail without-paging','Switch'],['/interface ethernet switch port print detail without-paging','Switch Ports']],
  mesh:[['/interface mesh print detail without-paging','Mesh']],
  ip:[['/ip address print detail without-paging','IP Addresses'],['/ip arp print detail without-paging','ARP'],['/ip route print detail without-paging','IP Routes'],['/ip dhcp-server lease print detail without-paging','DHCP Leases'],['/ip firewall filter print stats detail without-paging','Firewall Filter'],['/ip firewall nat print stats detail without-paging','Firewall NAT'],['/ip service print detail without-paging','IP Services']],
  mpls:[['/mpls interface print detail without-paging','MPLS Interfaces'],['/mpls ldp neighbor print detail without-paging','LDP Neighbors'],['/mpls forwarding-table print detail without-paging','MPLS Forwarding']],
  routing:[['/routing bgp peer print detail without-paging','BGP Peers v6'],['/routing bgp session print detail without-paging','BGP Sessions v7'],['/routing ospf neighbor print detail without-paging','OSPF Neighbors'],['/routing ospf interface print detail without-paging','OSPF Interfaces']],
  system:[['/system identity print','Identity'],['/system resource print','Resources'],['/system routerboard print','RouterBOARD'],['/system clock print','Clock'],['/system package print without-paging','Packages']],
  queues:[['/queue simple print stats detail without-paging','Simple Queues'],['/queue tree print stats detail without-paging','Queue Tree']],
  files:[['/file print detail without-paging','Files']],
  log:[['/log print without-paging','Log']],
  radius:[['/radius print detail without-paging','RADIUS']],
  tools:[['/tool profile duration=2','Profiler'],['/tool bandwidth-server print','Bandwidth Server'],['/ip service print detail without-paging','Management Services']]
};
function roKv(text){const o={};for(const line of String(text).split(/\\r?\\n/)){const m=line.match(/^\\s*([A-Za-z0-9_.-]+)\\s*:\\s*(.*)$/);if(m)o[m[1]]=m[2].trim()}return o}
function roReadonly(cmd){const s=String(cmd||'').trim();if(!s.startsWith('/'))throw new Error('Il comando deve iniziare con /');if(s.length>300)throw new Error('Comando troppo lungo');if(/\\b(add|set|remove|unset|enable|disable|reset|reboot|shutdown|upgrade|install|uninstall|move|make-supout|export|backup|restore|fetch|upload|download|password|secret|user|certificate|script|scheduler)\\b/i.test(s))throw new Error('Terminale RouterOS in sola lettura');if(!/\\b(print|monitor|registration-table|profile|ping|traceroute)\\b/i.test(s))throw new Error('Sono ammessi solo comandi di lettura/diagnostica');return s}
async function roTry(conn,cmd){try{return roRedact(await sshExec(conn,cmd,9000))}catch(e){return '[non disponibile] '+roRedact(e.message||e)}}
async function routerOsAction(p){
  const host=String(p.host||''),port=Number(p.port||22),username=String(p.username||''),password=String(p.password||''),action=String(p.action||'dashboard');
  const ip=await resolve4(host);if(!private4(ip))throw new Error('Il Web Bridge RouterOS accetta solo target privati/CGNAT');if(!username||!password)throw new Error('Username e password RouterOS richiesti');
  const conn=await sshConnect({host:ip,port,username,password});
  try{
    const identity=await roTry(conn,'/system identity print'),resource=await roTry(conn,'/system resource print'),board=await roTry(conn,'/system routerboard print');
    const r=roKv(resource),b=roKv(board),id=roKv(identity),summary={identity:id.name||identity.replace(/^name:\\s*/i,'').trim(),version:r.version||'',uptime:r.uptime||'',boardName:r['board-name']||b.model||'',architecture:r['architecture-name']||'',cpu:r.cpu||'',cpuCount:r['cpu-count']||'',cpuFrequency:r['cpu-frequency']||'',cpuLoad:r['cpu-load']||'',freeMemory:r['free-memory']||'',totalMemory:r['total-memory']||'',freeHdd:r['free-hdd-space']||'',totalHdd:r['total-hdd-space']||'',factorySoftware:b['factory-software']||'',currentFirmware:b['current-firmware']||'',upgradeFirmware:b['upgrade-firmware']||''};
    if(action==='dashboard')return{host:ip,summary,sections:[],source:'routeros-web-bridge'};
    if(action==='supout'){const cmd='/system sup-output name=cda-supout.rif';let output='';try{output=roRedact(await sshExec(conn,cmd,65000))}catch(e){throw new Error('Supout.rif: '+(e.message||e))}const files=await roTry(conn,'/file print detail where name~"cda-supout"');return{host:ip,summary,sections:[{title:'Supout.rif',command:cmd,output:(output||'Generazione completata')+'\n\n'+files}],source:'routeros-web-bridge',note:'Il file diagnostico resta sul router e può contenere informazioni sensibili.'};}
    if(action==='terminal'){const cmd=roReadonly(p.command);return{host:ip,summary,sections:[{title:'Terminale RouterOS',command:cmd,output:await roTry(conn,cmd)}],source:'routeros-web-bridge'};}
    const defs=RO_ACTIONS[action];if(!defs)throw new Error('Modulo RouterOS non supportato');const sections=[];for(const [cmd,title] of defs)sections.push({title,command:cmd,output:await roTry(conn,cmd)});
    return{host:ip,summary,sections,source:'routeros-web-bridge'};
  }finally{conn.end()}
}
let pendingProvision=null;
async function fetchProvisionPackage({backendUrl,token,request}){
  if(!/^https?:\/\//i.test(backendUrl||''))throw new Error('Backend URL non valido');
  const br=new URL(backendUrl);if(br.protocol!=='https:'&&!private4((await resolve4(br.hostname))))throw new Error('Backend HTTP consentito solo su rete privata');
  const r=await fetch(backendUrl.replace(/\/$/,'')+'/api/mobile/provision-package',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'X-CDA-Client':'web-bridge-v0.5.0'},body:JSON.stringify(request)});
  const p=await r.json();if(!r.ok)throw new Error(p.error||('Backend HTTP '+r.status));if(new Date(p.expiresAt).getTime()<Date.now())throw new Error('Pacchetto provisioning scaduto');
  return p;
}
async function prepareProvision(args){
  pendingProvision=await fetchProvisionPackage(args);
  return {ok:true,prepared:true,expiresAt:pendingProvision.expiresAt,factoryIp:pendingProvision.factoryIp,targetFirmware:pendingProvision.targetFirmware,expectedDevice:pendingProvision.expectedDevice,source:'web-bridge',note:'Pacchetto tenuto solo in RAM. Ora puoi collegare il PC alla Wi-Fi management della CPE.'};
}
async function applyProvisionPackage(p){
  if(!p)throw new Error('Nessun provisioning preparato');
  if(new Date(p.expiresAt).getTime()<Date.now()){pendingProvision=null;throw new Error('Pacchetto provisioning scaduto: riconnetti Internet e preparalo di nuovo')}
  const host=p.factoryIp||'192.168.172.1';if(!private4(host))throw new Error('Target CPE non locale');
  const conn=await sshConnect({host,port:22,username:cfgValue(p.device.username),password:cfgValue(p.device.password)});
  try{
    const info=await sshExec(conn,'echo __VERSION__; (cat /etc/version 2>/dev/null || true); echo __BOARD__; (cat /etc/board.info 2>/dev/null || true); echo __SYSTEM__; (cat /proc/ubnthal/system.info 2>/dev/null || true)',6000);
    const fw=p.targetFirmware||'8.7.4';if(!info.includes(fw))throw new Error('Firmware diverso da '+fw);
    if(!p.boardMatch)throw new Error('Profilo privo di boardMatch');if(!(new RegExp(p.boardMatch,'is')).test(info))throw new Error('Board non compatibile col profilo');
    const expectedMac=String(p.expectedDevice?.mac||'').replace(/[^0-9a-f]/gi,'').toLowerCase();if(expectedMac){
      const ms=[...info.matchAll(/^(?:board\.hwaddr|eth0\.macaddr|serialno)=([0-9A-Fa-f:.-]+)$/gim)].map(x=>x[1].replace(/[^0-9a-f]/gi,'').toLowerCase());
      if(!ms.includes(expectedMac))throw new Error('MAC CPE diverso dal MAC atteso');
    }
    let cfg=String(p.profileTemplate||'');if(/^(?:vlan\.|ebtables\.sys\.vlan\.)/mi.test(cfg)||/^ppp\.\d+\.devname=ath0\.\d+/mi.test(cfg))throw new Error('Profilo VLAN legacy non consentito');const vars={
      '${SSID}':cfgValue(p.wireless.ssid),'${WPA2_PSK}':cfgValue(p.wireless.password),'${PPPOE_USER}':cfgValue(p.pppoe.username),'${PPPOE_PASSWORD}':cfgValue(p.pppoe.password),
      '${HTTP_PORT}':String(p.management?.httpPort||20080),'${HTTPS_PORT}':String(p.management?.httpsPort||20443),'${UISP_ENROLLMENT}':cfgValue(p.uispEnrollment||''),'${SNMP_COMMUNITY}':cfgValue(p.snmp?.community||p.snmpCommunity||'public'),'${SNMP_CONTACT}':cfgValue(p.snmp?.contact||'172.31.0.7'),'${SNMP_LOCATION}':cfgValue(p.snmp?.location||''),'${DEVICE_NAME}':cfgValue(p.identity?.deviceName||p.snmp?.location||''),
      '${CPE_USERNAME}':cfgValue(p.device.username),'${CPE_PASSWORD}':cfgValue(p.device.password),'${EXPECTED_MAC}':cfgValue(p.expectedDevice?.mac||''),'${EXPECTED_SERIAL}':cfgValue(p.expectedDevice?.serial||''),'${LAN_IP}':cfgValue(p.networkProfile?.lanIp||'192.168.1.254'),'${LAN_NETMASK}':cfgValue(p.networkProfile?.lanNetmask||'255.255.255.0'),
      '${DHCP_START}':cfgValue(p.networkProfile?.dhcpStart||'192.168.1.10'),'${DHCP_END}':cfgValue(p.networkProfile?.dhcpEnd||'192.168.1.50'),'${DHCP_LEASE}':String(p.networkProfile?.dhcpLease||600),
      '${PPPOE_MTU}':String(p.networkProfile?.pppoeMtu||1450),'${PPPOE_MRU}':String(p.networkProfile?.pppoeMru||1450),'${WATCHDOG_HOST}':cfgValue(p.networkProfile?.watchdogHost||'8.8.8.8'),
      '${NTP_SERVER}':cfgValue(p.networkProfile?.ntpServer||'10.0.0.254'),'${SSH_PORT}':String(p.networkProfile?.sshPort||22),'${DISCOVERY_PORT}':String(p.networkProfile?.discoveryPort||10001)
    };for(const [k,v] of Object.entries(vars))cfg=cfg.split(k).join(v);
    const deviceName=p.identity?.deviceName||p.snmp?.location||'';
    cfg=cfgSet(cfg,'pwdog.host',p.networkProfile?.watchdogHost||'8.8.8.8');
    cfg=cfgSet(cfg,'pwdog.status','enabled');
    cfg=cfgSet(cfg,'snmp.status','enabled');
    cfg=cfgSet(cfg,'snmp.community',p.snmp?.community||p.snmpCommunity||'public');
    cfg=cfgSet(cfg,'snmp.contact',p.snmp?.contact||'172.31.0.7');
    cfg=cfgSet(cfg,'snmp.location',p.snmp?.location||deviceName);
    cfg=cfgSet(cfg,'system.eirp.status','disabled');
    cfg=cfgSet(cfg,'radio.1.obey','disabled');
    cfg=cfgSet(cfg,'radio.1.atpc.sta.status','enabled');
    cfg=cfgSet(cfg,'resolv.host.1.name',deviceName);
    cfg=cfgSet(cfg,'resolv.host.1.status','enabled');
    if(/\$\{[A-Z0-9_]+\}/.test(cfg))throw new Error('Profilo contiene placeholder non valorizzati');if(!cfg.includes('system.cfg.version='))throw new Error('Profilo system.cfg non valido');
    const sha=createHash('sha256').update(p.profileTemplate||'').digest('hex');if(p.profileSha256&&sha!==p.profileSha256)throw new Error('Hash profilo non valido');
    await new Promise((resolve,reject)=>conn.sftp((err,sftp)=>{if(err)return reject(err);const w=sftp.createWriteStream('/tmp/system.cfg',{mode:0o600});w.on('error',reject);w.on('close',resolve);w.end(Buffer.from(cfg,'utf8'))}));
    await sshExec(conn,'cfgmtd -f /tmp/system.cfg -w -p /etc/ && sync',25000);try{await sshExec(conn,'reboot',2500)}catch{}
    pendingProvision=null;
    return {ok:true,host,stages:['SSH CPE verificato','Firmware '+fw+' verificato','Board e MAC verificati','system.cfg trasferito','Configurazione persistita con cfgmtd su /etc/','Riavvio CPE richiesto'],source:'web-bridge'};
  }finally{conn.end()}
}
async function applyPrepared(){return applyProvisionPackage(pendingProvision)}
async function tool(action,p){
  if(action==='interfaces'||action==='detectSubnet'||action==='gateway'||action==='dhcp'||action==='topology')return interfaces();
  if(action==='wifiScan')return wifiScan();
  if(action==='ping')return ping(p.host);
  if(action==='dns')return {host:p.host,addresses:(await dns.lookup(p.host,{all:true})).map(x=>x.address),source:'web-bridge'};
  if(action==='trace')return trace(p.host);
  if(action==='neighbors')return neighbors();
  if(action==='networkScan')return discover(p.cidr);
  if(action==='snmp')return snmpTool(p.host,p.community);
  if(action==='cameraProbe')return cameraProbe(p.host,p.rtspPort);
  if(action==='onvifDiscovery')return udpDiscovery('onvif');
  if(action==='hikDiscovery')return udpDiscovery('hik');
  if(action==='probeCpe')return cameraProbe('192.168.172.1',443);
  if(action==='openCpeSetup')return {opened:true,url:'http://192.168.172.1/',source:'web-bridge'};
  if(action==='openSsh')return openExternal('ssh://'+(p.username?encodeURIComponent(p.username)+'@':'')+p.host+':'+(p.port||22));
  if(action==='openRdp')return openExternal('rdp://'+p.host+':'+(p.port||3389));
  if(action==='openRtsp')return openExternal('rtsp://'+p.host+':'+(p.port||554)+(p.path||'/'));
  throw new Error('Azione bridge non supportata: '+action);
}
const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin||'';
  if(req.method==='OPTIONS'){res.writeHead(204,headers(origin));return res.end()}
  if(req.method==='GET'&&req.url==='/health')return send(res,200,{ok:true,service:'cda-net-web-bridge',version:'0.5.0',platform},origin);
  if(req.headers['x-cda-bridge-token']!==TOKEN)return send(res,401,{error:'bridge_unauthorized'},origin);
  try{
    if(req.method==='POST'&&req.url==='/provision/prepare')return send(res,200,await prepareProvision(await body(req,1024*1024)),origin);if(req.method==='POST'&&req.url==='/provision/apply')return send(res,200,await applyPrepared(),origin);if(req.method==='POST'&&req.url==='/routeros/action')return send(res,200,await routerOsAction(await body(req,1024*1024)),origin);
    const m=req.url.match(/^\/tool\/([A-Za-z0-9_-]+)$/);if(req.method==='POST'&&m)return send(res,200,await tool(m[1],await body(req)),origin);
    return send(res,404,{error:'not_found'},origin);
  }catch(e){return send(res,400,{error:e.message||String(e)},origin)}
});
server.listen(PORT,'127.0.0.1');
