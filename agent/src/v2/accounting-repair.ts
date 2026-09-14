// Bounded incident repair. Plans are pure/read-only; application requires the exact reviewed hash,
// fresh stable paper evidence, unchanged financial rows and a standing book halt. No broker writes.
import type { DatabaseSync } from 'node:sqlite';
import { d9,d9str,mul9,div9,type D9 } from './decimal.js';
import { getState,setState,clearState } from './db.js';
import { recordCash,totalCash } from './settled-cash.js';
import { ACCOUNTING_POLICY,hash,ensureAccountingTables,putEntitlement,historicalQty,etDate,ingestBrokerCashActivities,type Entitlement } from './accounting.js';

const CAPTURE_TABLES=['fills','lots','disposals','cash_events','state','book_marks','order_intents'];
const GUARD_TABLES=[...CAPTURE_TABLES,'bench_marks','wash_links','approvals','position_meta'];
const REPAIR_ID='2026-09-corporate-accounting-v1';
const AFTER_TABLES=[...GUARD_TABLES,'corporate_entitlements','accounting_marks','accounting_mark_rights','accounting_cash_overlays'];
function rows(db:DatabaseSync,table:string):any[]{return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();}
function requireThat(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}
export function fingerprints(db:DatabaseSync,tables=GUARD_TABLES):Record<string,string>{
  return Object.fromEntries(tables.map(t=>[t,hash(rows(db,t))]));
}
function cents(v:D9):D9 {return (v<0n?-1n:1n)*(((v<0n?-v:v)+5_000_000n)/10_000_000n)*10_000_000n;}
export interface RepairEvidence {
  observedAt:string;activityUntil:string;complete:boolean;stable:boolean;
  before:Record<string,string>;after:Record<string,string>;
  account:{cash:string};positions:{symbol:string;qty:string}[];activities:any[];
  openOrders:any[];
  actions:{corporate_actions:Record<string,any[]>;next_page_token?:string|null};
}
interface MarkCorrection {date:string;series:string;sourceHash:string;execution9:string;economic9:string;evidence:unknown;}
export interface RepairPlan {
  id:string;policy:string;observedAt:string;evidenceHash:string;before:Record<string,string>;
  historyFrom:string;seedActivityId:string;cashBefore9:string;cashAfter9:string;brokerCash9:string;roundingResidue9:string;
  reversals:{source:any;ref:string}[];fees:any[];lots:{before:any;qty9:string}[];entitlements:Entitlement[];
  marks:MarkCorrection[];brakePeakBefore:string|null;brakePeakAfter:string;stateBefore:Record<string,string|null>;
}

