const fs = require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
(async()=>{
 process.loadEnvFile('/home/cj/bull/agent/.env');
 const base=process.env.ALPACA_BASE_URL;
 if(base!=='https://paper-api.alpaca.markets') throw Error('Paper endpoint required');
 const dir=fs.mkdtempSync('/tmp/bull-accounting-20260914-'); fs.chmodSync(dir,0o700);
 const source='/home/cj/bull/agent/runtime/v2/bull.db';
 const sourceDb = new DatabaseSync(source,{readOnly:true});
 const tableNames=['fills','lots','disposals','cash_events','state','book_marks','order_intents'];
 const fingerprint=()=>Object.fromEntries(tableNames.map(name=>[name,createHash('sha256').update(JSON.stringify(sourceDb.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())).digest('hex')]));
 const before=fingerprint();
 execFileSync('python3',['-c','import sqlite3,sys; s=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()',source,dir+'/snapshot.sqlite']);
 fs.chmodSync(dir+'/snapshot.sqlite',0o600);
 const headers={'APCA-API-KEY-ID':process.env.ALPACA_API_KEY,'APCA-API-SECRET-KEY':process.env.ALPACA_API_SECRET};
 const get=async(url)=>{const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Read failed '+r.status);return r.json()};
 const positions=await get(base+'/v2/positions'); const account=await get(base+'/v2/account');
 const openOrders=await get(base+'/v2/orders?status=open&limit=500');
 if(!Array.isArray(openOrders)||openOrders.length)throw Error('Open orders prevent a stable repair capture');
 const symbols=[...new Set(sourceDb.prepare('SELECT symbol FROM fills').all().map(r=>r.symbol))];
 const actions=await get('https://data.alpaca.markets/v1/corporate-actions?'+new URLSearchParams({symbols:symbols.join(','),start:'2026-08-01',end:'2026-10-01',limit:'1000'}));
 const activities=[]; const seen=new Set(); let token='',complete=false;
 const until=new Date().toISOString();
 for(let p=0;p<50;p++){
  const qs=new URLSearchParams({after:'2026-08-10T00:00:00Z',until,direction:'asc',page_size:'100'});if(token)qs.set('page_token',token);
  const rows=await get(base+'/v2/account/activities?'+qs);if(!Array.isArray(rows))throw Error('Activity shape');
  for(const r of rows){if(!r.id||seen.has(r.id))throw Error('Duplicate activity');seen.add(r.id);activities.push(r)}
  if(rows.length<100){complete=true;break}token=rows.at(-1).id;
 }
 if(!complete||actions.next_page_token)throw Error('Incomplete pagination');
 const endAccount=await get(base+'/v2/account'); const endPositions=await get(base+'/v2/positions');
 const positionsView=p=>p.map(r=>({symbol:r.symbol,qty:r.qty,avg_entry_price:r.avg_entry_price})).sort((a,b)=>a.symbol.localeCompare(b.symbol));
 const after=fingerprint();
 const stable=JSON.stringify(before)===JSON.stringify(after)&&account.cash===endAccount.cash&&JSON.stringify(positionsView(positions))===JSON.stringify(positionsView(endPositions));
 const evidence={observedAt:new Date().toISOString(),activityUntil:until,complete,stable,before,after,openOrders:[],account:{cash:account.cash,equity:account.equity,status:account.status,trading_blocked:account.trading_blocked},positions:positionsView(positions),activities,actions};
 fs.writeFileSync(dir+'/evidence.json',JSON.stringify(evidence,null,2),{mode:0o600,flag:'wx'});
 const halts=sourceDb.prepare("SELECT key FROM state WHERE key LIKE 'halt:%'").all();
 console.log(JSON.stringify({dir,stable,complete,activities:activities.length,counts:Object.fromEntries([...new Set(activities.map(a=>a.activity_type))].map(k=>[k,activities.filter(a=>a.activity_type===k).length])),fillRows:sourceDb.prepare('SELECT count(*) n FROM fills').get().n,haltKeys:halts.map(r=>r.key)}));
 sourceDb.close(); if(!stable)process.exitCode=2;
})().catch(e=>{console.error(e.message);process.exitCode=1});
