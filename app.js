'use strict';
const $ = (id) => document.getElementById(id);
const els = {form:$('configForm'),node:$('node'),district:$('district'),ssid:$('ssid'),plan:$('plan'),history:$('history')};

function fillSelect(el, from, to, pad=0){
  for(let n=from;n<=to;n++){
    const v=pad?String(n).padStart(pad,'0'):String(n);
    el.add(new Option(v,v));
  }
}
fillSelect(els.node,2,99);
fillSelect(els.district,1,99,2);

function currentSSID(){ return `CDA-NET-N${els.node.value}-D${els.district.value}`; }
function refreshPlan(){
  els.ssid.value=currentSSID();
  const user=$('pppoeUser').value.trim() || '—';
  els.plan.innerHTML=`<ol><li>Primo avvio: selezionare <b>Country Licensed</b>.</li><li>Applicare le credenziali dispositivo tramite il provisioning bridge protetto.</li><li>Associare la radio a <b>${escapeHtml(currentSSID())}</b>.</li><li>Impostare modalità router/PPPoE con username <b>${escapeHtml(user)}</b> e password transiente.</li><li>Dopo la connettività, applicare SNMP tramite secret server-side e verificarne l'esito.</li></ol>`;
}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
['change','input'].forEach(ev=>{els.form.addEventListener(ev,refreshPlan)});
$('preview').addEventListener('click',refreshPlan);

function loadHistory(){
  const rows=JSON.parse(localStorage.getItem('cda-cpe-history')||'[]');
  if(!rows.length){els.history.innerHTML='<p class="muted">Nessuna configurazione registrata su questo dispositivo.</p>';return;}
  els.history.innerHTML=rows.map(r=>`<article class="historyRow"><b>${escapeHtml(r.ssid)}</b><span>${escapeHtml(r.model)} · ${escapeHtml(r.mac)}</span><span>${escapeHtml(r.installer)} · ${new Date(r.at).toLocaleString('it-IT')}</span><small>PPPoE: ${escapeHtml(r.pppoeUser)} · password non salvata</small></article>`).join('');
}
els.form.addEventListener('submit',(e)=>{
  e.preventDefault();
  if(!els.form.reportValidity()) return;
  const row={at:new Date().toISOString(),installer:$('installer').value.trim(),model:$('model').value.trim(),mac:$('mac').value.trim(),serial:$('serial').value.trim(),ssid:currentSSID(),node:els.node.value,district:els.district.value,pppoeUser:$('pppoeUser').value.trim(),status:'planned'};
  const rows=JSON.parse(localStorage.getItem('cda-cpe-history')||'[]'); rows.unshift(row); localStorage.setItem('cda-cpe-history',JSON.stringify(rows.slice(0,100)));
  $('pppoePass').value=''; loadHistory(); alert('Piano registrato. Nessuna password è stata salvata.');
});
$('clearHistory').addEventListener('click',()=>{if(confirm('Cancellare lo storico locale?')){localStorage.removeItem('cda-cpe-history');loadHistory();}});
refreshPlan(); loadHistory();
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});