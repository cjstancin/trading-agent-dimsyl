// Reviewed, full-delivery settlements only. No orders, fake fills, halt clearing or inference
// from announcements. Original rights remain immutable; receipts retire them as of delivery.
import type {DatabaseSync} from 'node:sqlite';
import {accountingEnabled,ensureAccountingTables,hash,overlayEconomicCash,etDate,brokerActivityHash} from './accounting.js';
import {getState} from './db.js';
import {d9,d9str,mul9,type D9} from './decimal.js';
import {recordCash,totalCash} from './settled-cash.js';
import {ledgerPositions} from './lots.js';

const TABLES=['fills','lots','disposals','cash_events','state','order_intents','approvals','wash_links','position_meta',
 'book_marks','bench_marks','corporate_entitlements','accounting_repairs','accounting_marks','accounting_mark_rights','accounting_cash_overlays','entitlement_settlements'];
function requireThat(x:unknown,message:string):asserts x {if(!x)throw Error(message);}
export function settlementFingerprint(db:DatabaseSync):string {
 return hash(TABLES.map(t=>[t,db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)?db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all():[]]));
}
const cents=(n:D9)=>(n<0n?-1n:1n)*(((n<0n?-n:n)+5_000_000n)/10_000_000n)*10_000_000n;
function date(value:unknown):string {
 requireThat(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value),'Invalid receipt date');
 requireThat(new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value,'Invalid receipt date');return value;
}
export interface SettlementEvidence {
 observedAt:string;activityUntil:string;before:string;after:string;complete:boolean;stable:boolean;
 account:{cash:string;status:string;trading_blocked:boolean};positions:{symbol:string;qty:string}[];activities:any[];openOrders:any[];
}
export interface SettlementPlan {
 version:1;entitlementId:string;activityId:string;before:string;financialHash:string;
 entitlement:any;activity:any;effectiveDate:string;cash9:string;qty9:string;lot:any|null;cashAfter9:string;
}
function financialHash(e:SettlementEvidence):string {const {observedAt,activityUntil,...inputs}=e;return hash(inputs);}
function settlements(db:DatabaseSync):any[]{return db.prepare("SELECT 1 FROM sqlite_master WHERE name='entitlement_settlements'").get()?db.prepare('SELECT * FROM entitlement_settlements').all():[];}