export function prepareRepair(db:DatabaseSync,e:RepairEvidence):RepairPlan {
  requireThat(e.complete&&e.stable&&hash(e.before)===hash(e.after),'Evidence not complete/stable');
  requireThat(Array.isArray(e.openOrders)&&e.openOrders.length===0,'Open-order read must confirm no pending orders');
  requireThat(hash(fingerprints(db,CAPTURE_TABLES))===hash(e.before),'Snapshot differs from broker capture');
  requireThat(!getState(db,'accounting:policy'),'Accounting policy already enabled');
  requireThat(getState(db,'halt:book'),'Standing book halt required');
  const fills=rows(db,'fills'),cash=rows(db,'cash_events'),lots=rows(db,'lots');
  const seed=cash.filter(r=>r.kind==='seed');requireThat(seed.length===1,'Exactly one inception seed required');
  const historyFrom=seed[0].settles_on;
  requireThat(historyFrom==='2026-08-10','This incident capture must cover book inception');
  const brokerFills=e.activities.filter(r=>r.activity_type==='FILL');
  const ids=new Set(e.activities.map(r=>r.id));requireThat(e.activities.every(r=>typeof r.id==='string'&&r.id.length>0)&&ids.size===e.activities.length,'Duplicate/missing broker activity ID');
  requireThat(brokerFills.length===fills.length,'Incomplete fill history');
  for(const f of fills){
    const a=brokerFills.find(r=>r.id===f.id);requireThat(a,'Unmatched fill');
    requireThat(a.symbol===f.symbol&&a.side===f.side&&a.transaction_time===f.ts&&d9(a.qty)===d9(f.qty9)&&d9(a.price)===d9(f.price9),'Fill differs from broker');
    const c=cash.filter(r=>r.ref===f.id);requireThat(c.length===1&&c[0].kind===f.side&&d9(c[0].amount9)===(f.side==='buy'?-1n:1n)*mul9(d9(f.qty9),d9(f.price9)),'Trade cash differs from fill');
  }
  const journals=e.activities.filter(r=>r.activity_type==='JNLC');
  requireThat(journals.length===1&&String(journals[0].date).slice(0,10)===historyFrom&&d9(journals[0].net_amount)===d9(seed[0].amount9),'Inception journal not matched');
  requireThat(e.activities.every(r=>['FILL','FEE','JNLC'].includes(r.activity_type)),'New receipt/delivery requires separate review');
  requireThat(cash.every(r=>['seed','buy','sell','dividend'].includes(r.kind)),'Unexpected existing cash correction/fee');
  const credits=cash.filter(r=>r.kind==='dividend');requireThat(credits.length<=12,'Too many legacy credits for bounded attribution');
  const fees=e.activities.filter(r=>r.activity_type==='FEE');
  requireThat(fees.every(r=>d9(r.net_amount)<0n&&!cash.some(c=>c.ref===r.id)),'Fee already recognized or invalid');
  const groups=e.actions.corporate_actions;
  requireThat(!e.actions.next_page_token&&Object.entries(groups).every(([k,v])=>Array.isArray(v)&&(['cash_dividends','forward_splits'].includes(k)||v.length===0)),'Unsupported/incomplete corporate announcements');
  const today=etDate(e.observedAt),entitlements:Entitlement[]=[],lotCorrections:RepairPlan['lots']=[];
  const dividendGroups=new Map<string,any[]>();
  for(const a of groups.cash_dividends??[]){
    if(a.ex_date<historyFrom||a.ex_date>today)continue;
    const k=`div:${a.symbol}:${a.ex_date}`;dividendGroups.set(k,[...(dividendGroups.get(k)??[]),a]);
  }
  for(const [id,anns] of dividendGroups){
    const a=anns[0],qty=historicalQty(db,a.symbol,a.ex_date);
    requireThat(qty===0n||anns.length===1,'Ambiguous distribution components require review');
    requireThat(d9(String(a.rate))>0n,'Invalid distribution rate');
    requireThat(!(groups.forward_splits??[]).some(s=>s.symbol===a.symbol&&s.ex_date<=a.ex_date),'Post-split dividend requires adjusted history');
    entitlements.push({id,kind:'dividend',symbol:a.symbol,exDate:a.ex_date,eligibleQty9:d9str(qty),cash9:d9str(mul9(qty,d9(String(a.rate)))),extraQty9:'0',sleeve:null,evidence:{announcements:anns,activityEvidence:hash(e.activities),historicalFills:hash(fills.filter(f=>f.symbol===a.symbol))}});
  }
  for(const c of credits) requireThat(entitlements.some(r=>r.id===c.ref),'Legacy credit has no reviewed announcement');
  for(const a of groups.forward_splits??[]){
    if(a.ex_date<historyFrom||a.ex_date>today)continue;
    const num=d9(String(a.new_rate)),den=d9(String(a.old_rate));requireThat(num>den&&den>0n,'Not a forward split');
    const eligible=historicalQty(db,a.symbol,a.ex_date);
    if(eligible===0n)continue;
    const affected=lots.filter(l=>l.symbol===a.symbol);
    requireThat(affected.length===1,'Multi-lot split repair requires separate allocation review');
    const lot=affected[0],fill=fills.find(f=>f.id===lot.open_fill_id);
    requireThat(fill&&fill.side==='buy'&&d9(fill.qty9)===eligible&&d9(lot.qty_open9)===d9(lot.qty_remaining9),'Split lot has disposals or mixed history');
    requireThat(rows(db,'disposals').every(r=>r.lot_id!==lot.lot_id),'Split lot has disposals');
    const adjusted=div9(mul9(eligible,num),den);
    requireThat(d9(lot.qty_open9)===adjusted&&d9(lot.basis_total9)===mul9(d9(fill.qty9),d9(fill.price9))&&d9(lot.basis_remaining9)===d9(lot.basis_total9)&&d9(lot.wash_adj_basis9)===0n,'Split before-image inconsistent');
    requireThat(getState(db,`corp:applied:${a.symbol}:${a.ex_date}`)&&getState(db,`split_stale:${a.symbol}`),'Missing legacy split provenance');
    lotCorrections.push({before:lot,qty9:fill.qty9});
    entitlements.push({id:`split:${a.symbol}:${a.ex_date}`,kind:'split',symbol:a.symbol,exDate:a.ex_date,eligibleQty9:d9str(eligible),cash9:'0',extraQty9:d9str(adjusted-eligible),sleeve:lot.sleeve,evidence:{announcement:a,beforeLot:lot,brokerPosition:e.positions.find(p=>p.symbol===a.symbol),activityEvidence:hash(e.activities)}});
  }
  // Every execution position must agree with raw signed fills and the proposed surviving lots.
  const symbols=new Set([...fills.map(f=>f.symbol),...e.positions.map(p=>p.symbol)]);
  for(const symbol of symbols){
    const raw=fills.filter(f=>f.symbol===symbol).reduce((s,f)=>s+(f.side==='buy'?1n:-1n)*d9(f.qty9),0n);
    const broker=e.positions.filter(p=>p.symbol===symbol);requireThat(broker.length<=1,'Duplicate broker symbol');
    const expected=broker.length?d9(broker[0].qty):0n;
    const ledger=lots.filter(l=>l.symbol===symbol).reduce((s,l)=>s+d9(lotCorrections.find(c=>c.before.lot_id===l.lot_id)?.qty9??l.qty_remaining9),0n);
    requireThat(raw===expected&&ledger===expected,'Proposed execution positions do not reconcile');
  }
  const reversed=credits.reduce((s,r)=>s+d9(r.amount9),0n),feeTotal=fees.reduce((s,r)=>s+d9(r.net_amount),0n);
  const cashAfter=totalCash(db)-reversed+feeTotal,brokerCash=d9(e.account.cash);
  requireThat(cents(cashAfter)===brokerCash,'Cash does not reconcile at broker cent precision');
  const marks=buildRestatements(db,cash,fees,fills,entitlements);
  const peak=marks.filter(m=>m.series==='book').reduce((p,m)=>d9(m.economic9)>p?d9(m.economic9):p,0n);
  requireThat(getState(db,'brake:tier')==='0','Nonzero brake tier requires independent policy review');
  const stateKeys=['accounting:policy','accounting:history-from','accounting:history-evidence','accounting:seed-activity-id','brake:peak9'];
  return {id:REPAIR_ID,policy:ACCOUNTING_POLICY,observedAt:e.observedAt,evidenceHash:hash(e),before:fingerprints(db),historyFrom,seedActivityId:journals[0].id,
    cashBefore9:d9str(totalCash(db)),cashAfter9:d9str(cashAfter),brokerCash9:d9str(brokerCash),roundingResidue9:d9str(cashAfter-brokerCash),
    reversals:credits.map(source=>({source,ref:`repair:${REPAIR_ID}:credit:${source.id}`})),fees,lots:lotCorrections,entitlements,marks,
    brakePeakBefore:getState(db,'brake:peak9'),brakePeakAfter:peak.toString(),stateBefore:Object.fromEntries(stateKeys.map(k=>[k,getState(db,k)]))};
}

