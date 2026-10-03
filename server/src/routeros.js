import express from 'express';
import net from 'node:net';
import dns from 'node:dns/promises';
import {Client as SshClient} from 'ssh2';

function ipToInt(ip){return ip.split('.').reduce((n,x)=>((n<<8)|(Number(x)&255))>>>0,0)>>>0}
function private4(ip){if(net.isIP(ip)!==4)return false;const n=ipToInt(ip);return (n>>>24)===10||((n>>>20)===0xAC1)||((n>>>16)===0xC0A8)||((n>>>22)===0x191)||((n>>>16)===0xA9FE)||((n>>>24)===127)}
async function resolveHost(host){if(net.isIP(host))return host;return (await dns.lookup(host)).address}
async function allowedHost(host){const ip=await resolveHost(host);if(net.isIP(ip)===6)return ip==='::1'||ip.toLowerCase().startsWith('fc')||ip.toLowerCase().startsWith('fd')||ip.toLowerCase().startsWith('fe80:');return private4(ip)||process.env.ROUTEROS_ALLOW_PUBLIC==='1'}
function cleanText(s=''){return String(s).replace(/((?:password|passwd|secret|private-key|passphrase|shared-secret|authentication-key|encryption-key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,'$1***REDACTED***').replace(/(password|secret)\s*=\s*[^\s]+/gi,'$1=***REDACTED***')}
function connect({host,port=22,username,password}){
  return new Promise((resolve,reject)=>{const c=new SshClient();c.on('ready',()=>resolve(c)).on('error',reject).connect({host,port,username,password,readyTimeout:7000,keepaliveInterval:4000,hostVerifier:()=>true})});
}
function exec(conn,cmd,timeout=9000){
  return new Promise((resolve,reject)=>{conn.exec(cmd,(err,stream)=>{if(err)return reject(err);let out='',errout='',done=false;const t=setTimeout(()=>{if(!done){done=true;try{stream.close()}catch{}reject(new Error('Timeout RouterOS'))}},timeout);stream.on('data',d=>out+=d);stream.stderr.on('data',d=>errout+=d);stream.on('close',code=>{if(done)return;done=true;clearTimeout(t);const text=cleanText(out||errout);if(code!==0&&text.trim())return reject(new Error(text.trim()));resolve(text.trim())})})});
}
async function tryExec(conn,cmd){try{return await exec(conn,cmd)}catch(e){return '[non disponibile] '+cleanText(e.message||e)}}
function kv(text){const o={};for(const line of String(text).split(/\r?\n/)){const m=line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);if(m)o[m[1]]=m[2].trim()}return o}
const ACTIONS={
  quickset:[
    ['/system identity print','Identità'],
    ['/system resource print','Risorse'],
    ['/ip address print detail without-paging','Indirizzi IP'],
    ['/ip route print detail without-paging','Routing'],
    ['/ip dhcp-server print detail without-paging','DHCP'],
    ['/interface pppoe-client print detail without-paging','PPPoE'],
    ['/interface wireless print detail without-paging','Wireless']
  ],
  capsman:[
    ['/caps-man manager print','CAPsMAN Manager'],
    ['/caps-man interface print detail without-paging','CAPsMAN Interfaces'],
    ['/caps-man registration-table print detail without-paging','CAPsMAN Registrazioni']
  ],
  interfaces:[['/interface print detail without-paging','Interfaces']],
  wireless:[
    ['/interface wireless print detail without-paging','Wireless v6'],
    ['/interface wireless registration-table print detail without-paging','Registrazioni Wireless'],
    ['/interface wifi print detail without-paging','WiFi RouterOS v7']
  ],
  bridge:[
    ['/interface bridge print detail without-paging','Bridge'],
    ['/interface bridge port print detail without-paging','Bridge Ports'],
    ['/interface bridge host print detail without-paging','Bridge Hosts']
  ],
  ppp:[
    ['/ppp active print detail without-paging','PPP Active'],
    ['/interface pppoe-client print detail without-paging','PPPoE Client'],
    ['/interface pppoe-server server print detail without-paging','PPPoE Server']
  ],
  switch:[
    ['/interface ethernet switch print detail without-paging','Switch'],
    ['/interface ethernet switch port print detail without-paging','Switch Ports']
  ],
  mesh:[['/interface mesh print detail without-paging','Mesh']],
  ip:[
    ['/ip address print detail without-paging','IP Addresses'],
    ['/ip arp print detail without-paging','ARP'],
    ['/ip route print detail without-paging','IP Routes'],
    ['/ip dhcp-server lease print detail without-paging','DHCP Leases'],
    ['/ip firewall filter print stats detail without-paging','Firewall Filter'],
    ['/ip firewall nat print stats detail without-paging','Firewall NAT'],
    ['/ip service print detail without-paging','IP Services']
  ],
  mpls:[
    ['/mpls interface print detail without-paging','MPLS Interfaces'],
    ['/mpls ldp neighbor print detail without-paging','LDP Neighbors'],
    ['/mpls forwarding-table print detail without-paging','MPLS Forwarding']
  ],
  routing:[
    ['/routing bgp peer print detail without-paging','BGP Peers v6'],
    ['/routing bgp session print detail without-paging','BGP Sessions v7'],
    ['/routing ospf neighbor print detail without-paging','OSPF Neighbors'],
    ['/routing ospf interface print detail without-paging','OSPF Interfaces']
  ],
  system:[
    ['/system identity print','Identity'],
    ['/system resource print','Resources'],
    ['/system routerboard print','RouterBOARD'],
    ['/system clock print','Clock'],
    ['/system package print without-paging','Packages']
  ],
  queues:[
    ['/queue simple print stats detail without-paging','Simple Queues'],
    ['/queue tree print stats detail without-paging','Queue Tree']
  ],
  files:[['/file print detail without-paging','Files']],
  log:[['/log print without-paging','Log']],
  radius:[['/radius print detail without-paging','RADIUS']],
  tools:[
    ['/tool profile duration=2','Profiler'],
    ['/tool bandwidth-server print','Bandwidth Server'],
    ['/ip service print detail without-paging','Management Services']
  ]
};
function readonlyCommand(cmd){
  const s=String(cmd||'').trim();
  if(!s.startsWith('/'))throw new Error('Il comando deve iniziare con /');
  if(s.length>300)throw new Error('Comando troppo lungo');
  const bad=/\b(add|set|remove|unset|enable|disable|reset|reboot|shutdown|upgrade|install|uninstall|move|make-supout|export|backup|restore|fetch|upload|download|password|secret|user|certificate|script|scheduler)\b/i;
  if(bad.test(s))throw new Error('Terminale v0.4.0 in sola lettura: comando di modifica bloccato');
  if(!/\b(print|monitor|registration-table|profile|ping|traceroute)\b/i.test(s))throw new Error('Sono ammessi solo comandi di lettura/diagnostica');
  return s;
}
async function snapshot(conn){
  const identity=await tryExec(conn,'/system identity print'),resource=await tryExec(conn,'/system resource print'),board=await tryExec(conn,'/system routerboard print');
  const r=kv(resource),b=kv(board),id=kv(identity);
  return {identity:id.name||identity.replace(/^name:\s*/i,'').trim(),version:r.version||'',uptime:r.uptime||'',boardName:r['board-name']||b.model||'',architecture:r['architecture-name']||'',cpu:r.cpu||'',cpuCount:r['cpu-count']||'',cpuFrequency:r['cpu-frequency']||'',cpuLoad:r['cpu-load']||'',freeMemory:r['free-memory']||'',totalMemory:r['total-memory']||'',freeHdd:r['free-hdd-space']||'',totalHdd:r['total-hdd-space']||'',factorySoftware:b['factory-software']||'',currentFirmware:b['current-firmware']||'',upgradeFirmware:b['upgrade-firmware']||''};
}
async function runAction(creds,action,command){
  const {host,port=22,username,password}=creds;
  if(!host||!username||password==null)throw new Error('Host, username e password RouterOS richiesti');
  if(!(await allowedHost(host)))throw new Error('Target RouterOS non consentito dal backend');
  const conn=await connect({host,port:Number(port)||22,username,password});
  try{
    const summary=await snapshot(conn);
    if(action==='dashboard')return {host,summary,sections:[],source:'routeros-backend'};
    if(action==='supout'){const cmd='/system sup-output name=cda-supout.rif';const output=cleanText(await exec(conn,cmd,65000));const files=await tryExec(conn,'/file print detail where name~"cda-supout"');return {host,summary,sections:[{title:'Supout.rif',command:cmd,output:(output||'Generazione completata')+'\n\n'+files}],source:'routeros-backend',note:'Il file diagnostico resta sul router e può contenere informazioni sensibili.'};}
    if(action==='terminal'){const cmd=readonlyCommand(command);return {host,summary,sections:[{title:'Terminale RouterOS',command:cmd,output:await tryExec(conn,cmd)}],source:'routeros-backend'};}
    const defs=ACTIONS[action];if(!defs)throw new Error('Modulo RouterOS non supportato');
    const sections=[];for(const [cmd,title] of defs)sections.push({title,command:cmd,output:await tryExec(conn,cmd)});
    return {host,summary,sections,source:'routeros-backend'};
  }finally{conn.end()}
}
export function createRouterOsRouter(auth){
  const r=express.Router();r.use(auth);
  r.post('/action',async(req,res)=>{try{const b=req.body||{};res.json(await runAction({host:String(b.host||''),port:Number(b.port||22),username:String(b.username||''),password:String(b.password||'')},String(b.action||'dashboard'),b.command))}catch(e){res.status(400).json({error:e.message||String(e)})}});
  return r;
}
