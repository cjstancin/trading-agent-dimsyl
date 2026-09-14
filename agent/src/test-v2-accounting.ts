import assert from 'node:assert/strict';
import { openDb,getState,setState,clearState } from './v2/db.js';
import { d9,d9str } from './v2/decimal.js';
import { ingestFill,ledgerPositions } from './v2/lots.js';
import { recordCash,seedBook,totalCash,settledCash } from './v2/settled-cash.js';
import { ensureBookTables,equityCurve,markEquity } from './v2/book/equity.js';
import { ensureBenchTables,benchSeries,recordBench } from './v2/book/benchmarks.js';
import { prepareRepair,applyRepair,reverseRepair,fingerprints,reviewHash,type RepairEvidence } from './v2/accounting-repair.js';
import { hash,etDate,historicalQty,economicRights,ingestBrokerCashActivities,captureDividend,ensureAccountingTables,entitlementKnown } from './v2/accounting.js';
import { applyDueActions } from './v2/book/corporate-actions.js';
import { reconcileBoot,replayFills } from './v2/reconcile.js';
import { alpacaReadPort } from './v2/broker.js';
import { nightlyCorpPoll } from './v2/rituals/corp-actions.js';

function fixture(){
  const db=openDb(':memory:');ensureBookTables(db);ensureBenchTables(db);
  seedBook(db,'1000','2026-08-10');
  const fill=(id:string,symbol:string,side:'buy'|'sell',qty:string,price:string,ts:string)=>{
    ingestFill(db,{id,symbol,side,qty9:d9(qty),price9:d9(price),ts,sleeve:'mom',raw:'{}'});
    recordCash(db,{ts,kind:side,symbol,amount9:(side==='buy'?-1n:1n)*d9(String(Number(qty)*Number(price))),settlesOn:ts.slice(0,10),ref:id});
  };
  fill('f1','SGOV','buy','3','10','2026-08-28T14:00:00Z');
  fill('f2','SGOV','sell','3','11','2026-09-01T14:00:00Z');
  fill('f3','APH','buy','2','100','2026-09-02T14:00:00Z');
  recordCash(db,{ts:'2026-09-01T00:00:00Z',kind:'dividend',symbol:'SGOV',amount9:d9('0.1'),settlesOn:'2026-09-01',ref:'div:SGOV:2026-09-01'});
  recordCash(db,{ts:'2026-08-20T00:00:00Z',kind:'dividend',symbol:'AMAT',amount9:d9('0.3'),settlesOn:'2026-08-20',ref:'div:AMAT:2026-08-20'});
  for(const [date,qty,px] of [['2026-09-02','2','100'],['2026-09-03','4','50']]){
    const positions=[{symbol:'APH',qty9:qty,price9:px,value9:'200'}];
    db.prepare('INSERT INTO book_marks VALUES(?,?,?,?,?,?,?)').run(date,'1003.4','803.4',JSON.stringify(positions),'engage',0,date+'T20:30:00Z');
    for(const [s,w] of Object.entries({mom:0.4,ins:0.25,anc:0.25,wld:0.1}))db.prepare('INSERT INTO bench_marks VALUES(?,?,?)').run(date,`sleeve:${s}`,String(803.4*w+(s==='mom'?200:0)));
  }
  db.prepare("UPDATE lots SET qty_open9='4',qty_remaining9='4' WHERE symbol='APH'").run();
  setState(db,'split_stale:APH',JSON.stringify({num:'2',den:'1',ts:'2026-09-03T00:00:00Z'}));setState(db,'corp:applied:APH:2026-09-03','2026-09-03');
  setState(db,'halt:book','test incident');setState(db,'halt:mom','test mismatch');setState(db,'brake:tier','0');setState(db,'brake:peak9',d9('1003.4').toString());
  const f=db.prepare('SELECT * FROM fills ORDER BY rowid').all() as any[];
  const fp=fingerprints(db,['fills','lots','disposals','cash_events','state','book_marks','order_intents']);
  const evidence:RepairEvidence={observedAt:'2026-09-14T16:00:00Z',activityUntil:'2026-09-14T15:59:00Z',complete:true,stable:true,before:fp,after:fp,
    openOrders:[],account:{cash:'802.99',status:'ACTIVE',trading_blocked:false},positions:[{symbol:'APH',qty:'2'}],activities:[{id:'seed',activity_type:'JNLC',net_amount:'1000',date:'2026-08-10'},
      ...f.map(r=>({id:r.id,activity_type:'FILL',symbol:r.symbol,side:r.side,qty:r.qty9,price:r.price9,transaction_time:r.ts})),
      {id:'fee1',activity_type:'FEE',net_amount:'-0.01',date:'2026-09-02'}],
    actions:{corporate_actions:{cash_dividends:[{symbol:'SGOV',ex_date:'2026-09-01',rate:'0.2',id:'d1'},{symbol:'AMAT',ex_date:'2026-08-20',rate:'0.3',id:'d2'}],forward_splits:[{symbol:'APH',ex_date:'2026-09-03',new_rate:'2',old_rate:'1',id:'s1'}]}}};
  return {db,evidence};
}
const now=new Date('2026-09-14T16:01:00Z');
let checks=0;
function test(name:string,fn:()=>void){fn();checks++;console.log('✓ '+name);}

