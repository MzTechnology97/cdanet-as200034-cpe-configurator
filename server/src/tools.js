import express from 'express';
import dns from 'node:dns/promises';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';

const execFileP=promisify(execFile);
const MAX_OUTPUT=256*1024;
const hostRx=/^[A-Za-z0-9_.:-]{1,253}$/;
const macRx=/^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

function command(cmd,args=[],timeout=8000){
  return execFileP(cmd,args,{timeout,maxBuffer:MAX_OUTPUT,env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}})
    .then(({stdout='',stderr=''})=>String(stdout||stderr||''));
}
function ipToInt(ip){return ip.split('.').reduce((n,x)=>((n<<8)|(Number(x)&255))>>>0,0)>>>0}
function intToIp(n){return [n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.')}
function isPrivate4(ip){
  if(net.isIP(ip)!==4)return false;
  const n=ipToInt(ip);
  return (n>>>24)===10 ||
    ((n>>>20)===0xAC1) ||
    ((n>>>16)===0xC0A8) ||
    ((n>>>22)===0x191) ||
    ((n>>>16)===0xA9FE) ||
    ((n>>>24)===127);
}
async function resolve4(host){
  if(!hostRx.test(host))throw new Error('host_non_valido');
  if(net.isIP(host)===4)return host;
  const r=await dns.lookup(host,{family:4});
  return r.address;
}
function parseCidr(cidr){
  const m=String(cidr||'').match(/^((?:\d{1,3}\.){3}\d{1,3})\/(\d|[12]\d|3[0-2])$/);
  if(!m||net.isIP(m[1])!==4)throw new Error('cidr_non_valido');
  const p=Number(m[2]);if(p<24)throw new Error('cidr_troppo_ampio');
  const mask=p===0?0:(0xffffffff<<(32-p))>>>0;
  const base=(ipToInt(m[1])&mask)>>>0;
  if(!isPrivate4(intToIp(base)))throw new Error('rete_non_privata');
  return {prefix:p,base,first:base+1,last:(base|(~mask>>>0))-1};
}
async function reverseName(ip){
  try{const x=await Promise.race([dns.reverse(ip),new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),700))]);return x?.[0]||''}catch{return ''}
}
async function pingHost(host){
  const ip=await resolve4(host);
  const started=Date.now();
  try{
    const out=await command('ping',['-c','1','-W','2',ip],3500);
    const m=out.match(/time[=<]([0-9.]+)\s*ms/i);
    return {host,ip,reachable:true,ms:m?Number(m[1]):Date.now()-started,source:'backend'};
  }catch{return {host,ip,reachable:false,ms:null,source:'backend'}}
}
async function tracerouteHost(host){
  const ip=await resolve4(host);
  let out='';
  try{out=await command('traceroute',['-n','-q','1','-w','1','-m','20',ip],25000)}
  catch(e){out=String(e?.stdout||e?.stderr||'')}
  const hops=[];
  for(const line of out.split(/\r?\n/)){
    const m=line.match(/^\s*(\d+)\s+(?:(\d{1,3}(?:\.\d{1,3}){3})|\*)\s*(?:([0-9.]+)\s*ms)?/);
    if(!m)continue;
    const hop={hop:Number(m[1])};
    if(m[2]){hop.ip=m[2];hop.hostname=await reverseName(m[2]);if(m[3])hop.ms=Number(m[3]);hop.reached=m[2]===ip}
    else hop.timeout=true;
    hops.push(hop);
  }
  return {target:ip,hops,reached:hops.some(x=>x.reached),source:'backend',note:'Traceroute eseguito dal server CDA Net.'};
}
async function interfacesInfo(){
  const all=os.networkInterfaces(),addresses=[];let iface='',cidr='';
  for(const [name,vals] of Object.entries(all))for(const v of vals||[])if(!v.internal&&v.family==='IPv4'){
    addresses.push(v.address+(v.cidr?'/'+String(v.cidr).split('/')[1]:''));
    if(!iface){iface=name;cidr=v.cidr||''}
  }
  let gateway='';
  try{const r=await command('ip',['route','show','default'],2500);gateway=(r.match(/default via\s+(\S+)/)||[])[1]||''}catch{}
  return {interface:iface||'server',addresses,dns:dns.getServers(),gateway,cidr,wifi:false,cellular:false,validated:true,source:'backend',note:'Vista di rete del server CDA Net.'};
}
async function neighborList(){
  let out='';try{out=await command('ip',['neigh','show'],3000)}catch{}
  const neighbors=[];
  for(const line of out.split(/\r?\n/)){
    const m=line.match(/^((?:\d{1,3}\.){3}\d{1,3})\s+dev\s+(\S+)(?:\s+lladdr\s+([0-9a-f:]{17}))?.*?\s(FAILED|INCOMPLETE|STALE|REACHABLE|DELAY|PROBE|PERMANENT)?$/i);
    if(!m)continue;neighbors.push({ip:m[1],interface:m[2],mac:m[3]?.toUpperCase()||'',state:m[4]||'neighbor'});
  }
  return {neighbors,source:'backend',note:'Neighbor table vista dal server CDA Net.'};
}
async function discover(cidr){
  const {base,first,last}=parseCidr(cidr);
  const ips=[];for(let n=first;n<=last&&ips.length<254;n++)ips.push(intToIp(n>>>0));
  const hosts=[];let pos=0;
  async function worker(){
    while(pos<ips.length){
      const ip=ips[pos++];
      const p=await pingHost(ip);
      if(p.reachable){
        const hostname=await reverseName(ip);
        hosts.push({ip,hostname:hostname||ip,state:'online'});
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(32,ips.length)},worker));
  const neigh=await neighborList(),macs=new Map(neigh.neighbors.map(x=>[x.ip,x.mac]));
  for(const h of hosts)if(macs.get(h.ip))h.mac=macs.get(h.ip);
  hosts.sort((a,b)=>ipToInt(a.ip)-ipToInt(b.ip));
  return {cidr,hosts,source:'backend',note:'Scansione eseguita dalla rete del server CDA Net.'};
}
function berLen(buf,pos){
  let n=buf[pos.i++];if(n<128)return n;let bytes=n&127;if(bytes<1||bytes>3)throw new Error('ber_len');
  let len=0;while(bytes--)len=(len<<8)|buf[pos.i++];return len;
}
function tlv(tag,value){
  const v=Buffer.from(value);let l;
  if(v.length<128)l=Buffer.from([v.length]);else l=Buffer.from([0x82,(v.length>>8)&255,v.length&255]);
  return Buffer.concat([Buffer.from([tag]),l,v]);
}
function seq(v){return tlv(0x30,v)}
function oidBytes(oid){
  const a=oid.split('.').map(Number),parts=[a[0]*40+a[1]];
  for(const val0 of a.slice(2)){let val=val0,stack=[val&127];while((val>>=7)>0)stack.push((val&127)|128);parts.push(...stack.reverse())}
  return Buffer.from(parts);
}
async function snmpGet(host,community,oid){
  const ip=await resolve4(host);if(!isPrivate4(ip))throw new Error('snmp_target_non_privato');
  const ob=oidBytes(oid),vb=seq(Buffer.concat([tlv(0x06,ob),Buffer.from([5,0])])),
    pdu=tlv(0xA0,Buffer.concat([Buffer.from([2,4,0,0,0,1,2,1,0,2,1,0]),seq(vb)])),
    msg=seq(Buffer.concat([Buffer.from([2,1,1]),tlv(4,Buffer.from(community)),pdu]));
  return new Promise((resolve,reject)=>{
    const s=dgram.createSocket('udp4'),timer=setTimeout(()=>{s.close();reject(new Error('timeout'))},2500);
    s.once('error',e=>{clearTimeout(timer);s.close();reject(e)});
    s.once('message',r=>{clearTimeout(timer);s.close();try{
      for(let i=0;i<r.length-2;i++){if(r[i]!==0x06)continue;const p={i:i+1},l=berLen(r,p);if(l!==ob.length)continue;
        if(!r.subarray(p.i,p.i+l).equals(ob))continue;let q=p.i+l,tag=r[q++],lp={i:q},vl=berLen(r,lp),v=r.subarray(lp.i,lp.i+vl);
        if(tag===0x04)return resolve(v.toString('utf8').trim());
        if([0x02,0x41,0x42,0x43,0x46].includes(tag)){let n=0n;for(const b of v)n=(n<<8n)|BigInt(b);return resolve(tag===0x43?String(n)+' ticks':String(n))}
        if(tag===0x40&&v.length===4)return resolve([...v].join('.'));
        return resolve('0x'+v.toString('hex').toUpperCase());
      }
      reject(new Error('oid_non_presente'));
    }catch(e){reject(e)}});
    s.send(msg,161,ip);
  });
}
async function tcpProbe(host,ports){
  const ip=await resolve4(host);if(!isPrivate4(ip))throw new Error('target_non_privato');
  const open=[];
  await Promise.all(ports.map(port=>new Promise(done=>{
    const s=net.createConnection({host:ip,port,timeout:650},()=>{open.push(port);s.destroy();done()});
    s.on('timeout',()=>{s.destroy();done()});s.on('error',()=>done());
  })));
  return {host,ip,openPorts:open.sort((a,b)=>a-b),reachable:open.length>0,source:'backend'};
}
function nbQuery(){
  const q=Buffer.alloc(50);q[0]=0x43;q[1]=0x44;q[4]=0;q[5]=1;q[12]=32;
  for(let i=0;i<16;i++){const v=i===0?'*'.charCodeAt(0):32;q[13+i*2]=65+((v>>4)&15);q[14+i*2]=65+(v&15)}
  q[45]=0;q[46]=0;q[47]=0x21;q[48]=0;q[49]=1;return q;
}
async function netbios(host){
  const ip=await resolve4(host);if(!isPrivate4(ip))throw new Error('target_non_privato');
  return new Promise(resolve=>{
    const s=dgram.createSocket('udp4'),timer=setTimeout(()=>{s.close();resolve({host:ip,available:false,message:'Nessuna risposta NetBIOS/UDP 137',source:'backend'})},2000);
    s.once('message',buf=>{clearTimeout(timer);s.close();const names=[];for(let i=57;i+18<buf.length;i+=18){const n=buf.subarray(i,i+15).toString('ascii').trim();if(n&&!names.includes(n))names.push(n)}resolve({host:ip,available:true,netbiosNames:names,source:'backend'})});
    s.send(nbQuery(),137,ip);
  });
}
async function bgpView(resource){
  if(!/^(AS\d+|[0-9A-Fa-f:.]+(?:\/\d{1,3})?)$/.test(resource))throw new Error('risorsa_bgp_non_valida');
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),7000);
  try{
    const r=await fetch('https://stat.ripe.net/data/routing-status/data.json?resource='+encodeURIComponent(resource),{signal:ctl.signal,headers:{'User-Agent':'CDA-Net-CPE-Configurator/0.3'}});
    const j=await r.json();if(!r.ok)throw new Error('ripe_stat_http_'+r.status);
    return {resource,visibility:j?.data?.visibility,prefix:j?.data?.first_seen?j.data.resource:resource,origins:j?.data?.origins||[],lessSpecifics:j?.data?.less_specifics||[],source:'RIPEstat'};
  }finally{clearTimeout(timer)}
}
const vendorCache=new Map();
async function macVendor(mac){
  if(!macRx.test(mac))throw new Error('mac_non_valido');const norm=mac.replace(/-/g,':').toUpperCase();
  if(vendorCache.has(norm.slice(0,8)))return {mac:norm,vendor:vendorCache.get(norm.slice(0,8)),source:'backend-cache'};
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),5000);
  try{const r=await fetch('https://api.macvendors.com/'+encodeURIComponent(norm),{signal:ctl.signal});const vendor=r.ok?(await r.text()).trim():'Non trovato';vendorCache.set(norm.slice(0,8),vendor);return {mac:norm,vendor,source:'macvendors.com'}}
  catch{return {mac:norm,vendor:'Lookup non disponibile',source:'backend'}}
  finally{clearTimeout(timer)}
}
async function onvifDiscovery(){
  const xml='<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:'+randomUUID()+'</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws:2005:04:discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
  const devices=[],seen=new Set();return new Promise((resolve,reject)=>{const s=dgram.createSocket('udp4');s.bind(()=>{try{s.setMulticastTTL(2);s.send(Buffer.from(xml),3702,'239.255.255.250')}catch(e){s.close();reject(e)}});s.on('message',(b,r)=>{if(seen.has(r.address))return;seen.add(r.address);const body=b.toString('utf8'),xaddrs=(body.match(/<[^>]*XAddrs[^>]*>([^<]+)/i)||[])[1]||'';devices.push({ip:r.address,xaddrs})});s.on('error',reject);setTimeout(()=>{s.close();resolve({protocol:'ONVIF WS-Discovery',devices,count:devices.length,source:'backend',note:'Discovery dalla LAN del server CDA Net.'})},3200)})
}
async function hikDiscovery(){
  const payload='<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>'+randomUUID()+'</Uuid><Types>inquiry</Types></Probe>',devices=[],seen=new Set();
  return new Promise((resolve,reject)=>{const s=dgram.createSocket('udp4');s.bind(()=>{s.setBroadcast(true);s.send(Buffer.from(payload),37020,'255.255.255.255')});s.on('message',(b,r)=>{if(seen.has(r.address))return;seen.add(r.address);const body=b.toString('utf8'),x={ip:r.address};for(const tag of ['DeviceDescription','DeviceSN','MAC','IPv4Address','HttpPort','SoftwareVersion']){const m=body.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>','i'));if(m)x[tag]=m[1]}devices.push(x)});s.on('error',reject);setTimeout(()=>{s.close();resolve({protocol:'Hikvision discovery',devices,count:devices.length,source:'backend',note:'Discovery dalla LAN del server CDA Net.'})},3200)})
}

export function createToolsRouter(auth){
  const r=express.Router();r.use(auth);
  r.get('/interfaces',async(req,res)=>{try{res.json(await interfacesInfo())}catch(e){res.status(500).json({error:e.message})}});
  r.get('/neighbors',async(req,res)=>{try{res.json(await neighborList())}catch(e){res.status(500).json({error:e.message})}});
  r.post('/dns',async(req,res)=>{try{const host=String(req.body?.host||'');const xs=await dns.lookup(host,{all:true});res.json({host,addresses:xs.map(x=>x.address),source:'backend'})}catch(e){res.status(400).json({error:e.message})}});
  r.post('/ping',async(req,res)=>{try{res.json(await pingHost(String(req.body?.host||'')))}catch(e){res.status(400).json({error:e.message})}});
  r.post('/trace',async(req,res)=>{try{res.json(await tracerouteHost(String(req.body?.host||'')))}catch(e){res.status(400).json({error:e.message})}});
  r.post('/discover',async(req,res)=>{try{res.json(await discover(String(req.body?.cidr||'')))}catch(e){res.status(400).json({error:e.message})}});
  r.post('/netbios',async(req,res)=>{try{res.json(await netbios(String(req.body?.host||'')))}catch(e){res.status(400).json({error:e.message})}});
  r.post('/snmp',async(req,res)=>{try{const host=String(req.body?.host||''),community=String(req.body?.community||'');if(!community||community.length>64)throw new Error('community_non_valida');res.json({host,sysDescr:await snmpGet(host,community,'1.3.6.1.2.1.1.1.0'),sysName:await snmpGet(host,community,'1.3.6.1.2.1.1.5.0'),sysUpTime:await snmpGet(host,community,'1.3.6.1.2.1.1.3.0'),source:'backend',note:'Community usata solo per questa richiesta.'})}catch(e){res.status(400).json({error:e.message})}});
  r.post('/camera-probe',async(req,res)=>{try{const rtsp=Number(req.body?.rtspPort||554);res.json(await tcpProbe(String(req.body?.host||''),[80,443,rtsp,8000,8080,8899]))}catch(e){res.status(400).json({error:e.message})}});
  r.post('/onvif',async(req,res)=>{try{res.json(await onvifDiscovery())}catch(e){res.status(500).json({error:e.message})}});
  r.post('/hikvision',async(req,res)=>{try{res.json(await hikDiscovery())}catch(e){res.status(500).json({error:e.message})}});
  r.post('/bgp',async(req,res)=>{try{res.json(await bgpView(String(req.body?.resource||'')))}catch(e){res.status(400).json({error:e.message})}});
  r.post('/mac-vendor',async(req,res)=>{try{res.json(await macVendor(String(req.body?.mac||'')))}catch(e){res.status(400).json({error:e.message})}});
  r.post('/looking-glass',async(req,res)=>{try{const host=String(req.body?.host||'');res.json({host,ping:await pingHost(host),trace:await tracerouteHost(host),source:'backend',note:'Looking Glass eseguito dal server CDA Net.'})}catch(e){res.status(400).json({error:e.message})}});
  r.get('/speed/ping',(req,res)=>res.json({ok:true,ts:Date.now()}));
  r.get('/speed/download',(req,res)=>{const n=Math.min(25*1024*1024,Math.max(256*1024,Number(req.query.bytes)||8*1024*1024));res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',String(n));const chunk=Buffer.alloc(64*1024,0x5a);let left=n;while(left>0){const part=left>=chunk.length?chunk:chunk.subarray(0,left);res.write(part);left-=part.length}res.end()});
  r.post('/speed/upload',(req,res)=>{let bytes=0,done=false;req.on('data',c=>{bytes+=c.length;if(bytes>25*1024*1024&&!done){done=true;res.status(413).json({error:'payload_too_large'});req.destroy()}});req.on('end',()=>{if(!done)res.json({ok:true,bytes})})});
  return r;
}