function buildRestatements(db:DatabaseSync,cash:any[],fees:any[],fills:any[],entitlements:Entitlement[]):MarkCorrection[]{
  const out:MarkCorrection[]=[];
  const credits=cash.filter(r=>r.kind==='dividend');
  for(const mark of rows(db,'book_marks')){
    const executionCash=cash.filter(r=>r.kind!=='dividend'&&(r.kind==='seed'?r.settles_on<=mark.date:etDate(r.ts)<=mark.date)).reduce<D9>((s,r)=>s+d9(r.amount9),0n)
      +fees.filter(r=>String(r.date).slice(0,10)<=mark.date).reduce<D9>((s,r)=>s+d9(r.net_amount),0n);
    const datedFees=fees.filter(r=>String(r.date).slice(0,10)<=mark.date).reduce<D9>((s,r)=>s+d9(r.net_amount),0n);
    const legacyInclusion=d9(mark.cash9)-(executionCash-datedFees);
    const matches:number[][]=[];
    for(let mask=0;mask<2**credits.length;mask++){
      const included=credits.filter((_,i)=>mask&(2**i));
      if(included.every(r=>r.settles_on<=mark.date)&&included.reduce((s,r)=>s+d9(r.amount9),0n)===legacyInclusion)matches.push(included.map(r=>r.id));
    }
    requireThat(matches.length===1,'Historical cash credit attribution ambiguous');
    const original=JSON.parse(mark.positions_json) as any[];
    requireThat(d9(mark.equity9)===d9(mark.cash9)+original.reduce((s,p)=>s+d9(p.value9),0n),'Original mark does not sum');
    let executionValue=0n,stockRights=0n;
    const prices=new Map<string,D9>();
    const datedFills=fills.filter(f=>etDate(f.ts)<=mark.date);
    for(const p of original){
      const qty=datedFills.filter(f=>f.symbol===p.symbol).reduce((s,f)=>s+(f.side==='buy'?1n:-1n)*d9(f.qty9),0n);
      const entitlement=entitlements.find(e=>e.kind==='split'&&e.symbol===p.symbol&&e.exDate<=mark.date);
      requireThat(d9(p.qty9)===qty+(entitlement?d9(entitlement.extraQty9):0n),'Historical position is not explained by fills/split');
      const px=d9(p.price9);prices.set(p.symbol,px);
      requireThat(d9(p.value9)===mul9(d9(p.qty9),px),'Original position mark does not multiply');
      executionValue+=mul9(qty,px);if(entitlement)stockRights+=mul9(d9(entitlement.extraQty9),px);
    }
    for(const symbol of new Set(datedFills.map(f=>f.symbol))){
      const qty=datedFills.filter(f=>f.symbol===symbol).reduce((s,f)=>s+(f.side==='buy'?1n:-1n)*d9(f.qty9),0n);
      requireThat(qty===0n||prices.has(symbol),'Missing historical price');
    }
    const cashRights=entitlements.filter(e=>e.exDate<=mark.date).reduce((s,e)=>s+d9(e.cash9),0n);
    out.push({date:mark.date,series:'book',sourceHash:hash(mark),execution9:d9str(executionCash+executionValue),economic9:d9str(executionCash+executionValue+cashRights+stockRights),evidence:{cash9:d9str(executionCash),cashEntitlements9:d9str(cashRights),stockEntitlements9:d9str(stockRights),includedLegacyCreditIds:matches[0],datedFees9:d9str(datedFees)}});
    // Reproduce the existing sleeve cash-allocation convention at D9 precision. Historical lot
    // values are derived from each sleeve's signed fills, not today's remaining holdings.
    for(const [sleeve,weight] of Object.entries({mom:'0.4',ins:'0.25',anc:'0.25',wld:'0.1'})){
      let value=0n;
      for(const [symbol,px] of prices){
        const qty=datedFills.filter(f=>f.side==='buy'&&f.symbol===symbol&&f.sleeve===sleeve).reduce<D9>((s,f)=>s+d9(f.qty9),0n)
          -rows(db,'disposals').filter(d=>d.symbol===symbol&&d.sleeve===sleeve&&etDate(d.close_ts)<=mark.date).reduce<D9>((s,d)=>s+d9(d.qty9),0n);
        requireThat(qty>=0n,'Unattributed historical sleeve disposal');value+=mul9(qty,px);
      }
      const prior=db.prepare('SELECT * FROM bench_marks WHERE date=? AND series=?').get(mark.date,`sleeve:${sleeve}`) as any;
      if(!prior)continue;
      const extra=entitlements.filter(e=>e.kind==='split'&&e.exDate<=mark.date&&e.sleeve===sleeve).reduce((s,e)=>s+mul9(d9(e.extraQty9),prices.get(e.symbol)!),0n);
      // Combined-vs-separate fractional lot valuation can differ by one D9 unit. Preserve the
      // existing sleeve's recorded position value and adjust cash exactly; the split's economic
      // value was already included in that old series.
      const oldPositionValue=d9(prior.value9)-mul9(d9(mark.cash9),d9(weight));
      const error=oldPositionValue-(value+extra);
      requireThat(error>=-100n&&error<=100n,`Historical sleeve mark cannot be reconstructed (${mark.date}, ${sleeve}, residue ${d9str(error)})`);
      out.push({date:mark.date,series:`sleeve:${sleeve}`,sourceHash:hash(prior),execution9:d9str(value+mul9(executionCash,d9(weight))),economic9:d9str(value+extra+mul9(executionCash+cashRights,d9(weight))),evidence:{sourcePositionRoundingResidue9:d9str(error)}});
    }
  }
  return out;
}