export function prepareSettlement(db:DatabaseSync,e:SettlementEvidence,entitlementId:string,activityId:string):SettlementPlan {
 requireThat(accountingEnabled(db)&&getState(db,'halt:book'),'Reviewed accounting policy and standing book halt required');
 requireThat(e.complete&&e.stable&&e.before===e.after&&e.before===settlementFingerprint(db),'Incomplete, unstable or changed evidence');
 requireThat(e.account.status==='ACTIVE'&&e.account.trading_blocked===false&&e.openOrders.length===0,'Account unavailable or orders pending');
 const ent=db.prepare("SELECT * FROM corporate_entitlements WHERE id=? AND status='outstanding'").get(entitlementId) as any;
 requireThat(ent,'Outstanding entitlement required');
 requireThat(!db.prepare("SELECT 1 FROM state WHERE substr(key,1,?)=?").get(('corp:conflict:'+entitlementId+':').length,'corp:conflict:'+entitlementId+':'),'Conflicting entitlement must be resolved by separate review');
 const prior=settlements(db);
 requireThat(!prior.some(s=>s.entitlement_id===entitlementId||s.activity_id===activityId),'Settlement already applied');
 requireThat(new Set(e.activities.map(a=>a.id)).size===e.activities.length&&e.activities.every(a=>typeof a.id==='string'&&a.id),'Duplicate/missing activity IDs');
 const activity=e.activities.find(a=>a.id===activityId);requireThat(activity&&activity.symbol===ent.symbol,'Receipt symbol mismatch or missing activity');
 const effectiveDate=date(activity.date);requireThat(effectiveDate>=ent.ex_date&&effectiveDate<=etDate(e.observedAt),'Receipt date outside entitlement/capture');
 requireThat(!db.prepare('SELECT 1 FROM cash_events WHERE ref=?').get(activityId),'Receipt already credited');
 let cash9=0n,qty9=0n,lot:any=null;
 if(ent.kind==='dividend'){
   requireThat(activity.activity_type==='DIV'&&d9(ent.extra_qty9)===0n,'Only ordinary cash dividend receipts supported');
   cash9=d9(activity.net_amount);
   requireThat(cash9>0n&&cash9===cents(d9(ent.cash9))&&d9(activity.qty)===d9(ent.eligible_qty9),'Partial, excessive or unmatched dividend receipt');
   requireThat(d9(activity.per_share_amount)>0n&&mul9(d9(activity.qty),d9(activity.per_share_amount))===d9(ent.cash9),'Receipt rate differs from entitlement');
 }else{
   requireThat(ent.kind==='split'&&activity.activity_type==='SSP'&&d9(activity.net_amount)===0n&&d9(ent.cash9)===0n,'Only stock-only split receipts supported');
   qty9=d9(activity.qty);requireThat(qty9>0n&&qty9===d9(ent.extra_qty9),'Partial or ambiguous stock receipt');
   const lots=db.prepare('SELECT * FROM lots WHERE symbol=?').all(ent.symbol) as any[];
   requireThat(lots.length===1,'Multi-lot settlement needs separate allocation review');lot=lots[0];
   requireThat(lot.sleeve===ent.sleeve&&d9(lot.qty_open9)===d9(ent.eligible_qty9)&&d9(lot.qty_remaining9)===d9(lot.qty_open9)
     &&d9(lot.basis_total9)===d9(lot.basis_remaining9)&&d9(lot.wash_adj_basis9)===0n
     &&!db.prepare('SELECT 1 FROM disposals WHERE lot_id=?').get(lot.lot_id),'Split with disposals/wash/mixed holdings needs separate review');
   requireThat(!prior.some(s=>d9(s.qty9)!==0n&&JSON.parse(s.plan_json).entitlement.symbol===ent.symbol),'Repeated split settlement needs separate review');
 }
 // Account-wide proof: all fills, fees and earlier settlements must already be accounted for.
 const fills=db.prepare('SELECT * FROM fills').all() as any[];
 requireThat(e.activities.filter(a=>a.activity_type==='FILL').length===fills.length,'Incomplete fill history');
 for(const a of e.activities){
   if(a.id===activityId)continue;
   if(a.activity_type==='FILL'){
     const f=fills.find(f=>f.id===a.id);requireThat(f&&f.symbol===a.symbol&&f.side===a.side&&f.ts===a.transaction_time&&d9(f.qty9)===d9(a.qty)&&d9(f.price9)===d9(a.price),'Unaccounted or altered fill');
   }else if(a.activity_type==='FEE'||(a.activity_type==='JNLC'&&a.id===getState(db,'accounting:seed-activity-id'))){
     const c=db.prepare('SELECT * FROM cash_events WHERE kind=? AND ref=?').get(a.activity_type==='FEE'?'fee':'seed',a.activity_type==='FEE'?a.id:'seed') as any;
     requireThat(c&&d9(c.amount9)===d9(a.net_amount)&&c.settles_on===date(a.date),'Unaccounted fee/seed');
   }else requireThat(prior.some(s=>s.activity_id===a.id&&s.activity_hash===brokerActivityHash(a)),'Other unresolved or changed broker activity');
 }
 const cashAfter9=totalCash(db)+cash9;
 requireThat(cents(cashAfter9)===d9(e.account.cash),'Cash does not reconcile after exact receipt');
 const positions=ledgerPositions(db);positions.set(ent.symbol,(positions.get(ent.symbol)??0n)+qty9);
 requireThat(new Set(e.positions.map(p=>p.symbol)).size===e.positions.length,'Duplicate broker positions');
 for(const symbol of new Set([...positions.keys(),...e.positions.map(p=>p.symbol)]))requireThat((positions.get(symbol)??0n)===d9(e.positions.find(p=>p.symbol===symbol)?.qty??'0'),'Positions do not reconcile after exact receipt');
 return {version:1,entitlementId,activityId,before:e.before,financialHash:financialHash(e),entitlement:ent,activity,effectiveDate,cash9:d9str(cash9),qty9:d9str(qty9),lot,cashAfter9:d9str(cashAfter9)};
}