test('reconstruct entitlement before ex-date; execution cash and shares never include undelivered rights',()=>{
  const {db,evidence}=fixture();const plan=prepareRepair(db,evidence),beforeFills=hash(db.prepare('SELECT * FROM fills').all()),beforeMarks=hash(db.prepare('SELECT * FROM book_marks').all());
  assert.equal(plan.cashAfter9,'802.99');assert.equal(plan.entitlements.find(e=>e.symbol==='SGOV')?.cash9,'0.6');
  assert.deepEqual(applyRepair(db,plan,evidence,reviewHash(plan),now),{applied:true,planHash:reviewHash(plan)});
  assert.equal(totalCash(db),d9('802.99'));assert.equal(settledCash(db,'2026-09-14'),d9('802.99'));assert.equal(ledgerPositions(db).get('APH'),d9('2'));
  assert.equal(getState(db,'halt:book'),'test incident');assert.equal(getState(db,'halt:mom'),'test mismatch');
  assert.equal(hash(db.prepare('SELECT * FROM fills').all()),beforeFills);assert.equal(hash(db.prepare('SELECT * FROM book_marks').all()),beforeMarks);
  assert.deepEqual(equityCurve(db).map(m=>d9str(m.equity9)),['1003.59','1003.59']);
  assert.equal(benchSeries(db,'sleeve:mom')[1].value9,d9('521.436'));
  assert.deepEqual(economicRights(db,'2026-09-14',new Map([['APH',d9('50')]])),{cash9:d9('0.6'),stock9:d9('100')});
  const after=hash(fingerprints(db));assert.equal(applyRepair(db,plan,evidence,reviewHash(plan),now).applied,false);assert.equal(hash(fingerprints(db)),after);
  assert.equal(ingestBrokerCashActivities(db,[evidence.activities.at(-1)]),0);assert.equal(totalCash(db),d9('802.99'));
  assert.throws(()=>markEquity(db,'2026-09-03',new Map()),/overwrite/);
  db.close();
});
test('wrong approval, stale evidence, changed rows and altered broker fills cannot mutate financial state',()=>{
  for(const which of ['hash','stale','changed','broker']){
    const {db,evidence}=fixture();const plan=prepareRepair(db,evidence);
    if(which==='changed')setState(db,'new-event','1');
    if(which==='broker')evidence.activities[1].qty='99';
    const before=hash(fingerprints(db));
    assert.throws(()=>applyRepair(db,plan,evidence,which==='hash'?'bad':reviewHash(plan),which==='stale'?new Date('2026-09-14T17:00:00Z'):now));
    assert.equal(hash(fingerprints(db)),before);db.close();
  }
});
test('financial review binding survives a fresh equivalent capture while retaining actual capture evidence',()=>{
  const {db,evidence}=fixture(),plan=prepareRepair(db,evidence);
  const fresh=structuredClone(evidence);fresh.observedAt='2026-09-14T17:00:00Z';fresh.activityUntil='2026-09-14T16:59:00Z';fresh.account.equity='9000';
  const refreshed=prepareRepair(db,fresh);assert.notEqual(hash(plan),hash(refreshed));assert.equal(reviewHash(plan),reviewHash(refreshed));
  assert.throws(()=>applyRepair(db,plan,evidence,reviewHash(plan),new Date('2026-09-14T17:01:00Z')),/Fresh evidence/);
  applyRepair(db,plan,fresh,reviewHash(plan),new Date('2026-09-14T17:01:00Z'));
  const row=db.prepare('SELECT plan_hash,plan_json FROM accounting_repairs').get() as any;
  assert.equal(row.plan_hash,reviewHash(plan));assert.equal(JSON.parse(row.plan_json).evidenceHash,hash(fresh));assert.equal(JSON.parse(row.plan_json).observedAt,fresh.observedAt);db.close();
  for(const field of ['cash','position','fee','status','blocked']){
    const f=fixture(),p=prepareRepair(f.db,f.evidence),changed=structuredClone(f.evidence);
    changed.observedAt='2026-09-14T17:00:00Z';
    if(field==='cash')changed.account.cash='803';
    if(field==='position')changed.positions[0].qty='4';
    if(field==='fee')changed.activities.at(-1).net_amount='-0.02';
    if(field==='status')changed.account.status='CLOSED';
    if(field==='blocked')changed.account.trading_blocked=true;
    assert.throws(()=>applyRepair(f.db,p,changed,reviewHash(p),new Date('2026-09-14T17:01:00Z')),/Financial evidence/);f.db.close();
  }
});
test('transaction failure rolls back reversals, fees, lot correction, policy and restatements',()=>{
  const {db,evidence}=fixture(),plan=prepareRepair(db,evidence);ensureAccountingTables(db);
  db.exec("CREATE TRIGGER reject_rights BEFORE INSERT ON corporate_entitlements BEGIN SELECT RAISE(ABORT,'injected'); END;");
  const before=hash(fingerprints(db));assert.throws(()=>applyRepair(db,plan,evidence,reviewHash(plan),now),/injected/);
  assert.equal(hash(fingerprints(db)),before);assert.equal(db.prepare('SELECT count(*) n FROM corporate_entitlements').get()!.n,0);db.close();
});
test('compensating reversal is idempotent, keeps source rows and refuses later activity',()=>{
  const {db,evidence}=fixture(),plan=prepareRepair(db,evidence);applyRepair(db,plan,evidence,reviewHash(plan),now);
  assert.equal(reverseRepair(db,reviewHash(plan),now),true);assert.equal(reverseRepair(db,reviewHash(plan),now),false);
  assert.equal(totalCash(db),d9('803.4'));assert.equal(ledgerPositions(db).get('APH'),d9('4'));assert.equal(getState(db,'halt:book'),'test incident');assert.equal(getState(db,'accounting:policy'),null);
  assert.equal(db.prepare("SELECT count(*) n FROM cash_events WHERE kind='dividend'").get()!.n,2);assert.equal(db.prepare("SELECT count(*) n FROM cash_events WHERE kind='fee'").get()!.n,1);db.close();
  const f=fixture(),p=prepareRepair(f.db,f.evidence);applyRepair(f.db,p,f.evidence,reviewHash(p),now);setState(f.db,'later','1');assert.throws(()=>reverseRepair(f.db,reviewHash(p),now),/activity changed/);f.db.close();
});
test('New York ex-date cutoff respects winter and summer daylight offsets',()=>{
  assert.equal(etDate('2026-09-01T03:59:59Z'),'2026-08-31');assert.equal(etDate('2026-09-01T04:00:00Z'),'2026-09-01');
  assert.equal(etDate('2026-01-05T04:59:59Z'),'2026-01-04');assert.equal(etDate('2026-01-05T05:00:00Z'),'2026-01-05');
  const {db}=fixture();assert.equal(historicalQty(db,'SGOV','2026-09-01'),d9('3'));assert.equal(historicalQty(db,'SGOV','2026-09-02'),0n);db.close();
});
test('future dividends wait; supported historical rights never create cash; conflicting terms fail closed',()=>{
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  const dv={symbol:'SGOV',exDate:'2026-09-01',perShare9:d9('0.2')};const before=totalCash(db);
  assert.equal(captureDividend(db,{...dv,exDate:'2026-10-01'},'2026-09-14'),false);assert.equal(captureDividend(db,dv,'2026-09-14'),true);
  assert.throws(()=>captureDividend(db,{...dv,perShare9:d9('0.4')},'2026-09-14'),/Conflicting/);assert.equal(totalCash(db),before);
  const r=applyDueActions(db,{exitBefore:[],forwardSplits:[],dividends:[dv],unknown:[]},'2026-09-14');assert.equal(r.splitsDeferred,0);assert.equal(r.dividendsCredited,0);assert.equal(r.dividendsDeferred,0);assert.equal(getState(db,'halt:book'),'test incident');db.close();
});
test('pre-inception dividend lookback cannot create or retain a permanent valuation hold',()=>{
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  const old={symbol:'SGOV',exDate:'2026-08-03',perShare9:d9('0.2')};
  const r=applyDueActions(db,{exitBefore:[],forwardSplits:[],dividends:[old],unknown:[]},'2026-09-14');
  assert.equal(r.dividendsDeferred,0);assert.equal(getState(db,'corp:pending:div:SGOV:2026-08-03'),null);
  setState(db,'corp:pending:div:SGOV:2026-08-03','retained legacy evidence');
  assert.equal(entitlementKnown(db,'div:SGOV:2026-08-03'),true);assert.equal(getState(db,'corp:pending:div:SGOV:2026-08-03'),'retained legacy evidence');db.close();
});
test('fees must be exact negative receipts; unmatched dividends halt without cash/entitlement mutation',()=>{
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  assert.throws(()=>ingestBrokerCashActivities(db,[{...evidence.activities.at(-1),net_amount:'-0.02'}]),/Conflicting/);
  assert.throws(()=>ingestBrokerCashActivities(db,[{id:'badfee',activity_type:'FEE',net_amount:'0.2',date:'2026-09-14'}]),/sign/);
  const cash=totalCash(db),rights=hash(db.prepare('SELECT * FROM corporate_entitlements').all());
  ingestBrokerCashActivities(db,[{id:'receipt',activity_type:'DIV',net_amount:'0.6',date:'2026-09-14'}]);assert.equal(totalCash(db),cash);assert.equal(hash(db.prepare('SELECT * FROM corporate_entitlements').all()),rights);assert.ok(getState(db,'accounting:unmatched:receipt'));db.close();
});
test('unresolved receipts stay fail-closed after a halt clear without churning retained evidence',()=>{
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  const receipt={id:'unresolved',activity_type:'DIV',net_amount:'0.6',date:'2026-09-14'};
  ingestBrokerCashActivities(db,[receipt]);
  const prior=db.prepare("SELECT * FROM state WHERE key='accounting:unmatched:unresolved'").get();
  const state=hash(db.prepare('SELECT * FROM state ORDER BY key').all());
  ingestBrokerCashActivities(db,[receipt]);assert.equal(hash(db.prepare('SELECT * FROM state ORDER BY key').all()),state);
  clearState(db,'halt:book');ingestBrokerCashActivities(db,[receipt]);assert.match(getState(db,'halt:book')!,/entitlement settlement requires review/);
  assert.deepEqual(db.prepare("SELECT * FROM state WHERE key='accounting:unmatched:unresolved'").get(),prior);
  assert.throws(()=>ingestBrokerCashActivities(db,[{...receipt,net_amount:'9'}]),/evidence changed/);db.close();
});
test('changed as-reported historical mark invalidates the overlay instead of returning stale equity',()=>{
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  db.prepare("UPDATE book_marks SET equity9='999' WHERE date='2026-09-02'").run();assert.throws(()=>equityCurve(db),/source changed/);db.close();
});
test('late fees restate historical book and sleeve cash at canonical allocation precision and update the brake peak',()=>{
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  const original=hash(db.prepare('SELECT * FROM book_marks').all());
  const fee={id:'late',activity_type:'FEE',net_amount:'-0.02',date:'2026-09-02'};
  assert.equal(ingestBrokerCashActivities(db,[fee]),1);assert.equal(ingestBrokerCashActivities(db,[fee]),0);
  assert.equal(totalCash(db),d9('802.97'));assert.deepEqual(equityCurve(db).map(r=>d9str(r.equity9)),['1003.57','1003.57']);
  assert.equal(benchSeries(db,'sleeve:mom')[1].value9,d9('521.428'));assert.equal(getState(db,'brake:peak9'),d9('1003.57').toString());
  assert.equal(hash(db.prepare('SELECT * FROM book_marks').all()),original);
  db.prepare("UPDATE book_marks SET equity9='999' WHERE date='2026-09-02'").run();
  assert.throws(()=>ingestBrokerCashActivities(db,[{...fee,id:'later'}]),/source changed/);assert.equal(totalCash(db),d9('802.97'));db.close();
});
test('late historical dividend capture restates economics without affecting spendable cash',()=>{
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  // The earlier holding existed before Aug 31, although fully sold on Sep 1.
  const dv={symbol:'SGOV',exDate:'2026-08-31',perShare9:d9('0.1')};
  assert.equal(captureDividend(db,dv,'2026-09-14'),true);assert.equal(captureDividend(db,dv,'2026-09-14'),true);
  assert.equal(totalCash(db),d9('802.99'));assert.deepEqual(equityCurve(db).map(r=>d9str(r.equity9)),['1003.89','1003.89']);db.close();
});
test('same-day reruns reject late fee/right overlay sources before changing marks, rights or benchmarks',()=>{
  for(const kind of ['fee','right']){
    const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
    const prices=new Map([['APH',d9('50')]]);
    markEquity(db,'2026-09-14',prices);recordBench(db,'2026-09-14','sleeve:mom',d9('521.436'));
    if(kind==='fee')ingestBrokerCashActivities(db,[{id:'today-late-fee',activity_type:'FEE',net_amount:'-0.01',date:'2026-09-14'}]);
    else captureDividend(db,{symbol:'SGOV',exDate:'2026-08-31',perShare9:d9('0.1')},'2026-09-14');
    const expected=kind==='fee'?'1003.58':'1003.89';
    assert.equal(equityCurve(db).at(-1)!.equity9,d9(expected));
    const before=hash(fingerprints(db,['book_marks','bench_marks','accounting_mark_rights','accounting_cash_overlays']));
    assert.throws(()=>markEquity(db,'2026-09-14',prices),/cash-overlay source mark/);
    assert.throws(()=>recordBench(db,'2026-09-14','sleeve:mom',d9('400')),/cash-overlay source benchmark/);
    assert.equal(hash(fingerprints(db,['book_marks','bench_marks','accounting_mark_rights','accounting_cash_overlays'])),before);
    assert.equal(equityCurve(db).at(-1)!.equity9,d9(expected));
    assert.equal(benchSeries(db,'sleeve:mom').at(-1)!.value9,d9(kind==='fee'?'521.432':'521.556'));
    db.close();
  }
});
test('repair refuses inherited derived epochs and reverse refuses later derived marks',()=>{
  const f=fixture();ensureAccountingTables(f.db);f.db.prepare('INSERT INTO accounting_mark_rights VALUES(?,?,?,?)').run('2026-09-01','1','0','{}');
  assert.throws(()=>prepareRepair(f.db,f.evidence),/derived accounting epoch/);f.db.close();
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  markEquity(db,'2026-09-14',new Map([['APH',d9('50')]]));const cash=totalCash(db);
  assert.throws(()=>reverseRepair(db,reviewHash(p),now),/activity changed/);assert.equal(totalCash(db),cash);db.close();
});
{
  const savedFetch=globalThis.fetch,savedId=process.env.ALPACA_API_KEY,savedSecret=process.env.ALPACA_API_SECRET;
  process.env.ALPACA_API_KEY='offline-test';process.env.ALPACA_API_SECRET='offline-test';
  try{
    const urls:URL[]=[];
    globalThis.fetch=async input=>{
      const url=new URL(String(input));urls.push(url);
      assert.equal(url.searchParams.get('category'),'non_trade_activity');assert.equal(url.searchParams.has('activity_types'),false);assert.equal(url.searchParams.get('after'),'2026-08-10T00:00:00Z');
      const body=urls.length===1?Array.from({length:100},(_,i)=>({id:`fee-${i}`,activity_type:'FEE',net_amount:'-0.01',date:'2026-09-01'})):[{id:'future-kind',activity_type:'NEW_NONTRADE_TYPE'}];
      return new Response(JSON.stringify(body),{status:200});
    };
    const items=await alpacaReadPort.getCashActivities!('2026-08-10');assert.equal(items.length,101);assert.equal(items.at(-1).activity_type,'NEW_NONTRADE_TYPE');assert.equal(urls[1].searchParams.get('page_token'),'fee-99');
    globalThis.fetch=async()=>new Response(JSON.stringify([{id:'fill',activity_type:'FILL'}]),{status:200});
    await assert.rejects(()=>alpacaReadPort.getCashActivities!('2026-08-10'),/filter was not honored/);
    let pages=0;globalThis.fetch=async()=>new Response(JSON.stringify(Array.from({length:100},(_,i)=>({id:`p${pages}-${i}`,activity_type:'FEE',net_amount:'-0.01',date:'2026-09-01'}))).replace(/p\d+-/g,`p${pages++}-`),{status:200});
    await assert.rejects(()=>alpacaReadPort.getCashActivities!('2026-08-10'),/pagination incomplete/);assert.equal(pages,50);
    checks++;console.log('✓ nontrade adapter filters fills, bounds inception, retains unknown types and refuses incomplete pagination');
  }finally{
    globalThis.fetch=savedFetch;if(savedId===undefined)delete process.env.ALPACA_API_KEY;else process.env.ALPACA_API_KEY=savedId;
    if(savedSecret===undefined)delete process.env.ALPACA_API_SECRET;else process.env.ALPACA_API_SECRET=savedSecret;
  }
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);clearState(db,'halt:book');
  const port={getFillActivities:async()=>[],getCashActivities:async()=>{throw Error('Broker cash activity pagination incomplete');},getAccount:async()=>evidence.account,getPositions:async()=>evidence.positions,getSessions:async()=>[]};
  await assert.rejects(()=>replayFills(db,port),/pagination incomplete/);assert.match(getState(db,'halt:book')!,/nontrade activity pagination limit/);
  const state=hash(db.prepare('SELECT * FROM state ORDER BY key').all());await assert.rejects(()=>replayFills(db,port));assert.equal(hash(db.prepare('SELECT * FROM state ORDER BY key').all()),state);db.close();checks++;console.log('✓ pagination failure latches a specific non-churning accounting halt');
}
{
  const {db,evidence}=fixture(),p=prepareRepair(db,evidence);applyRepair(db,p,evidence,reviewHash(p),now);
  const result=await reconcileBoot(db,{submit:async()=>{throw Error('no order');},queryByClientOrderId:async()=>null,getOpenOrders:async()=>[],cancelOrder:async()=>{throw Error('no cancel');}},
    {getFillActivities:async()=>[],getCashActivities:async()=>evidence.activities.filter(r=>r.activity_type!=='FILL'),getSessions:async()=>[],getPositions:async()=>evidence.positions,getAccount:async()=>({cash:'700'})},{now});
  assert.equal(result.ok,false);assert.ok(result.notes.some(n=>n.includes('Execution cash reconciliation failed')));checks++;console.log('✓ unexplained execution cash delta fails reconciliation');
  let requested:string[]=[];await nightlyCorpPoll(db,{announcements:async(s)=>{requested=s;return [];}},{today:'2026-09-14'});assert.ok(requested.includes('SGOV'));checks++;console.log('✓ sold symbols remain in historical corporate-action polling');db.close();
}
console.log(`Accounting repair: ${checks} scenarios passed`);
