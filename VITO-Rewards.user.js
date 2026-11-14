// ==UserScript==
// @name         VITO Rewards Cloud
// @namespace    https://torn.com/vito-family-cloud/
// @version      3.4.7
// @description  Vito family tiers, rank-valued redeemable points, bazaar sale reconciliation, purchase-triggered inbox, thanked history, chat drafts and manually confirmed payouts.
// @author       Vito / NASHOR (based on ideas from Torn Bazaar Customer Thanker by KOKOT)
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// @connect      vito-rewards-api.thomasmarcheix87.workers.dev
// @updateURL    https://raw.githubusercontent.com/ThomasMarcheix/VITO-Rewards/main/VITO-Rewards.user.js
// @downloadURL  https://raw.githubusercontent.com/ThomasMarcheix/VITO-Rewards/main/VITO-Rewards.user.js
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const PREFIX = 'vitoRewards2_';
  const STORE = PREFIX + 'db';
  const API = PREFIX + 'api';
  const VERSION = 2;
  const MAX_CLAIM = 2_000_000;
  const POINT_USD = 10_000;
  const BANDS = [
    {min:0, max:50_000_000, rate:0.002, label:'🚶 Stranger'},
    {min:50_000_000, max:150_000_000, rate:0.005, label:'🏠 Resident'},
    {min:150_000_000, max:500_000_000, rate:0.0075, label:'⭐ Regular'},
    {min:500_000_000, max:Infinity, rate:0.01, label:'👑 Ambassador'}
  ];
  const nowSec = () => Math.floor(Date.now()/1000);
  const $ = (n) => '$' + Math.floor(n).toLocaleString('en-US');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cleanId = (x) => String(x ?? '').match(/^\d+$/)?.[0] || null;
  const int = x => Number.isFinite(Number(x)) ? Math.max(0, Math.floor(Number(x))) : 0;
  const dateText = x => x ? new Date(x).toLocaleString() : 'Never';
  const defaultTemplates = {
    subject:'🇮🇹 A little message from Don Vito!',
    greeting:'Ciao {name}! 🤌🇮🇹',
    message:'Grazie for shopping at VITO\'S BAZAAR! 💰\n\n🪙 VITO FAMILY REWARDS\n🏅 Rank: {rank}\n✨ Loyalty points: {points}\n🛍️ Lifetime purchases: {spent}\n💰 Available CASH PRIZE: {cashback}\n🎁 Next rank: {next_rank}\n📈 Still needed: {next_rank_remaining} ({next_rank_points} points)\n\n💵 To claim your cash prize, simply message me and ask for your Vito CASH PRIZE! You can claim up to $2,000,000 per request, up to your available balance. I will verify it and pay you manually.\n\n📝 Just bought something and I haven\'t sent you your points update yet? No problem! Message me anytime and ask for your VITO REWARDS account details. I\'ll tell you your rank, points and available cashback.\n\nThe family appreciates your loyalty! We break prices, not kneecaps. 😎',
    footer:'🤌 Don Vito — The family always pays its debts!'
  };
  function freshDB() {
    return {version:VERSION, startedAt:nowSec()-7*86400, lastSync:0, cursorTs:0, sales:{}, clients:{}, payouts:[], sent:{}, settings:{...defaultTemplates}, diagnostics:{skipped:0,logsRead:0,bazaarFound:0,pages:0}, lastError:''};
  }
  let db = GM_getValue(STORE, null);
  if (!db || db.version !== VERSION || !db.clients || !db.sales) {
    db = freshDB(); GM_setValue(STORE, db);
  }
  db.settings = {...defaultTemplates, ...(db.settings||{})};
  // Preserve all user-customized messages. Their {cashback} variable now reflects current rank.
  if(db.settings.message && db.settings.message.includes('✨ Total points: {points}') && !db.settings.message.includes('CASH PRIZE')) {
    db.settings.message=defaultTemplates.message; GM_setValue(STORE,db);
  }
  db.payouts ||= []; db.sent ||= {}; db.diagnostics ||= {skipped:0}; db.blacklist ||= {};
  // Cloud credentials are local-only Tampermonkey values, never stored in D1 or exported.
  const CLOUD_URL='https://vito-rewards-api.thomasmarcheix87.workers.dev';
  const CLOUD_TOKEN_KEY=PREFIX+'cloudAdminToken';
  let cloudToken=GM_getValue(CLOUD_TOKEN_KEY,'');
  let cloudReady=false, cloudBusy=false, cloudHasData=false;
  function cloudCall(path,method='GET',payload){
    if(!cloudToken) return Promise.reject(Error('Cloud admin token is not configured'));
    return new Promise((resolve,reject)=>GM_xmlhttpRequest({
      method,url:CLOUD_URL+path,timeout:30000,
      headers:{Authorization:'Bearer '+cloudToken,Accept:'application/json',...(payload?{'Content-Type':'application/json'}:{})},
      data:payload?JSON.stringify(payload):undefined,
      onload:r=>{let data;try{data=JSON.parse(r.responseText);}catch{reject(Error('Invalid Cloud response'));return;}
        if(r.status<200||r.status>=300||data.ok===false)reject(Error(data.error||'Cloud HTTP '+r.status));else resolve(data);},
      onerror:()=>reject(Error('Cloud unavailable')),ontimeout:()=>reject(Error('Cloud timeout'))
    }));
  }
  function ensureCloud(){
    if(!cloudToken)return true; // Legacy local mode is allowed until manually connected.
    if(!cloudReady){alert('Cloud not connected. Use Settings > Connect / Refresh first. No local change was made.');return false;}
    if(!cloudHasData){alert('Cloud database is empty. Import your JSON backup in Settings > Restore JSON before any modification.');return false;}
    return true;
  }
  async function cloudRefresh(){
    if(!cloudToken)return;
    if(cloudBusy)return;
    cloudBusy=true;
    try{
      const result=await cloudCall('/api/snapshot');
      const snap=result.db;
      cloudHasData=result.counts.sales>0;
      if(cloudHasData){db={...snap,settings:{...defaultTemplates,...snap.settings}};rebuild();save();renderAll();}
      // Do not overwrite the existing Tampermonkey ledger with an empty Cloud database.
      updateStatus('☁ Cloud connected · '+result.counts.clients+' customers · '+result.counts.sales+' sales'+(!cloudHasData?' · IMPORT BACKUP BEFORE SYNC':'') );
    }catch(e){cloudReady=false;updateStatus('☁ Cloud error: '+e.message);throw e;}
    finally{cloudBusy=false;}
    cloudReady=true;
  }
  const cloudAction=async (method,path,payload)=>{
    if(!ensureCloud())return false;
    if(!cloudToken)return true;
    try{await cloudCall(path,method,payload);await cloudRefresh();return true;}
    catch(e){alert('Cloud action failed: '+e.message);return false;}
  };
  const save = () => GM_setValue(STORE, db);

  const isBlacklisted = id => !!db.blacklist?.[String(id)];
  const tier = spent => BANDS.find(b => spent < b.max) || BANDS[BANDS.length-1];
  const nextTier = spent => BANDS.find(b => b.min > spent);
  // All unredeemed points are valued at the CURRENT rank at redemption time.
  // One point per $10,000 spent, with fractional points preserved using micro-points.
  // $1 spent = 100 micro-points; 10,000 USD = 1,000,000 micro-points.
  const MICRO = 1_000_000;
  const RATE_PER_POINT_CENTS = spent => Math.round(POINT_USD * tier(spent).rate * 100);
  const pointsMicro = spent => int(spent) * 100;
  const payoutPointsMicro = (cents, spent) =>
    Math.ceil((cents * MICRO) / RATE_PER_POINT_CENTS(spent));
  const pointsAvailableMicro = c => Math.max(0, pointsMicro(c.spent) - (c.paidPointsMicro||0) - (c.reservedPointsMicro||0));
  const availableCents = c => Math.floor(pointsAvailableMicro(c) * RATE_PER_POINT_CENTS(c.spent) / MICRO);
  const clientTemplate = (id, name='') => ({id,name,spent:0,items:0,sales:0,earnedCents:0,paidCents:0,reservedCents:0,paidPointsMicro:0,reservedPointsMicro:0,lastSale:0,latestSaleIds:[]});
  // Preserve an independent copy of the previous model before changing the ledger.
  if (db.rewardModel !== 'current-rank-points-v1') {
    if (!GM_getValue(PREFIX+'preRankMigrationBackup',null))
      GM_setValue(PREFIX+'preRankMigrationBackup',JSON.parse(JSON.stringify(db)));
    // Convert any old paid/pending request into a point obligation at migration.
    // Its originally agreed dollar amount never changes with a later rank.
    const historicalSpend={};
    for (const sale of Object.values(db.sales)) historicalSpend[sale.buyer]=(historicalSpend[sale.buyer]||0)+sale.amount;
    for (const p of db.payouts) {
      if (p.status !== 'paid' && p.status !== 'pending') continue;
      if (!Number.isSafeInteger(p.pointsMicro)) {
        p.pointsMicro=payoutPointsMicro(p.cents, historicalSpend[p.client]||0);
        p.migratedFromCashback=true;
      }
    }
    db.rewardModel='current-rank-points-v1';
    GM_setValue(STORE,db);
  }
  function rebuild() {
    const before = db.clients;
    const clients = {};
    const sales = Object.values(db.sales).sort((a,b)=>a.ts-b.ts || a.id.localeCompare(b.id));
    for (const sale of sales) {
      const id = sale.buyer;
      const prev = before[id];
      const c = clients[id] ||= {...clientTemplate(id, prev?.name||sale.name||''),profileImage:prev?.profileImage||''};
      c.spent += sale.amount;
      c.items += sale.qty;
      c.sales++;
      if(sale.ts > c.lastSale) { c.lastSale = sale.ts; c.latestSaleIds = [sale.id]; }
      else if(sale.ts === c.lastSale) c.latestSaleIds.push(sale.id);
      c.earnedCents = Math.floor(pointsMicro(c.spent) * RATE_PER_POINT_CENTS(c.spent) / MICRO);
    }
    for (const p of db.payouts) {
      const c = clients[p.client];
      if (!c) continue;
      if (p.status === 'paid') { c.paidCents += p.cents; c.paidPointsMicro += p.pointsMicro||0; }
      else if (p.status === 'pending') { c.reservedCents += p.cents; c.reservedPointsMicro += p.pointsMicro||0; }
    }
    db.clients = clients;
  }
  rebuild(); save();
  // Per-customer sale acknowledgement. A refresh, a new API scan or elapsed time
  // cannot enable Thank. Only a new, uniquely identified Bazaar sale can.
  // Legacy V2.7 acknowledgements were timestamps in milliseconds: retain them.
  function hasNewPurchase(c) {
    if(!c || !c.sales) return false;
    const marker=db.sent[c.id];
    if(!marker) return true; // Imported but not yet thanked.
    if(typeof marker==='number') return c.lastSale*1000 > marker;
    if(!Number.isFinite(marker.lastSaleTs)) return true;
    if(c.lastSale > marker.lastSaleTs) return true;
    if(c.lastSale < marker.lastSaleTs) return false;
    const acknowledged=new Set(Array.isArray(marker.idsAtTs)?marker.idsAtTs:[]);
    return (c.latestSaleIds||[]).some(id=>!acknowledged.has(id));
  }
  async function acknowledgePurchases(id) {
    if(!ensureCloud())return false;
    const c=db.clients[id];if(!c)return false;
    const marker={lastSaleTs:c.lastSale,idsAtTs:[...(c.latestSaleIds||[])],confirmedAt:Date.now()};
    if(cloudToken){return cloudAction('POST','/api/thank',{tornId:id,lastSaleTs:marker.lastSaleTs,idsAtTs:marker.idsAtTs});}
    db.sent[id]=marker;save();return true;
  }

  function accountInfoMessage(id) {
    const c=db.clients[id];const current=tier(c.spent);const next=nextTier(c.spent);
    const remaining=next?Math.max(0,next.min-c.spent):0;
    return `🇮🇹 Ciao ${c.name||'#'+id}! 🤌\n\nHere are your VITO FAMILY REWARDS account details:\n\n🏅 Rank: ${current.label}\n🪙 Points earned: ${Math.floor(c.spent/POINT_USD).toLocaleString('en-US')}\n💎 Point value at current rank: ${$(RATE_PER_POINT_CENTS(c.spent)/100)}\n🪙 Unredeemed points: ${(pointsAvailableMicro(c)/MICRO).toLocaleString('en-US',{maximumFractionDigits:2})}\n🛍️ Lifetime purchases: ${$(c.spent)}\n💰 Available cashback: ${$(Math.floor(availableCents(c)/100))}\n🎯 Next rank: ${next?next.label:'Highest rank reached'}\n📈 Remaining: ${next?$(remaining):'$0'}\n\n💵 Want to claim your Cash Prize? Just ask me! Up to $2,000,000 per request, subject to your available balance.\n\n📖 Full loyalty program details are displayed in VITO'S BAZAAR.\n\n🤌 Don Vito — The family thanks you!`;
  }
  function apiGet(url, apiKey) {
    return new Promise((resolve,reject) => GM_xmlhttpRequest({
      method:'GET', url, timeout:20000,
      headers:{Authorization:'ApiKey '+apiKey,Accept:'application/json'},
      onload:r=>{
        if (r.status < 200 || r.status >= 300) return reject(new Error('API HTTP '+r.status));
        try {const data = JSON.parse(r.responseText); if(data.error) throw Error(data.error.error||'API error'); resolve(data);}
        catch(e){reject(e);}
      },onerror:()=>reject(new Error('API connection failed')),
      ontimeout:()=>reject(new Error('API request timed out'))
    }));
  }
   // User images are public Torn profile data; only HTTPS URLs from Torn's image CDN
   // are accepted. No image bytes, credentials or API keys are sent to Cloudflare.
   const PROFILE_CHECKED_KEY=PREFIX+'profileCheckedV1';
   const PROFILE_REFRESH_MS=7*24*60*60*1000;
   let profileChecked=GM_getValue(PROFILE_CHECKED_KEY,{})||{};
   let profilesBusy=false;
   const profileAttemptsThisSession=new Set();
   function validProfileImage(value){
     if(typeof value!=='string'||value.length>500)return '';
     try{
       const u=new URL(value);
       if(u.protocol!=='https:'||u.username||u.password)return '';
       // Torn profile images are hosted on Torn-controlled domains.
       if(!(u.hostname==='torn.com'||u.hostname.endsWith('.torn.com')))return '';
       return u.href;
     }catch{return '';}
   }
   async function resolveProfiles(force=false){
     if(profilesBusy||syncBusy)return;
     const key=GM_getValue(API,'').trim();
     if(!key){updateStatus('Add a Torn API key in Settings to update profiles.');return;}
     if(cloudToken&&!cloudReady){updateStatus('Connect to Cloud before updating profiles.');return;}
     const due=Object.values(db.clients).filter(c=>!profileAttemptsThisSession.has(c.id)&&(
       !c.name||force||!profileChecked[c.id]||Date.now()-profileChecked[c.id]>PROFILE_REFRESH_MS));
     if(!due.length){updateStatus('Profiles are up to date (7-day cache).');return;}
     profilesBusy=true;
     let found=0,missing=0,failed=0,uploaded=0;
     try{
       for(let i=0;i<due.length;i++){
         const candidate=due[i],id=candidate.id;
         profileAttemptsThisSession.add(id);
         updateStatus(`Updating profiles: ${i+1}/${due.length} · ${found} avatars…`);
         try{
           const result=await apiGet(`https://api.torn.com/v2/user/${id}/profile`,key);
           const profile=result?.profile||{};
           const name=typeof profile.name==='string'&&profile.name.trim()&&profile.name.length<=80?profile.name.trim():'';
           const image=validProfileImage(profile.profile_image||profile.image||result?.profile_image);
           const live=db.clients[id];
           if(live){
             // Respect existing manually edited names.
             if(name&&!live.name)live.name=name;
             if(image)live.profileImage=image;
           }
           if(image)found++;else missing++;
           if(cloudReady&&(image||name)){
             try{
               await cloudCall('/api/profile','POST',{tornId:id,name:live?.name||name||'',profileImage:image});
               uploaded++;
             }catch(e){console.warn('[VITO] Could not save Cloud profile',id,e.message);failed++;}
           }
           profileChecked[id]=Date.now();
           GM_setValue(PROFILE_CHECKED_KEY,profileChecked);
         }catch(e){
           failed++;
           console.warn('[VITO] Profile lookup failed',id,e.message);
         }
         // Stay comfortably under the default Torn API limit.
         if(i<due.length-1)await new Promise(r=>setTimeout(r,1100));
       }
       if(cloudReady)await cloudRefresh();else{save();renderAll();}
       updateStatus(`Profiles: ${found} avatars found, ${missing} without avatar, ${failed} errors${cloudReady?' · '+uploaded+' uploaded':''}.`);
     }finally{profilesBusy=false;}
   }
   function queueNameLookup(){
     if(!profilesBusy&&Object.values(db.clients).some(c=>!c.name&&!profileAttemptsThisSession.has(c.id))){
       setTimeout(()=>{if(!syncBusy)resolveProfiles();},1000);
     }
   }
  function saleFromLog(log) {
    if (log?.details?.category !== 'Bazaars' || log?.details?.title !== 'Bazaar sell') return null;
    const buyer = cleanId(log?.data?.buyer);
    const amount = Number(log?.data?.cost_total);
    const ts = Number(log?.timestamp);
    const id = String(log?.id||'');
    if (!buyer || !id || !Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(ts)) return null;
    const qty = (Array.isArray(log.data.items) ? log.data.items : []).reduce((s,it)=>s+int(it.qty),0);
    return {id,buyer,amount,qty,ts};
  }
  let syncBusy = false;
  async function syncSales() {
    if(syncBusy) return;
    const key=GM_getValue(API,'').trim();
    if(!key) {alert('Enter an API key with access to your user/log first.'); return;}
    syncBusy=true; updateStatus('Syncing sales…');
    // 24h overlap and unique sale IDs guard against reruns and delays.
    const since=Math.max(db.startedAt, db.cursorTs ? db.cursorTs-86400 : db.startedAt);
    let url=`https://api.torn.com/v2/user/log?limit=100&sort=DESC&from=${since}`;
    let pages=0, added=0, maxTs=db.cursorTs, skipped=0, logsRead=0, bazaarFound=0;
    let previousOldest=Infinity;
    const pending={};
    const visited=new Set();
    try {
      while(url) {
        if(!url.startsWith('https://api.torn.com/v2/user/log')) throw Error('Unexpected API pagination URL');
        if(visited.has(url)) throw Error('Repeated API pagination link');
        visited.add(url);
        if(pages>0) await new Promise(r=>setTimeout(r,750)); // stay below API rate limit
        if(++pages>300) throw Error('More than 300 log pages. Sync stopped safely; retry later.');
        updateStatus(`Reading page ${pages}… (${added} new sales)`);
        const fetchUrl=new URL(url); fetchUrl.searchParams.set('timestamp', String(nowSec()));
        const data=await apiGet(fetchUrl.href,key);
        const logs=Array.isArray(data.log) ? data.log : [];
        logsRead += logs.length;
        for(const log of logs) {
          if(log?.timestamp > maxTs) maxTs=log.timestamp;
          if(log?.timestamp < db.startedAt) continue;
          if(log?.details?.category==='Bazaars' && log?.details?.title==='Bazaar sell') {
            bazaarFound++;
            const sale=saleFromLog(log);
            if(sale && !db.sales[sale.id] && !pending[sale.id]) {pending[sale.id]=sale;added++;}
            else if(!sale) skipped++;
          }
        }
        // Torn sometimes omits _metadata.links.next even when it returns 100 logs.
        // Fall back to an inclusive "to" timestamp. Overlapping log IDs are
        // deduplicated, and progress is checked to avoid skipping dense seconds.
        const next=data._metadata?.links?.next || data._metadata?.next || null;
        const oldest=logs.length ? Math.min(...logs.map(l=>Number(l.timestamp))) : 0;
        if (logs.length && (!Number.isFinite(oldest) || oldest <= 0)) {
          throw Error('Invalid timestamp in API logs. No sales saved.');
        }
        if (!logs.length || oldest < since) {
          url=null;
        } else if (next) {
          const nextUrl=new URL(next, 'https://api.torn.com');
          if(nextUrl.origin !== 'https://api.torn.com' || !nextUrl.pathname.startsWith('/v2/user/log')) throw Error('Untrusted API pagination link');
          url=nextUrl.href;
        } else if (logs.length === 100) {
          if (oldest >= previousOldest) {
            throw Error('API pagination cannot progress within the same second; no data saved. Try a restricted Bazaars log API key.');
          }
          previousOldest=oldest;
          // Inclusive bound to include ALL log entries with the boundary second,
          // where fewer than 100 of them occur in a single second.
          url=`https://api.torn.com/v2/user/log?limit=100&sort=DESC&from=${since}&to=${oldest}`;
        } else {
          url=null;
        }
      }
      if(cloudToken){
        if(!cloudReady)throw Error('Cloud disconnected. Connect in Settings first.');
        if(!cloudHasData)throw Error('Cloud is empty: import your existing JSON backup first, before syncing new sales.');
        const incoming=Object.values(pending);
        for(let i=0;i<incoming.length;i+=60)await cloudCall('/api/sales','POST',{sales:incoming.slice(i,i+60)});
        await cloudCall('/api/meta','POST',{cursorTs:maxTs,lastSync:Date.now()});
        await cloudRefresh();
        updateStatus('☁ Sales synced: '+incoming.length+' new unique sales');
        queueNameLookup();
        return;
      }
      Object.assign(db.sales,pending);
      db.cursorTs=maxTs;
      db.lastSync=Date.now(); db.lastError='';
      db.diagnostics={...db.diagnostics,skipped:(db.diagnostics.skipped||0)+skipped,logsRead,bazaarFound,pages};
      rebuild();save();
      updateStatus(`Read ${logsRead} logs: ${bazaarFound} Bazaar sells · +${added} recorded${skipped?' · '+skipped+' invalid':''}`);
      renderAll();
      queueNameLookup();
    } catch(e){db.lastError=String(e.message||e); save(); updateStatus('Sync failed: '+db.lastError);console.error('[VITO]',e);}
    finally {syncBusy=false;}
  }
  function sendTemplate(id) {
    const c=db.clients[id];
    if(!c) return;
    const rank=tier(c.spent), next=nextTier(c.spent);
    const needed=next?Math.max(0,next.min-c.spent):0;
    const vars={name:c.name||'#'+id,rank:rank.label,points:Math.floor(c.spent/POINT_USD).toLocaleString('en-US'),spent:$(c.spent),cashback:$(Math.floor(availableCents(c)/100)),next_rank:next?`${next.label} at ${$(next.min)}`:'Highest rank reached',next_rank_remaining:next?$(needed):'0 $',next_rank_points:next?Math.ceil(needed/POINT_USD).toLocaleString('en-US'):'0'};
    const sub=s=>String(s||'').replace(/\{(name|rank|points|spent|cashback|next_rank|next_rank_remaining|next_rank_points)\}/gi,(_,v)=>vars[v.toLowerCase()]);
    return {subject:sub(db.settings.subject),body:[db.settings.greeting,db.settings.message,db.settings.footer].map(sub).join('\n\n')};
  }
  // Open the native Torn chat from the Vito client list, never send a message.
  // Tampermonkey's isolated world can make CustomEvent.detail inaccessible to Torn.
  // Use the page window and clone the detail for Firefox when supported.
  let chatDraft=null;
  const chatInputSelector='textarea[placeholder*="Type your message"],textarea[aria-label*="chat" i]';
  const chatInputs=()=>[...document.querySelectorAll(chatInputSelector)].filter(t=>t.offsetParent!==null);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const sameCustomer=(node, id, nickname)=>{
    const text=(node?.textContent||'').toLowerCase();
    return (!!nickname && text.includes(nickname.toLowerCase())) ||
      !!node?.querySelector?.(`a[href*="XID=${id}"],a[href*="ID=${id}"]`);
  };
  function targetChatInput(draft){
    const inputs=chatInputs();
    if(inputs.length===0)return null;
    // Favor a newly mounted chat field over an old, already open conversation.
    const added=inputs.filter(t=>!draft.beforeInputs.has(t));
    if(added.length===1)return added[0];
    if(added.length>1)return null;
    // If the chat was already open, only accept a field with an identifiable recipient.
    const identified=inputs.filter(t=>{
      let n=t;
      for(let i=0;n&&i<6;i++,n=n.parentElement){
        if(sameCustomer(n,draft.id,draft.nickname))return true;
      }
      return false;
    });
    return identified.length===1?identified[0]:null;
  }
  async function fillChatDraft(){
    const draft=chatDraft;
    if(!draft)return;
    if(Date.now()>draft.expires){
      chatDraft=null;
      updateStatus('Chat was not ready. Use Open chat again, or paste the copied message.');
      return;
    }
    if(!draft.ready)return;
    const t=targetChatInput(draft);
    if(!t)return;
    // Never overwrite existing text, or an unknown customer's conversation.
    if(t.value.trim()){
      updateStatus('The chat field already contains a message. Paste the copied Vito text manually.');
      chatDraft=null;
      return;
    }
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
    if(setter)setter.call(t,draft.body);else t.value=draft.body;
    t.dispatchEvent(new Event('input',{bubbles:true}));
    t.focus();
    updateStatus('Draft prepared. VERIFY the recipient before manually pressing Send.');
    chatDraft=null;
  }
  function dispatchTornChatEvent(id,nickname){
    const page=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
    const detail={userId:String(id),nickname:nickname||'#'+id,sourceElementId:'vr-toggle'};
    // In Firefox, details must be exported into the page compartment.
    const exposed=typeof cloneInto==='function'&&page!==window?cloneInto(detail,page):detail;
    page.dispatchEvent(new page.CustomEvent('chat.openChannel',{detail:exposed}));
  }
  async function openChatForCustomer(id,body){
    id=String(id);
    const c=db.clients[id];if(!c)return;
    const nickname=String(c.name||'').trim();
    chatDraft={id,nickname,body,expires:Date.now()+12000,ready:false,beforeInputs:new Set(chatInputs())};
    try{
      dispatchTornChatEvent(id,nickname);
      updateStatus('Opening chat for '+(nickname||'#'+id)+'…');
    }catch(error){
      chatDraft=null;
      updateStatus('Torn chat event failed: '+String(error?.message||error)+'. Message copied as fallback.');
      return;
    }
    // Torn creates its chat UI asynchronously; do not assume a fixed 900ms delay.
    await sleep(250);
    if(chatDraft?.id===id)chatDraft.ready=true;
    await sleep(5500);
    if(chatDraft?.id===id){
      updateStatus('Chat may not have opened, or recipient could not be verified. Message copied: paste it in the correct chat manually.');
    }
  }
  // A code may be sent on demand, even after the latest purchase was thanked.
  // Cloud only: never fabricate client secrets or send them to the wrong account.
  async function getClientAccess(id) {
    try {
      return await cloudCall('/api/client-access/for-thank', 'POST', {tornId:id});
    } catch (error) {
      const message=String(error?.message||error);
      // Legacy access codes were hashed but not stored recoverably.
      // Rotation is explicit because it invalidates any previously issued code.
      if (/legacy access code cannot be recovered|rotate it manually/i.test(message)) {
        if (!confirm('This customer has an older access code that cannot be recovered.\n\nGenerate a NEW code? Their previous code will STOP working.')) throw new Error('Access-code rotation cancelled.');
        return await cloudCall('/api/client-access/issue', 'POST', {tornId:id});
      }
      throw error;
    }
  }
  const FAMILY_URL = CLOUD_URL + '/family';
  function customerCashAvailable(c) {
    // Same rank-based redemption model as the site. Wheel prizes are bonus
    // points: they increase the redeemable balance, never lifetime spending.
    const bonusMicro = Math.max(0, Number(c.bonusMicro) || 0);
    const micro = Math.max(0, pointsMicro(c.spent) + bonusMicro -
      (Number(c.paidPointsMicro) || 0) - (Number(c.reservedPointsMicro) || 0));
    return Math.floor(micro * RATE_PER_POINT_CENTS(c.spent) / MICRO / 100);
  }
  function shortFamilyMessage(c, code, accessOnly=false) {
    const rank=tier(c.spent);
    const cleanRank=rank.label.replace(/^\S+\s+/, '');
    const cashbackRate=(rank.rate*100).toLocaleString('en-US',{maximumFractionDigits:2});
    const name=String(c.name||'#'+c.id);
    const points=Math.floor(c.spent/POINT_USD).toLocaleString('en-US');
    const cash=$(customerCashAvailable(c));
    const familyLink='<a href="'+FAMILY_URL+'">Open your Casa Vito account</a>';
    return `🇮🇹 <b>BENVENUTO, ${name.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}!</b> 🤌

${accessOnly?'Welcome to the family!':'Thanks for shopping at <b>VITO\'S BAZAAR!</b>'}

🏅 <b>Rank:</b> ${cleanRank} (${cashbackRate}% cashback)
🪙 <b>Points:</b> ${points}
🛍️ <b>Spent:</b> ${$(c.spent)}
💰 <b>Cash available:</b> ${cash}

🔐 <b>YOUR FAMILY ACCESS</b>
${familyLink}
<b>Code:</b> ${code}

🎰 Weekly wheel • Rewards • Cashback

🤌 <b>Don Vito — La famiglia non dimentica.</b>`;
  }
  async function compose(id, accountOnly=false, accessOnly=false) {
    const c=db.clients[id]; if(!c) return;
    if(isBlacklisted(id) && !accountOnly) return alert('This customer is blacklisted. Unblock them in the Blacklist tab before sending a thank-you.');
    if(!accountOnly && !accessOnly && !hasNewPurchase(c)) {
      alert('Already thanked for the recorded purchases. Sync sales after a new purchase to unlock Thank. Use Account Info to reply anytime.');
      return;
    }
    let body;
    if(accountOnly && !accessOnly) {
      body=accountInfoMessage(id);
    } else {
      // Never create a thank-you with a missing or invented access code.
      if(!cloudToken || !cloudReady) {
        alert('Connect to Casa Vito Cloud in Settings before creating a message containing a private access code.');
        return;
      }
      try {
        const access=await getClientAccess(id);
        if(!access?.code || typeof access.code !== 'string') throw Error('Cloud did not provide a valid access code');
        body=shortFamilyMessage(c, access.code, accessOnly);
      } catch(e) {
        alert('Could not prepare the private access code: '+e.message+'\nNo message was marked as sent.');
        return;
      }
    }
    const popup=document.createElement('div');popup.className='vr-overlay';
    const modeLabel=accessOnly?'Send Access':(accountOnly?'Account Info':'Thank');
    popup.innerHTML=`<div class="vr-dialog"><h3>💬 Vito ${modeLabel} — ${escapeHtml(c.name||'#'+id)}</h3><label>Chat message (editable)</label><textarea id="vr-body" rows="14">${escapeHtml(body)}</textarea><p class="vr-muted">${accessOnly?'Send this private code only to the correct customer. This does NOT change their Thanked status.':(accountOnly?'Account Info is always available and does not acknowledge purchases.':'After actually sending this thank-you, confirm it below. The Thank button unlocks only after a new Bazaar purchase is imported.')} Chat opens in Torn; review and press Send manually.</p><div class="vr-actions"><button id="vr-open">💬 Open chat directly</button><button id="vr-copy">📋 Copy text</button><button id="vr-sent">${accountOnly?'✓ Done':'✓ I sent it'}</button><button id="vr-close">Cancel</button></div></div>`;
    document.body.appendChild(popup);
    const acknowledge=async()=>{
      if(!accountOnly) {
        if(!confirm('Did you actually SEND this thank-you chat to the correct customer?')) return false;
        if(!(await acknowledgePurchases(id)))return false;
      }
      return true;
    };
    popup.querySelector('#vr-close').onclick=()=>{chatDraft=null;popup.remove();};
    popup.querySelector('#vr-copy').onclick=async()=>{const text=popup.querySelector('#vr-body').value;try{await navigator.clipboard.writeText(text);updateStatus('Chat text copied');}catch{prompt('Copy this message:',text);}};
    popup.querySelector('#vr-open').onclick=async()=>{
      const text=popup.querySelector('#vr-body').value;
      try{await navigator.clipboard.writeText(text);}catch{}
      popup.remove();openChatForCustomer(id,text);
      document.querySelector('#vr-chat-confirm')?.remove();
      const bar=document.createElement('div');bar.id='vr-chat-confirm';
      bar.style.cssText='position:fixed;bottom:115px;right:20px;z-index:2147483601;background:#20283a;border:1px solid #dcb368;color:white;padding:12px;border-radius:10px;max-width:310px;font:13px Arial;box-shadow:0 4px 18px #0008';
      const label=document.createElement('div');label.textContent='💬 Vito '+modeLabel+' for '+(c.name||'#'+id);bar.appendChild(label);
      const yes=document.createElement('button');yes.textContent=accountOnly?'✓ Done':'✓ I sent it';yes.style.cssText='margin:8px 6px 0 0;padding:7px;background:#385f47;color:white;border:1px solid #83bd91;border-radius:5px';
      yes.onclick=async()=>{if(!(await acknowledge()))return;chatDraft=null;bar.remove();renderAll();};
      const no=document.createElement('button');no.textContent='Dismiss';no.style.cssText='padding:7px;background:#3d4455;color:white;border:1px solid #79849a;border-radius:5px';
      no.onclick=()=>{chatDraft=null;bar.remove();};bar.append(yes,no);document.body.appendChild(bar);
    };
    popup.querySelector('#vr-sent').onclick=async()=>{if(!(await acknowledge()))return;chatDraft=null;popup.remove();renderAll();};
  }
  
  async function claim(id) {
    if (!ensureCloud()) return;
  
    if (isBlacklisted(id)) {
      return alert('Blacklisted customer.');
    }
  
    const c = db.clients[id];
    if (!c) return;
  
    const available = Math.floor(availableCents(c) / 100);
    const amount = Math.min(available, 2_000_000);
  
    if (amount < 1) {
      return alert('No cashback available.');
    }
  
    try {
      await navigator.clipboard.writeText(String(amount));
      updateStatus('Copied payout amount: $' + amount.toLocaleString('en-US'));
    } catch {
      prompt('Copy this payout amount:', String(amount));
    }
  
    window.open(
      'https://www.torn.com/profiles.php?XID=' +
        encodeURIComponent(id),
      '_blank',
      'noopener'
    );
  }

  function payRequest(requestId) {
    const p=db.payouts.find(x=>x.id===requestId && x.status==='pending');
    if(!p)return alert('This payout is no longer pending.');
    if(isBlacklisted(p.client))return alert('Blacklisted customer. Review this case before making any payout.');
    const c=db.clients[p.client];
    const amount=Math.floor(p.cents/100);
    if(amount<1||amount>MAX_CLAIM)return alert('Invalid payout amount.');
    const info=`Pay ${c?.name||'#'+p.client} [${p.client}]\nAmount: ${$(amount)}\n\nOn Torn, verify player ID and amount, manually send cash, then come back to Vito > Payouts and click Paid in Torn.`;
    try {navigator.clipboard?.writeText(`${p.client} | ${amount}`);}catch{}
    if(!confirm(info+'\n\nOpen Torn Send Cash now?'))return;
    // We do not submit transfer or fill Torn payment fields.
    window.open('https://www.torn.com/sendcash.php','_blank','noopener');
  }
  async function payClient(id) {
    if(isBlacklisted(id))return alert('Blacklisted customer. Review the Blacklist tab before processing a payout.');
    const c=db.clients[id];if(!c)return;
    const pending=db.payouts.filter(p=>p.client===id&&p.status==='pending');
    if(pending.length===1)return payRequest(pending[0].id);
    if(pending.length>1){activeTab='payouts';renderAll();return alert('Several pending payouts: choose Pay now on the exact request.');}
    if(!(await claim(id)))return;
    const created=db.payouts.filter(p=>p.client===id&&p.status==='pending').at(-1);
    if(created) payRequest(created.id);
  }
  async function settle(id,status) {
    if(!ensureCloud())return;
    const p=db.payouts.find(x=>x.id===id);
    if(!p||p.status!=='pending')return;
    const message=status==='paid'?'Confirm YOU ALREADY SENT the Torn cash to this player?':'Cancel and release this reserved request?';
    if(!confirm(message))return;
    if(cloudToken){await cloudAction('POST','/api/payouts/'+encodeURIComponent(id)+'/'+(status==='paid'?'pay':'cancel'));return;}
    p.status=status;p.paidAt=status==='paid'?Date.now():0;
    rebuild();save();renderAll();
  }
  const styles=`
    #vr-root{position:fixed;top:82px;right:16px;z-index:999999;color:#e8eaf0;font:14px Arial,sans-serif}
    #vr-root *,.vr-overlay *{box-sizing:border-box}
    #vr-toggle{background:#a96c15;color:#fff;border:2px solid #e8bc61;border-radius:50px;padding:12px 16px;font-weight:bold;cursor:pointer;box-shadow:0 4px 20px #0009}
    #vr-panel{display:none;position:absolute;top:54px;right:0;width:min(480px,96vw);max-height:min(78vh,calc(100vh - 150px));overflow:auto;background:#171b27;color:#e8eaf0;border:1px solid #b99455;border-radius:14px;padding:16px;box-shadow:0 8px 30px #000c}
    #vr-panel h2{color:#ffd37a;margin:0 0 6px;font-size:21px}#vr-panel h3{color:#ffda93;margin:16px 0 6px;font-size:15px}
    #vr-panel label,.vr-overlay label{display:block;margin:8px 0 3px;color:#cad0de}
    #vr-panel input,#vr-panel textarea,.vr-overlay input,.vr-overlay textarea{width:100%;padding:8px;background:#0e1220;border:1px solid #515c77;border-radius:6px;color:#fff;font-size:13px}
    #vr-panel button,.vr-overlay button{background:#354365;color:#fff;border:1px solid #6d7ca5;border-radius:6px;padding:7px 9px;margin:3px;cursor:pointer;font-size:12px}
    #vr-panel button:hover,.vr-overlay button:hover{background:#556d9a}
    .vr-muted{color:#a9b3c6;font-size:12px;line-height:1.4}.vr-tabs{display:flex;gap:4px;flex-wrap:wrap;margin:12px 0}.vr-tabs button{flex:1}
    .vr-card{background:#252c3a;border-radius:9px;padding:10px;margin:9px 0}.vr-card b{color:#ffd37a}
    .vr-row{display:flex;align-items:center;justify-content:space-between;gap:5px;flex-wrap:wrap}
    .vr-small{font-size:12px;color:#b4bdcf}.vr-green{color:#80e3a2}.vr-red{color:#ff9797}
    .vr-overlay{position:fixed;inset:0;z-index:2147483600;background:#000b;display:flex;align-items:center;justify-content:center;color:#eee;font:14px Arial}
    .vr-dialog{background:#1a1d2b;border:1px solid #e3b262;border-radius:14px;padding:20px;width:min(600px,96vw);max-height:94vh;overflow:auto}
    .vr-dialog h3{color:#ffda93;margin-top:0}.vr-dialog textarea{white-space:pre-wrap}.vr-actions{display:flex;flex-wrap:wrap}
    .vr-event-btn{margin-left:8px!important;padding:2px 7px!important;font-size:11px!important;cursor:pointer}
    .vr-blacklisted{border:1px solid #a84747!important}
    @media(max-width:700px){#vr-root{top:68px;right:8px}#vr-toggle{padding:9px 12px}#vr-panel{top:47px;max-height:calc(100vh - 125px);width:min(480px,calc(100vw - 16px))}}
  `;
  const sheet=document.createElement('style'); sheet.textContent=styles; document.head.appendChild(sheet);
  const root=document.createElement('div');root.id='vr-root';
  root.innerHTML='<button id="vr-toggle">🇮🇹 Vito Rewards</button><div id="vr-panel"><h2>🇮🇹 VITO FAMILY REWARDS</h2><div id="vr-status" class="vr-muted">Ready</div><div class="vr-tabs"><button data-tab="clients">📨 To Thank <span id="vr-count-new"></span></button><button data-tab="thanked">✅ Thanked <span id="vr-count-thanked"></span></button><button data-tab="payouts">💸 Payouts</button><button data-tab="blacklist">🚫 Blacklist</button><button data-tab="settings">⚙ Settings</button></div><div id="vr-content"></div></div>';
  document.body.appendChild(root);
  let activeTab='clients';
  const panel=root.querySelector('#vr-panel');
  root.querySelector('#vr-toggle').onclick=()=>{panel.style.display=panel.style.display==='block'?'none':'block';if(panel.style.display==='block')renderAll();};
  root.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>{activeTab=el.dataset.tab;renderAll();});
  function updateStatus(t){const el=root.querySelector('#vr-status');if(el)el.textContent=t;}
  // Two views of one ledger. A thank-you acknowledgement is never a deletion:
  // when a new sale arrives, hasNewPurchase immediately moves the client back.
  function clientsInTab(tab) {
    return Object.values(db.clients)
      .filter(c=>!isBlacklisted(c.id) && (tab==='clients' ? hasNewPurchase(c) : !hasNewPurchase(c)))
      .sort((a,b)=>b.lastSale-a.lastSale || b.spent-a.spent);
  }
  function renderClients() {
    const awaiting=clientsInTab('clients').length;
    const thanked=clientsInTab('thanked').length;
    const list=clientsInTab(activeTab);
    const ledgerClients=Object.values(db.clients);
    const outstanding=ledgerClients.reduce((s,c)=>s+availableCents(c)+c.reservedCents,0);
    const intro=activeTab==='clients'
      ? 'Customers with purchases not yet acknowledged. After confirming a Thank message, they move to Thanked. A newly imported sale brings them back here.'
      : 'Customers whose latest recorded purchases were thanked. A newly imported purchase moves them back to To Thank automatically.';
    return `<div class="vr-card"><b>${awaiting} to thank · ${thanked} thanked</b> · ${Object.keys(db.blacklist).length} blacklisted · ${Object.keys(db.sales).length} sales<br><span class="vr-small">${intro}</span><br><span class="vr-small">Total outstanding at current ranks: ${$(Math.floor(outstanding/100))} (including reserved requests)</span><br><span class="vr-small">Loyalty start: ${escapeHtml(dateText(db.startedAt*1000))} · Last sync: ${escapeHtml(dateText(db.lastSync))}</span><br><span class="vr-small">Last API scan: ${db.diagnostics.logsRead||0} logs, ${db.diagnostics.bazaarFound||0} Bazaar sales found</span></div>
       <div><button id="vr-sync">🔄 Sync sales</button><button id="vr-export">⬇ Backup JSON</button><button id="vr-names">👤 Update profiles & avatars</button>${Object.keys(db.clients).length===0?'<button id="vr-history">📜 Import last 7 days</button>':''}</div>
       <label>Find customer</label><input id="vr-search" placeholder="Name or Torn ID">
       <div id="vr-list">${clientRows(list)}</div>`;
  }
  function clientRows(list) {
    if(!list.length)return '<div class="vr-muted">'+(activeTab==='clients'?'All customers have been thanked for their latest purchases. Sync sales to detect new buyers.':'No thanked customers yet. Confirm a thank-you to move a customer here.')+'</div>';
    return list.slice(0,250).map(c=>{
      const next=nextTier(c.spent),available=Math.floor(availableCents(c)/100);
      const newSale=hasNewPurchase(c);
      const avatar=validProfileImage(c.profileImage);
       return `<div class="vr-card"><div class="vr-row"><span style="display:flex;align-items:center;gap:9px">${avatar?`<img src="${escapeHtml(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:38px;height:38px;object-fit:cover;border-radius:50%;background:#111827">`:''}<b>${escapeHtml(c.name||'#'+c.id)}</b></span><span>${tier(c.spent).label}</span></div>
      <div class="vr-small">ID ${c.id} · ${c.sales} sales · ${c.items} items</div>
      <div>Spent: <b>${$(c.spent)}</b> · Points earned: <b>${Math.floor(c.spent/POINT_USD).toLocaleString('en-US')}</b></div>
      <div class="vr-small">Unredeemed points: ${(pointsAvailableMicro(c)/MICRO).toLocaleString('en-US',{maximumFractionDigits:2})} · Value / point: ${$(RATE_PER_POINT_CENTS(c.spent)/100)}</div>
      <div class="vr-green">Cash prize at current rank: <b>${$(available)}</b></div>
      <div class="vr-small">${next?`Next rank: ${next.label} — ${$(next.min-c.spent)} / ${Math.ceil((next.min-c.spent)/POINT_USD).toLocaleString('en-US')} points to go`:'Top rank'} · Pending: ${$(Math.floor(c.reservedCents/100))}</div>
      <button data-compose="${c.id}" ${newSale?'':'disabled title="Already thanked; waiting for a new purchase"'}>💬 ${newSale?'Thank':'✓ Thanked'}</button>
      <button data-account="${c.id}">📋 Account Info</button><button data-access="${c.id}">🔑 Send Access</button>
      <button data-claim="${c.id}">💸 Request payout</button>
      <button data-name="${c.id}">✏️ Name</button><button data-blacklist="${c.id}">🚫 Blacklist</button></div>`;
    }).join('');
  }
  function renderBlacklist() {
    const entries=Object.entries(db.blacklist).sort((a,b)=>(b[1]?.addedAt||0)-(a[1]?.addedAt||0));
    return `<div class="vr-card"><b>🚫 Blacklisted players: ${entries.length}</b><p class="vr-muted">Personal do-not-trade list. This does not block players in Torn or delete their purchases, points or cashback. Thank-you and payout initiation are paused while a player is on this list.</p>
      <label>Player ID (Torn)</label><input id="vr-block-id" inputmode="numeric" placeholder="e.g. 1234567">
      <label>Reason (optional)</label><input id="vr-block-reason" maxlength="200" placeholder="e.g. Buy-mug after a Xanax purchase">
      <button id="vr-add-block">🚫 Add to blacklist</button></div>
      <label>Search blacklist</label><input id="vr-block-search" placeholder="Name, ID or reason">
      <div id="vr-block-list">${blacklistRows(entries)}</div>`;
  }
  function blacklistRows(entries){
    if(!entries.length)return '<div class="vr-muted">No players blacklisted.</div>';
    return entries.map(([id,entry])=>{
      const c=db.clients[id];
      const name=c?.name||entry.name||'#'+id;
      return `<div class="vr-card vr-blacklisted"><div class="vr-row"><b>${escapeHtml(name)}</b><span class="vr-red">🚫 Blocked</span></div>
        <div class="vr-small">ID ${escapeHtml(id)} · Added ${escapeHtml(dateText(entry.addedAt))}</div>
        <div>Reason: ${escapeHtml(entry.reason||'Not specified')}</div>
        ${c?`<div class="vr-small">Historic purchases: ${$(c.spent)} · Cashback ledger preserved: ${$(Math.floor(availableCents(c)/100))}</div>`:''}
        <button data-unblock="${escapeHtml(id)}">✅ Remove from blacklist</button>
        ${c?`<button data-account="${escapeHtml(id)}">📋 Account Info</button>`:''}
      </div>`;
    }).join('');
  }
  async function addBlacklist(id,reason){
    if(!ensureCloud())return;
    id=cleanId(id);
    if(!id)return alert('Enter a valid numeric Torn player ID.');
    if(isBlacklisted(id))return alert('Player is already blacklisted.');
    if(cloudToken){await cloudAction('POST','/api/blacklist',{tornId:id,name:db.clients[id]?.name||'',reason:String(reason||'').trim().slice(0,200)});return;}
    db.blacklist[id]={addedAt:Date.now(),reason:String(reason||'').trim().slice(0,200),name:db.clients[id]?.name||''};
    save();renderAll();updateStatus('Player #'+id+' added to the blacklist.');
  }
  async function removeBlacklist(id){
    if(!ensureCloud())return;
    if(!isBlacklisted(id))return;
    if(!confirm('Remove player #'+id+' from your Vito blacklist?'))return;
    if(cloudToken){await cloudAction('DELETE','/api/blacklist/'+id);return;}
    delete db.blacklist[id];save();renderAll();updateStatus('Player #'+id+' removed from blacklist.');
  }
  function renderPayouts() {
    const data=[...db.payouts].sort((a,b)=>b.createdAt-a.createdAt);
    return `<div class="vr-muted">A request reserves a balance. You manually send cash in Torn, then confirm payment here. $2,000,000 max per request.</div>`+
      (data.length?data.slice(0,200).map(p=>{
        const c=db.clients[p.client];return `<div class="vr-card"><b>${escapeHtml(c?.name||'#'+p.client)}</b> — ${$(p.cents/100)}<br><span class="vr-small">${escapeHtml(p.status)} · ${escapeHtml(dateText(p.createdAt))}</span><br>${p.status==='pending'?`<button data-pay="${p.id}">💵 Pay now</button><button data-settle="${p.id}" data-status="paid">✓ Paid in Torn</button><button data-settle="${p.id}" data-status="cancelled">Cancel</button>`:''}</div>`;
      }).join(''):'<p>No payout requests yet.</p>');
  }
  function renderSettings() {
    return `<div class="vr-muted">Unredeemed points are ALWAYS valued using the customer's current rank, including points earned at lower ranks. Any claimed payout fixes its dollar amount and consumes the corresponding points. Only Bazaar sales from the loyalty start date are counted. On a fresh install this defaults to the last 7 days. Historical sales become cashback obligations if included.</div>
      <div class="vr-card"><b>☁ Cloud Sync</b><p class="vr-muted">Shared D1 ledger on PC + Android. Keep the ADMIN_TOKEN ONLY in Tampermonkey. The old script must be disabled.</p>
      <label>Cloud ADMIN_TOKEN (stored on THIS device only)</label><input id="vr-cloud-token" type="password" autocomplete="off" placeholder="Paste your existing Cloudflare ADMIN_TOKEN">
      <button id="vr-cloud-connect">☁ Save token & connect</button><button id="vr-cloud-refresh">↻ Refresh Cloud</button><button id="vr-cloud-remove">Disconnect Cloud</button>
      <p class="vr-muted">First connection to a new, empty D1: use Restore JSON below to upload the original backup. Do not Sync Sales before importing.</p></div>
      <label>Loyalty start (local time)</label><input type="datetime-local" id="vr-start" value="${new Date((db.startedAt*1000)-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}">
      <div class="vr-muted">Changing the start requires a fresh ledger. Export a backup first. The reset button clears customer points and payouts, and requires confirmation.</div>
      <button id="vr-reset-start">Set start date & RESET ledger</button>
      <label>API key (custom key with user/log access recommended)</label><input type="password" id="vr-key" placeholder="Saved locally in Tampermonkey" autocomplete="off">
      <button id="vr-keysave">Save API key</button>
      <button id="vr-sync">🔄 Sync sales</button><button id="vr-export">⬇ Backup JSON</button><button id="vr-import">⬆ Restore JSON</button><button id="vr-prev-backup">⬇ Pre-migration backup</button>
      <label>Optional subject (not used in chat). Variables: {name}, {rank}, {points}, {spent}, {cashback}, {next_rank}, {next_rank_remaining}, {next_rank_points}</label><input id="vr-s" value="${escapeHtml(db.settings.subject)}">
      <label>Greeting</label><textarea id="vr-g" rows="2">${escapeHtml(db.settings.greeting)}</textarea>
      <label>Message</label><textarea id="vr-m" rows="10">${escapeHtml(db.settings.message)}</textarea>
      <label>Footer</label><textarea id="vr-f" rows="2">${escapeHtml(db.settings.footer)}</textarea>
      <button id="vr-templates">Save templates</button><div class="vr-muted">Private chat only. Thank becomes available after a new Bazaar sale is synced. Account Info always works. No chat or cash is sent automatically.</div>
      ${db.lastError?`<p class="vr-red">Last error: ${escapeHtml(db.lastError)}</p>`:''}`;
  }
  function importSevenDays() {
    if(Object.keys(db.sales).length || db.payouts.length) return alert('Existing ledger detected. Use Settings to change the loyalty start date safely.');
    if(!confirm('Import Bazaar sales from the LAST 7 DAYS and award loyalty points retroactively? Only continue if you intend to honor these rewards.')) return;
    db.startedAt=nowSec()-7*86400;
    db.cursorTs=0; db.lastSync=0;db.lastError='';db.diagnostics={skipped:0,logsRead:0,bazaarFound:0,pages:0};
    save();renderAll();syncSales();
  }
  function exportData() {
    const blob=new Blob([JSON.stringify(db,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='vito-rewards-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  function importData() {
    const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
    input.onchange=()=>{const f=input.files?.[0];if(!f)return;const reader=new FileReader();reader.onload=async()=>{
      try{const obj=JSON.parse(String(reader.result));if(obj.version!==VERSION || !obj.sales || typeof obj.sales!=='object' || !Array.isArray(obj.payouts))throw Error('Wrong VITO backup format');
        if(cloudToken){
          if(!cloudReady)return alert('Connect to Cloud first.');
          if(!confirm('Import this ORIGINAL JSON into EMPTY Cloud D1? Existing Cloud sales/payouts cannot be overwritten.'))return;
          try{const result=await cloudCall('/api/import','POST',obj);await cloudRefresh();alert('Cloud import completed: '+result.clients+' clients, '+result.sales+' sales, '+result.blacklist+' blacklisted.');}
          catch(e){alert('Cloud import refused: '+e.message);}
          return;
        }
        if(!confirm('Replace ALL current Vito Rewards ledger data with this backup?'))return;
        db=obj;db.blacklist ||= {};db.settings={...defaultTemplates,...db.settings};
        if(db.rewardModel!=='current-rank-points-v1'){
          const spentBy={};for(const sale of Object.values(db.sales))spentBy[sale.buyer]=(spentBy[sale.buyer]||0)+sale.amount;
          for(const p of db.payouts){if((p.status==='paid'||p.status==='pending')&&!Number.isSafeInteger(p.pointsMicro)){p.pointsMicro=payoutPointsMicro(p.cents,spentBy[p.client]||0);p.migratedFromCashback=true;}}
          db.rewardModel='current-rank-points-v1';
        }
        rebuild();save();renderAll();
      }catch(e){alert('Restore failed: '+e.message);}
    };reader.readAsText(f);};input.click();
  }
  function bindPanel() {
    const el=root.querySelector('#vr-content');
    el.querySelectorAll('#vr-sync').forEach(x=>x.onclick=syncSales);
    const namesBtn=el.querySelector('#vr-names');if(namesBtn)namesBtn.onclick=()=>{profileAttemptsThisSession.clear();resolveProfiles(true);};
    const historyBtn=el.querySelector('#vr-history');if(historyBtn)historyBtn.onclick=importSevenDays;
    el.querySelectorAll('#vr-export').forEach(x=>x.onclick=exportData);
    const importBtn=el.querySelector('#vr-import');if(importBtn)importBtn.onclick=importData;
    const connect=el.querySelector('#vr-cloud-connect');if(connect)connect.onclick=async()=>{
      const token=el.querySelector('#vr-cloud-token').value.trim();
      if(token.length<32)return alert('Cloud ADMIN_TOKEN must be at least 32 characters.');
      cloudToken=token;GM_setValue(CLOUD_TOKEN_KEY,token);
      try{await cloudRefresh();alert('Connected to VITO Rewards Cloud! '+(!cloudHasData?'Now import your JSON backup via Restore JSON.':''));}
      catch(e){alert('Connection failed: '+e.message+' — check token, Worker deployment and D1 binding.');}
    };
    const refresh=el.querySelector('#vr-cloud-refresh');if(refresh)refresh.onclick=()=>cloudRefresh().catch(e=>alert(e.message));
    const disconnect=el.querySelector('#vr-cloud-remove');if(disconnect)disconnect.onclick=()=>{
      if(!confirm('Disconnect this device from Cloud? Local cached data will remain, but changes will no longer sync.'))return;
      cloudToken='';cloudReady=false;GM_setValue(CLOUD_TOKEN_KEY,'');updateStatus('Cloud disconnected');renderAll();
    };
    const oldBtn=el.querySelector('#vr-prev-backup');if(oldBtn)oldBtn.onclick=()=>{
      const snapshot=GM_getValue(PREFIX+'preRankMigrationBackup',null);if(!snapshot)return alert('No pre-migration backup stored.');
      const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='vito-before-rank-redemption.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    };
    el.querySelectorAll('[data-blacklist]').forEach(x=>x.onclick=()=>{
      const id=x.dataset.blacklist;
      const reason=prompt('Why blacklist '+(db.clients[id]?.name||'#'+id)+'? (Optional; cancel to abort)','Buy-mug');
      if(reason!==null)addBlacklist(id,reason);
    });
    el.querySelectorAll('[data-unblock]').forEach(x=>x.onclick=()=>removeBlacklist(x.dataset.unblock));
    const addBlock=el.querySelector('#vr-add-block');
    if(addBlock)addBlock.onclick=()=>addBlacklist(el.querySelector('#vr-block-id').value,el.querySelector('#vr-block-reason').value);
    const blockSearch=el.querySelector('#vr-block-search');
    if(blockSearch)blockSearch.oninput=()=>{
      const query=blockSearch.value.trim().toLowerCase();
      const list=Object.entries(db.blacklist).filter(([id,b])=>
        id.includes(query)||(db.clients[id]?.name||b.name||'').toLowerCase().includes(query)||(b.reason||'').toLowerCase().includes(query));
      el.querySelector('#vr-block-list').innerHTML=blacklistRows(list);
      el.querySelector('#vr-block-list').querySelectorAll('[data-unblock]').forEach(x=>x.onclick=()=>removeBlacklist(x.dataset.unblock));
      el.querySelector('#vr-block-list').querySelectorAll('[data-account]').forEach(x=>x.onclick=()=>compose(x.dataset.account,true));
    };
    el.querySelectorAll('[data-compose]').forEach(x=>x.onclick=()=>compose(x.dataset.compose));
    el.querySelectorAll('[data-account]').forEach(x=>x.onclick=()=>compose(x.dataset.account,true));
    el.querySelectorAll('[data-access]').forEach(x=>x.onclick=()=>compose(x.dataset.access,true,true));
    el.querySelectorAll('[data-claim]').forEach(x=>x.onclick=()=>claim(x.dataset.claim));
    el.querySelectorAll('[data-pay]').forEach(x=>x.onclick=()=>payRequest(x.dataset.pay));
    el.querySelectorAll('[data-name]').forEach(x=>x.onclick=()=>{
      const c=db.clients[x.dataset.name];const name=prompt('Customer name:',c.name||'');if(name===null)return;c.name=name.trim().slice(0,80);if(cloudToken)cloudAction('POST','/api/name',{tornId:c.id,name:c.name});else{save();renderAll();}
    });
    el.querySelectorAll('[data-settle]').forEach(x=>x.onclick=()=>settle(x.dataset.settle,x.dataset.status));
    const search=el.querySelector('#vr-search');if(search)search.oninput=()=>{
      const text=search.value.toLowerCase();
      el.querySelector('#vr-list').innerHTML=clientRows(clientsInTab(activeTab).filter(c=>(c.name||'').toLowerCase().includes(text)||c.id.includes(text)));
      el.querySelector('#vr-list').querySelectorAll('[data-compose]').forEach(x=>x.onclick=()=>compose(x.dataset.compose));
      el.querySelector('#vr-list').querySelectorAll('[data-account]').forEach(x=>x.onclick=()=>compose(x.dataset.account,true));
      el.querySelector('#vr-list').querySelectorAll('[data-access]').forEach(x=>x.onclick=()=>compose(x.dataset.access,true,true));
      el.querySelector('#vr-list').querySelectorAll('[data-claim]').forEach(x=>x.onclick=()=>claim(x.dataset.claim));
      el.querySelector('#vr-list').querySelectorAll('[data-name]').forEach(x=>x.onclick=()=>{const c=db.clients[x.dataset.name];const name=prompt('Customer name:',c.name||'');if(name===null)return;c.name=name.trim().slice(0,80);if(cloudToken)cloudAction('POST','/api/name',{tornId:c.id,name:c.name});else{save();renderAll();}});
      el.querySelector('#vr-list').querySelectorAll('[data-blacklist]').forEach(x=>x.onclick=()=>{const id=x.dataset.blacklist;const reason=prompt('Why blacklist '+(db.clients[id]?.name||'#'+id)+'? (Cancel to abort)','Buy-mug');if(reason!==null)addBlacklist(id,reason);});
    };
    const keyBtn=el.querySelector('#vr-keysave');if(keyBtn)keyBtn.onclick=()=>{const key=el.querySelector('#vr-key').value.trim();if(!key)return alert('Enter your API key');GM_setValue(API,key);el.querySelector('#vr-key').value='';alert('API key saved in Tampermonkey storage');};
    const templates=el.querySelector('#vr-templates');if(templates)templates.onclick=()=>{
      db.settings={subject:el.querySelector('#vr-s').value,greeting:el.querySelector('#vr-g').value,message:el.querySelector('#vr-m').value,footer:el.querySelector('#vr-f').value};if(cloudToken)cloudAction('POST','/api/meta',{templates:db.settings});else save();updateStatus('Templates saved');
    };
    const reset=el.querySelector('#vr-reset-start');if(reset)reset.onclick=()=>{
      if(cloudToken)return alert('Reset is disabled while Cloud is connected. Disconnect and perform an explicit database migration to reset the server.');
      const value=el.querySelector('#vr-start').value;const t=Date.parse(value);
      if(!Number.isFinite(t)||t>Date.now())return alert('Choose a valid date in the past or present.');
      exportData();
      if(!confirm('This will RESET all sales, customers, points, payouts and thank-you acknowledgements. A backup was downloaded. Continue?'))return;
      if(prompt('Type RESET to confirm clearing the entire loyalty ledger:')!=='RESET')return;
      const retainedBlacklist={...db.blacklist};db=freshDB();db.blacklist=retainedBlacklist;db.startedAt=Math.floor(t/1000);save();renderAll();
    };
  }
  function renderAll(){
    const el=root.querySelector('#vr-content');
    el.innerHTML=(activeTab==='clients'||activeTab==='thanked')?renderClients():activeTab==='payouts'?renderPayouts():activeTab==='blacklist'?renderBlacklist():renderSettings();
    const newCount=root.querySelector('#vr-count-new'), thankedCount=root.querySelector('#vr-count-thanked');
    if(newCount)newCount.textContent='('+clientsInTab('clients').length+')';
    if(thankedCount)thankedCount.textContent='('+clientsInTab('thanked').length+')';
    bindPanel();
  }
  // Add convenience buttons to the user's existing Events UI. The ledger is API-sourced, never computed from page text.
  function decorateEvents() {
    if(!location.href.includes('sid=events'))return;
    document.querySelectorAll('p').forEach(p=>{
      if(!p.textContent.includes('from your bazaar')||p.querySelector('.vr-event-btn'))return;
      const a=p.querySelector('a[href*="XID="]');const id=cleanId(a?.href.match(/XID=(\d+)/)?.[1]);if(!id)return;
      const btn=document.createElement('button');btn.className='vr-event-btn';btn.textContent='🇮🇹 Vito';
      btn.onclick=()=>{
        if(!db.clients[id])return alert('Customer not in Rewards yet. Sync sales first.');
        if(!db.clients[id].name&&a?.textContent?.trim()){db.clients[id].name=a.textContent.trim();save();}
        compose(id);
      };p.appendChild(btn);
    });
  }
  // Old Torn Mail composer retained for compatibility; Vito now uses chat drafts only.
  // We deliberately never click Torn's Send button.
  function fillTornComposer() {
    if(location.pathname!=='/messages.php')return;
    let pending;
    try{pending=JSON.parse(localStorage.getItem('vrPendingDraft')||'null');}catch{return;}
    if(!pending || Date.now()-pending.createdAt > 10*60*1000)return;
    if(!location.hash.includes('XID='+pending.id))return;
    const subject=document.querySelector('input.subject');
    const editor=document.querySelector('#mce_0') || document.querySelector('textarea');
    if(!subject || !editor)return;
    // Refuse to overwrite text the player is already composing.
    if(subject.value.trim() || (editor.tagName==='TEXTAREA' && editor.value.trim()))return;
    if(editor.tagName!=='TEXTAREA' && editor.textContent.trim())return;
    subject.value=pending.subject;
    subject.dispatchEvent(new Event('input',{bubbles:true}));
    subject.dispatchEvent(new Event('change',{bubbles:true}));
    if(editor.tagName==='TEXTAREA'){
      editor.value=pending.body;
    }else{
      editor.textContent=pending.body;
      editor.innerHTML=escapeHtml(pending.body).replace(/\n/g,'<br>');
    }
    editor.dispatchEvent(new Event('input',{bubbles:true}));
    localStorage.removeItem('vrPendingDraft');
  }
  rebuild();save();renderAll();decorateEvents();
  if(cloudToken)cloudRefresh().then(()=>queueNameLookup()).catch(e=>console.warn('[VITO Cloud]',e.message));
  else queueNameLookup();
  setInterval(()=>{if(cloudToken&&cloudReady&&document.visibilityState==='visible')cloudRefresh().catch(()=>{});},60000);
  setInterval(fillChatDraft,400);
  if(location.href.includes('sid=events'))setInterval(decorateEvents,4000);
})();