export function applyRepair(db:DatabaseSync,plan:RepairPlan,e:RepairEvidence,approvedHash:string,now=new Date()):{applied:boolean;planHash:string}{
  requireThat(hash(plan)===approvedHash,'Exact reviewed plan hash required');
  ensureAccountingTables(db);
  const prior=db.prepare('SELECT plan_hash,reversed_ts FROM accounting_repairs WHERE id=?').get(plan.id) as any;
  if(prior){requireThat(prior.plan_hash===approvedHash&&!prior.reversed_ts,'Repair ID conflict');return {applied:false,planHash:approvedHash};}
  const age=now.getTime()-Date.parse(e.observedAt);
  requireThat(age>=0&&age<=10*60_000,'Fresh evidence within ten minutes required');
  requireThat(hash(e)===plan.evidenceHash,'Evidence hash differs');
  db.exec('BEGIN IMMEDIATE');
  try{
    requireThat(hash(fingerprints(db))===hash(plan.before),'Financial rows changed; recapture and re-review');
    requireThat(hash(prepareRepair(db,e))===approvedHash,'Plan does not match independently derived repair');
    for(const r of plan.reversals)requireThat(recordCash(db,{ts:now.toISOString(),kind:'adjust',symbol:r.source.symbol,amount9:-d9(r.source.amount9),settlesOn:etDate(now.toISOString()),ref:r.ref,note:`Reverse unsupported cash credit ${r.source.id}; evidence ${plan.evidenceHash}`}), 'Reversal already exists');
    // Fee ingestion requires policy only inside this transaction; any failure rolls everything back.
    setState(db,'accounting:policy',ACCOUNTING_POLICY);
    ingestBrokerCashActivities(db,plan.fees,{restating:true});
    for(const l of plan.lots)db.prepare('UPDATE lots SET qty_open9=?,qty_remaining9=? WHERE lot_id=?').run(l.qty9,l.qty9,l.before.lot_id);
    for(const e of plan.entitlements)putEntitlement(db,e);
    for(const m of plan.marks)db.prepare('INSERT INTO accounting_marks(repair_id,date,series,source_hash,execution9,economic9,evidence_json) VALUES(?,?,?,?,?,?,?)').run(plan.id,m.date,m.series,m.sourceHash,m.execution9,m.economic9,JSON.stringify(m.evidence));
    setState(db,'accounting:history-from',plan.historyFrom);setState(db,'accounting:history-evidence',plan.evidenceHash);
    setState(db,'accounting:seed-activity-id',plan.seedActivityId);
    setState(db,'brake:peak9',plan.brakePeakAfter);
    requireThat(totalCash(db)===d9(plan.cashAfter9),'Post-repair cash differs');
    db.prepare('INSERT INTO accounting_repairs(id,plan_hash,plan_json,applied_ts,after_hash) VALUES(?,?,?,?,?)').run(plan.id,approvedHash,JSON.stringify(plan),now.toISOString(),hash(fingerprints(db,AFTER_TABLES)));
    db.exec('COMMIT');return {applied:true,planHash:approvedHash};
  }catch(e){db.exec('ROLLBACK');throw e;}
}