export function applySettlement(db:DatabaseSync,plan:SettlementPlan,e:SettlementEvidence,reviewedHash:string):{applied:boolean;reviewHash:string} {
 requireThat(/^[a-f0-9]{64}$/.test(reviewedHash)&&hash(plan)===reviewedHash,'Exact independent reviewed hash required');
 const observed=Date.parse(e.observedAt),until=Date.parse(e.activityUntil),now=Date.now();
 requireThat(Number.isFinite(observed)&&Number.isFinite(until)&&observed<=now&&now-observed<=600000&&until<=observed&&observed-until<=60000,'Fresh wall-clock evidence required');
 db.exec('BEGIN IMMEDIATE');
 try{
   requireThat(hash(prepareSettlement(db,e,plan.entitlementId,plan.activityId))===reviewedHash,'Fresh evidence differs from reviewed plan');
   ensureAccountingTables(db);
   if(d9(plan.cash9)!==0n){
     requireThat(recordCash(db,{ts:plan.effectiveDate+'T12:00:00Z',kind:'dividend',symbol:plan.entitlement.symbol,amount9:d9(plan.cash9),settlesOn:plan.effectiveDate,ref:plan.activityId,note:'Reviewed broker dividend receipt'}),'Duplicate receipt');
     overlayEconomicCash(db,'settlement:'+plan.activityId,plan.effectiveDate,d9(plan.cash9)-d9(plan.entitlement.cash9));
   }
   if(plan.lot){
     const qty=d9str(d9(plan.lot.qty_open9)+d9(plan.qty9));
     db.prepare('UPDATE lots SET qty_open9=?,qty_remaining9=? WHERE lot_id=?').run(qty,qty,plan.lot.lot_id);
   }
   db.prepare('INSERT INTO entitlement_settlements VALUES(?,?,?,?,?,?,?,?,?)').run(plan.entitlementId,plan.activityId,brokerActivityHash(plan.activity),plan.effectiveDate,plan.cash9,plan.qty9,reviewedHash,JSON.stringify(plan),new Date().toISOString());
   requireThat(totalCash(db)===d9(plan.cashAfter9),'Post-settlement cash mismatch');
   db.exec('COMMIT');return {applied:true,reviewHash:reviewedHash};
 }catch(error){db.exec('ROLLBACK');throw error;}
}

/** GET-only complete capture, double account/position/order snapshots plus DB fingerprints.
 * The CLI supplies a paper-only HTTP reader. Account identifiers/credentials never leave it. */
export async function captureSettlement(db:DatabaseSync,get:(path:string)=>Promise<any>):Promise<SettlementEvidence>{
 const before=settlementFingerprint(db);
 const accountView=(a:any)=>({cash:a.cash,status:a.status,trading_blocked:a.trading_blocked});
 const posView=(p:any[])=>p.map(x=>({symbol:x.symbol,qty:x.qty})).sort((a,b)=>a.symbol.localeCompare(b.symbol));
 const account=accountView(await get('/v2/account')),positions=posView(await get('/v2/positions'));
 const openOrders=await get('/v2/orders?status=open&limit=500');requireThat(Array.isArray(openOrders)&&!openOrders.length,'Open orders');
 const from=getState(db,'accounting:history-from');requireThat(from,'Missing history boundary');
 const activityUntil=new Date().toISOString(),activities:any[]=[];let token='',complete=false;
 for(let page=0;page<100;page++){
   const params=new URLSearchParams({after:date(from)+'T00:00:00Z',until:activityUntil,direction:'asc',page_size:'100'});if(token)params.set('page_token',token);
   const rows=await get('/v2/account/activities?'+params);requireThat(Array.isArray(rows),'Malformed activities');
   activities.push(...rows);if(rows.length<100){complete=true;break;}token=rows.at(-1).id;
 }
 const endAccount=accountView(await get('/v2/account')),endPositions=posView(await get('/v2/positions')),endOrders=await get('/v2/orders?status=open&limit=500');
 const after=settlementFingerprint(db);
 return {observedAt:new Date().toISOString(),activityUntil,before,after,complete,stable:before===after&&hash(account)===hash(endAccount)&&hash(positions)===hash(endPositions)&&Array.isArray(endOrders)&&!endOrders.length,account,positions,activities,openOrders};
}
