import assert from 'node:assert/strict';
import {openDb,setState,getState,clearState} from './v2/db.js';
import {d9,mul9} from './v2/decimal.js';
import {ingestFill,ledgerPositions} from './v2/lots.js';
import {seedBook,recordCash,totalCash} from './v2/settled-cash.js';
import {ACCOUNTING_POLICY,ensureAccountingTables,putEntitlement,hash,economicRights,historicalQty,ingestBrokerCashActivities,captureDividend} from './v2/accounting.js';
import {prepareSettlement,applySettlement,settlementFingerprint,type SettlementEvidence} from './v2/entitlement-settlement.js';
import {applyDueActions} from './v2/book/corporate-actions.js';
import {nightlyCorpPoll} from './v2/rituals/corp-actions.js';
const empty={forwardSplits:[],dividends:[],exitBefore:[],unknown:[]};
function fixture(kind:'dividend'|'split'='dividend'){
 const db=openDb(':memory:');ensureAccountingTables(db);seedBook(db,'1000','2026-08-10');
 setState(db,'accounting:policy',ACCOUNTING_POLICY);setState(db,'accounting:history-from','2026-08-10');setState(db,'accounting:seed-activity-id','seed');setState(db,'halt:book','review receipt');
 ingestFill(db,{id:'buy1',symbol:'ABC',side:'buy',qty9:d9('2'),price9:d9('100'),ts:'2026-08-11T14:00:00Z',sleeve:'mom'});
 recordCash(db,{ts:'2026-08-11T14:00:00Z',kind:'buy',amount9:d9('-200'),settlesOn:'2026-08-12',ref:'buy1'});
 const id=kind==='dividend'?'div:ABC:2026-08-12':'split:ABC:2026-08-12';
 putEntitlement(db,{id,kind,symbol:'ABC',exDate:'2026-08-12',eligibleQty9:'2',cash9:kind==='dividend'?'0.4':'0',extraQty9:kind==='split'?'2':'0',sleeve:kind==='split'?'mom':null,evidence:{test:true}});
 const receipt={id:'receipt1',activity_type:kind==='dividend'?'DIV':'SSP',symbol:'ABC',date:'2026-08-13',net_amount:kind==='dividend'?'0.4':'0',qty:'2',per_share_amount:'0.2'};
 const evidence=():SettlementEvidence=>({observedAt:new Date().toISOString(),activityUntil:new Date().toISOString(),before:settlementFingerprint(db),after:settlementFingerprint(db),stable:true,complete:true,openOrders:[],account:{cash:kind==='dividend'?'800.4':'800',status:'ACTIVE',trading_blocked:false},positions:[{symbol:'ABC',qty:kind==='split'?'4':'2'}],activities:[{id:'seed',activity_type:'JNLC',date:'2026-08-10',net_amount:'1000'},{id:'buy1',activity_type:'FILL',symbol:'ABC',side:'buy',qty:'2',price:'100',transaction_time:'2026-08-11T14:00:00Z'},receipt]});
 return {db,id,receipt,evidence};
}
let count=0;function test(name:string,fn:()=>void){fn();console.log('✓ '+name);count++;}
for(const kind of ['dividend','split'] as const)test(kind+' delivery is exact, preserves evidence/halts and cannot double count',()=>{
 const {db,id,receipt,evidence}=fixture(kind),e=evidence();e.activityUntil=e.observedAt;
 const original=hash(db.prepare('SELECT * FROM corporate_entitlements').all()),fills=hash(db.prepare('SELECT * FROM fills').all());
 const p=prepareSettlement(db,e,id,receipt.id);applySettlement(db,p,e,hash(p));
 assert.equal(totalCash(db),d9(kind==='dividend'?'800.4':'800'));assert.equal(ledgerPositions(db).get('ABC'),d9(kind==='split'?'4':'2'));
 assert.equal(hash(db.prepare('SELECT * FROM corporate_entitlements').all()),original);assert.equal(hash(db.prepare('SELECT * FROM fills').all()),fills);assert.equal(getState(db,'halt:book'),'review receipt');
 assert.deepEqual(economicRights(db,'2026-08-14',new Map([['ABC',d9('50')]])),{cash9:0n,stock9:0n});
 assert.equal(economicRights(db,'2026-08-12',new Map([['ABC',d9('50')]]) )[kind==='dividend'?'cash9':'stock9'],d9(kind==='dividend'?'0.4':'100'));
 assert.equal(ingestBrokerCashActivities(db,[receipt]),0);assert.throws(()=>applySettlement(db,p,e,hash(p)));assert.equal(historicalQty(db,'ABC','2026-08-14'),d9(kind==='split'?'4':'2'));db.close();
});
for(const failure of ['hash','stale','future','db','positions','cash','partial','rate','unrelated','duplicate','orders','halt','incomplete'])test('refuses '+failure+' with no writes',()=>{
 const {db,id,receipt,evidence}=fixture(),e=evidence();e.activityUntil=e.observedAt;
 const p=prepareSettlement(db,e,id,receipt.id);
 if(failure==='stale')e.observedAt='2020-01-01T00:00:00Z';
 if(failure==='future')e.observedAt=new Date(Date.now()+60000).toISOString();
 if(failure==='db')setState(db,'new-hold','foreign change');
 if(failure==='positions')e.positions[0].qty='3';
 if(failure==='cash')e.account.cash='999';
 if(failure==='partial')receipt.net_amount='0.2';
 if(failure==='rate')receipt.per_share_amount='0.3';
 if(failure==='unrelated')e.activities.push({id:'extra',activity_type:'DIV'});
 if(failure==='duplicate')e.activities.push(receipt);
 if(failure==='orders')e.openOrders.push({id:'order'});
 if(failure==='halt')clearState(db,'halt:book');
 if(failure==='incomplete')e.complete=false;
 const before=settlementFingerprint(db);assert.throws(()=>applySettlement(db,p,e,failure==='hash'?'0'.repeat(64):hash(p)));assert.equal(settlementFingerprint(db),before);db.close();
});
test('changed dividend terms create one durable conflict card and preserve original right',()=>{
 const {db}=fixture();clearState(db,'halt:book');const old=hash(db.prepare('SELECT * FROM corporate_entitlements').all());
 const plan={...empty,dividends:[{symbol:'ABC',exDate:'2026-08-12',perShare9:d9('0.3')}]};
 const result=applyDueActions(db,plan,'2026-08-14');assert.equal(result.halted,true);assert.equal(result.dividendsDeferred,1);
 const cards=db.prepare('SELECT count(*) n FROM approvals').get()!.n;applyDueActions(db,plan,'2026-08-14');assert.equal(db.prepare('SELECT count(*) n FROM approvals').get()!.n,cards);
 assert.equal(hash(db.prepare('SELECT * FROM corporate_entitlements').all()),old);assert.equal(totalCash(db),d9('800'));db.close();
});
test('split receipt preserves basis, handles later FIFO sell and future dividend history',()=>{
 const {db,id,receipt,evidence}=fixture('split');setState(db,'split_stale:ABC',JSON.stringify({ts:'2026-08-12T00:00:00Z'}));const e=evidence();e.activityUntil=e.observedAt;
 const p=prepareSettlement(db,e,id,receipt.id);applySettlement(db,p,e,hash(p));
 assert.equal(db.prepare('SELECT basis_remaining9 FROM lots').get()!.basis_remaining9,'200');
 ingestFill(db,{id:'sell',symbol:'ABC',side:'sell',qty9:d9('3'),price9:d9('60'),ts:'2026-08-14T14:00:00Z',sleeve:'mom'});
 assert.equal(historicalQty(db,'ABC','2026-08-15'),d9('1'));
 assert.equal(captureDividend(db,{symbol:'ABC',exDate:'2026-08-15',perShare9:d9('0.1')},'2026-08-16'),true);
 assert.equal(db.prepare("SELECT cash9 FROM corporate_entitlements WHERE id='div:ABC:2026-08-15'").get()!.cash9,'0.1');db.close();
});
test('second split on a flat execution book with undelivered rights is contained',()=>{
 const {db}=fixture('split');ingestFill(db,{id:'sell',symbol:'ABC',side:'sell',qty9:d9('2'),price9:d9('50'),ts:'2026-08-13T14:00:00Z',sleeve:'mom'});clearState(db,'halt:book');
 const r=applyDueActions(db,{...empty,forwardSplits:[{symbol:'ABC',exDate:'2026-08-14',num:2n,den:1n}]},'2026-08-14');assert.equal(r.halted,true);assert.equal(r.splitsDeferred,1);db.close();
});
test('changed split ratio survives legacy applied marker and blocks settlement',()=>{
 const {db,id,receipt,evidence}=fixture('split');setState(db,'corp:applied:ABC:2026-08-12','old');clearState(db,'halt:book');
 const result=applyDueActions(db,{...empty,forwardSplits:[{symbol:'ABC',exDate:'2026-08-12',num:3n,den:1n}]},'2026-08-14');assert.equal(result.halted,true);
 assert.throws(()=>prepareSettlement(db,evidence(),id,receipt.id),/Conflicting entitlement/);db.close();
});
{
 const {db}=fixture();const {plan}=await nightlyCorpPoll(db,{announcements:async()=>[{symbol:'ABC',type:'reverse_split',effectiveDate:'2026-08-12'},{symbol:'ABC',type:'cash_merger',effectiveDate:'2026-08-15'}]},{today:'2026-08-15'});
 assert.deepEqual(plan.exitBefore.map(x=>x.effectiveDate),['2026-08-12','2026-08-15']);
 const irrelevant=await nightlyCorpPoll(db,{announcements:async()=>[{symbol:'ABC',type:'reverse_split',effectiveDate:'2026-08-10'}]},{today:'2026-08-15'});
 assert.equal(irrelevant.plan.exitBefore.length,0);db.close();count++;
}
console.log(`${count} settlement scenarios passed`);