/** Immediate compensating rollback ONLY while every post-apply financial/evidence row is frozen.
 *  The original credits, fee receipts, split markers, fills and marks are retained; inverse cash
 *  entries and the repair journal explain the reversal. Later activity needs a new reviewed plan. */
export function reverseRepair(db:DatabaseSync,approvedHash:string,now=new Date()):boolean{
  ensureAccountingTables(db);
  db.exec('BEGIN IMMEDIATE');
  try{
    const r=db.prepare('SELECT * FROM accounting_repairs WHERE id=?').get(REPAIR_ID) as any;
    requireThat(r&&r.plan_hash===approvedHash,'Exact applied plan hash required');
    if(r.reversed_ts){db.exec('COMMIT');return false;}
    requireThat(getState(db,'halt:book'),'Rollback requires standing book halt');
    requireThat(hash(fingerprints(db,AFTER_TABLES))===r.after_hash,'Post-repair activity changed; automatic inverse refused');
    const p=JSON.parse(r.plan_json) as RepairPlan;
    for(const c of p.reversals)requireThat(recordCash(db,{ts:now.toISOString(),kind:'adjust',symbol:c.source.symbol,amount9:d9(c.source.amount9),settlesOn:etDate(now.toISOString()),ref:`inverse:${c.ref}`,note:`Compensating inverse of ${c.ref}`}), 'Inverse already exists');
    for(const fee of p.fees)requireThat(recordCash(db,{ts:now.toISOString(),kind:'adjust',amount9:-d9(fee.net_amount),settlesOn:etDate(now.toISOString()),ref:`inverse:${p.id}:fee:${fee.id}`,note:'Compensating inverse; original broker fee evidence retained'}), 'Fee inverse already exists');
    for(const l of p.lots)db.prepare('UPDATE lots SET qty_open9=?,qty_remaining9=? WHERE lot_id=?').run(l.before.qty_open9,l.before.qty_remaining9,l.before.lot_id);
    for(const e of p.entitlements)db.prepare("UPDATE corporate_entitlements SET status='void' WHERE id=?").run(e.id);
    for(const [key,value] of Object.entries(p.stateBefore))if(value===null)clearState(db,key);else setState(db,key,value);
    requireThat(totalCash(db)===d9(p.cashBefore9),'Inverse cash does not match original');
    db.prepare('UPDATE accounting_repairs SET reversed_ts=? WHERE id=?').run(now.toISOString(),p.id);
    db.exec('COMMIT');return true;
  }catch(e){db.exec('ROLLBACK');throw e;}
}
