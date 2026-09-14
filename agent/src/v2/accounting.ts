// Executable cash/lots and undelivered economic rights are deliberately separate.
// Only reviewed evidence can enable this policy. Nothing here places orders or clears halts.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { d9, d9str, mul9, type D9 } from './decimal.js';
import { getState, setState } from './db.js';
import { recordCash } from './settled-cash.js';

export const ACCOUNTING_POLICY = 'broker-execution-entitlements-v1';
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Stable financial identity across raw REST row key order and additive provider metadata. */
export function brokerActivityHash(row:any):string {
  return hash(Object.fromEntries(['id','activity_type','activity_subtype','date','symbol','net_amount','qty','per_share_amount'].map(key=>[key,row[key]??null])));
}
export function accountingEnabled(db: DatabaseSync): boolean { return getState(db, 'accounting:policy') === ACCOUNTING_POLICY; }
export function ensureAccountingTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS corporate_entitlements (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dividend','split')),
      symbol TEXT NOT NULL, ex_date TEXT NOT NULL, eligible_qty9 TEXT NOT NULL,
      cash9 TEXT NOT NULL, extra_qty9 TEXT NOT NULL, sleeve TEXT,
      evidence_json TEXT NOT NULL, evidence_hash TEXT NOT NULL, created_ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'outstanding' CHECK(status IN ('outstanding','void'))
    );
    CREATE TABLE IF NOT EXISTS accounting_repairs (
      id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
      applied_ts TEXT NOT NULL, after_hash TEXT NOT NULL, reversed_ts TEXT
    );
    CREATE TABLE IF NOT EXISTS accounting_marks (
      repair_id TEXT NOT NULL, date TEXT NOT NULL, series TEXT NOT NULL,
      source_hash TEXT NOT NULL, execution9 TEXT NOT NULL, economic9 TEXT NOT NULL,
      evidence_json TEXT NOT NULL, PRIMARY KEY(repair_id,date,series)
    );
    CREATE TABLE IF NOT EXISTS accounting_mark_rights (
      date TEXT PRIMARY KEY, cash_rights9 TEXT NOT NULL, stock_rights9 TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounting_cash_overlays (
      source_id TEXT NOT NULL, date TEXT NOT NULL, series TEXT NOT NULL,
      source_hash TEXT NOT NULL, delta9 TEXT NOT NULL,
      PRIMARY KEY(source_id,date,series)
    );
    CREATE TABLE IF NOT EXISTS entitlement_settlements (
      entitlement_id TEXT PRIMARY KEY REFERENCES corporate_entitlements(id),
      activity_id TEXT NOT NULL UNIQUE, activity_hash TEXT NOT NULL,
      effective_date TEXT NOT NULL, cash9 TEXT NOT NULL, qty9 TEXT NOT NULL,
      plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL, applied_ts TEXT NOT NULL
    );
  `);
}

export interface Entitlement {
  id: string; kind: 'dividend' | 'split'; symbol: string; exDate: string;
  eligibleQty9: string; cash9: string; extraQty9: string; sleeve: string | null; evidence: unknown;
}
export function putEntitlement(db: DatabaseSync, e: Entitlement): boolean {
  ensureAccountingTables(db);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(e.exDate)||new Date(e.exDate+'T12:00:00Z').toISOString().slice(0,10)!==e.exDate
    ||d9(e.cash9)<0n||d9(e.extraQty9)<0n||d9(e.eligibleQty9)<0n)throw new Error('Invalid entitlement dimensions');
  const old = db.prepare('SELECT * FROM corporate_entitlements WHERE id=?').get(e.id) as any;
  if (old) {
    if (old.status !== 'outstanding' || old.kind !== e.kind || old.symbol !== e.symbol || old.ex_date !== e.exDate
      || d9(old.eligible_qty9) !== d9(e.eligibleQty9) || d9(old.cash9) !== d9(e.cash9)
      || d9(old.extra_qty9) !== d9(e.extraQty9) || old.sleeve !== e.sleeve) throw new Error('Conflicting entitlement evidence; operator review required');
    return false;
  }
  db.prepare(`INSERT INTO corporate_entitlements(id,kind,symbol,ex_date,eligible_qty9,cash9,extra_qty9,sleeve,evidence_json,evidence_hash,created_ts)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(e.id,e.kind,e.symbol,e.exDate,d9str(d9(e.eligibleQty9)),d9str(d9(e.cash9)),d9str(d9(e.extraQty9)),e.sleeve,JSON.stringify(e.evidence),hash(e.evidence),new Date().toISOString());
  return true;
}
export function entitlementKnown(db: DatabaseSync, id: string): boolean {
  if (!accountingEnabled(db)) return false;
  const dividend=/^div:[^:]+:(\d{4}-\d{2}-\d{2})$/.exec(id);
  const from=getState(db,'accounting:history-from');
  // The reviewed inception proof establishes a new, initially empty book. Earlier ex-dates
  // have no entitlement in this book and must not become permanent pending valuation gates.
  if(dividend&&from&&dividend[1]<from)return true;
  ensureAccountingTables(db);
  return !!db.prepare("SELECT 1 FROM corporate_entitlements WHERE id=? AND status='outstanding'").get(id);
}

/** Date-only comparisons must use New York, including DST; ex-date purchases are ineligible. */
export function etDate(ts: string): string {
  const time = new Date(ts);
  if (!Number.isFinite(time.getTime()) || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(ts)) throw new Error('Invalid timestamp');
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);
}
export function historicalQty(db: DatabaseSync, symbol: string, exDate: string): D9 {
  const rows = db.prepare('SELECT side,qty9,ts FROM fills WHERE symbol=? ORDER BY ts,id').all(symbol) as any[];
  const events=rows.map(r=>({date:etDate(r.ts),order:r.ts,qty:r.side==='buy'?d9(r.qty9):-d9(r.qty9)}));
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='entitlement_settlements'").get()) {
    const deliveries=db.prepare(`SELECT s.qty9,s.effective_date FROM entitlement_settlements s JOIN corporate_entitlements e ON e.id=s.entitlement_id
      WHERE e.symbol=? AND s.effective_date<?`).all(symbol,exDate) as any[];
    events.push(...deliveries.map(r=>({date:r.effective_date,order:'',qty:d9(r.qty9)})));
  }
  let qty=0n;
  for(const event of events.sort((a,b)=>a.date.localeCompare(b.date)||a.order.localeCompare(b.order)))if(event.date<exDate){qty+=event.qty;if(qty<0n)throw Error('Incomplete historical holdings');}
  return qty;
}

export function outstandingSplit(db:DatabaseSync,symbol:string):boolean {
  if(!accountingEnabled(db))return false;
  ensureAccountingTables(db);
  return !!db.prepare(`SELECT 1 FROM corporate_entitlements e WHERE e.kind='split' AND e.symbol=? AND e.status='outstanding'
    AND NOT EXISTS(SELECT 1 FROM entitlement_settlements s WHERE s.entitlement_id=e.id)`).get(symbol);
}

/** Clearing a halt or a feed reverting to old terms does not resolve contradictory evidence. */
export function containAccountingConflicts(db:DatabaseSync):void {
  if(db.prepare("SELECT 1 FROM state WHERE key GLOB 'corp:conflict:*' OR key GLOB 'accounting:receipt-conflict:*'").get()
    &&!getState(db,'halt:book'))setState(db,'halt:book','Unresolved accounting evidence conflict; separate reviewed resolution required');
}

/** Capture a right, NEVER a receipt. Complex distributions and any earlier split remain gated. */
export function captureDividend(db: DatabaseSync, dv: {symbol:string;exDate:string;perShare9:D9}, today: string): boolean {
  if (!accountingEnabled(db) || dv.exDate > today) return false;
  const from = getState(db,'accounting:history-from');
  if (!from || dv.exDate < from) return false;
  const splits = db.prepare("SELECT key FROM state WHERE key LIKE ?").all(`split_stale:${dv.symbol}`);
  ensureAccountingTables(db);
  if(db.prepare(`SELECT 1 FROM corporate_entitlements e JOIN entitlement_settlements s ON s.entitlement_id=e.id
    WHERE e.kind='split' AND e.symbol=? AND e.ex_date<=? AND s.effective_date>=?`).get(dv.symbol,dv.exDate,dv.exDate))return false;
  const marker=getState(db,`split_stale:${dv.symbol}`);
  let markerDate:string|null=null;
  try{const parsed=JSON.parse(marker??'null');if(typeof parsed?.ts==='string')markerDate=parsed.ts.slice(0,10);}catch{/* retain gate */}
  const settledSplit=markerDate&&db.prepare(`SELECT 1 FROM entitlement_settlements s JOIN corporate_entitlements e ON e.id=s.entitlement_id
    WHERE e.id=? AND s.effective_date<?`).get(`split:${dv.symbol}:${markerDate}`,dv.exDate);
  if ((splits.length && !settledSplit) || outstandingSplit(db,dv.symbol)) return false;
  const qty = historicalQty(db,dv.symbol,dv.exDate);
  db.exec('SAVEPOINT dividend_right');
  try{
  const inserted=putEntitlement(db,{id:`div:${dv.symbol}:${dv.exDate}`,kind:'dividend',symbol:dv.symbol,exDate:dv.exDate,
    eligibleQty9:d9str(qty),cash9:d9str(mul9(qty,dv.perShare9)),extraQty9:'0',sleeve:null,
    evidence:{source:'historical-fills-and-announcement',perShare9:d9str(dv.perShare9),historyFrom:from}});
  if(inserted)overlayEconomicCash(db,`entitlement:div:${dv.symbol}:${dv.exDate}`,dv.exDate,mul9(qty,dv.perShare9));
  db.exec('RELEASE dividend_right');
  }catch(e){db.exec('ROLLBACK TO dividend_right');db.exec('RELEASE dividend_right');throw e;}
  return true;
}

export function economicRights(db: DatabaseSync, date: string, prices: Map<string,D9>, sleeve?: string): {cash9:D9;stock9:D9} {
  if (!accountingEnabled(db)) return {cash9:0n,stock9:0n};
  ensureAccountingTables(db);
  const rows = db.prepare(`SELECT * FROM corporate_entitlements e WHERE status='outstanding' AND ex_date<=?
    AND NOT EXISTS(SELECT 1 FROM entitlement_settlements s WHERE s.entitlement_id=e.id AND s.effective_date<=?)`).all(date,date) as any[];
  let cash9=0n,stock9=0n;
  for (const r of rows) {
    cash9 += d9(r.cash9);
    if (d9(r.extra_qty9) !== 0n && (!sleeve || r.sleeve === sleeve)) {
      const px=prices.get(r.symbol); if(px===undefined) throw new Error('Economic entitlement price unavailable');
      stock9 += mul9(d9(r.extra_qty9),px);
    }
  }
  return {cash9,stock9};
}
export function economicSymbols(db: DatabaseSync): string[] {
  if(!accountingEnabled(db))return [];
  ensureAccountingTables(db);
  return (db.prepare(`SELECT DISTINCT symbol FROM corporate_entitlements e WHERE kind='split' AND status='outstanding' AND extra_qty9!='0'
    AND NOT EXISTS(SELECT 1 FROM entitlement_settlements s WHERE s.entitlement_id=e.id)`).all() as any[]).map(r=>r.symbol);
}

/** Fee receipts are identified by broker activity ID. Cash/stock distributions require a matched
 *  entitlement and an independently reviewed settlement; an unmatched receipt halts, never guesses. */
export function ingestBrokerCashActivities(db: DatabaseSync, rows: any[], opts:{restating?:boolean}={}): number {
  if (!accountingEnabled(db)) return 0;
  containAccountingConflicts(db);
  ensureAccountingTables(db);
  // Validate settled IDs before dispatch by type: a changed DIV -> FEE must not become
  // a second cash event. Persist containment outside the ingestion savepoint.
  for(const r of rows){
    const settled=db.prepare('SELECT activity_hash FROM entitlement_settlements WHERE activity_id=?').get(r.id) as any;
    if(settled&&settled.activity_hash!==brokerActivityHash(r)){
      if(!getState(db,'halt:book'))setState(db,'halt:book','Settled broker receipt changed; accounting review required');
      const key=`accounting:receipt-conflict:${r.id}:${brokerActivityHash(r)}`;
      if(!getState(db,key))setState(db,key,JSON.stringify({id:r.id,previousHash:settled.activity_hash,observedHash:brokerActivityHash(r)}));
      throw Error('Settled broker receipt changed; accounting review required');
    }
  }
  let inserted=0;
  db.exec('SAVEPOINT cash_activities');
  try {
    for(const r of rows) {
      if(typeof r.id!=='string' || !r.id || typeof r.activity_type!=='string')throw new Error('Invalid cash activity');
      if(r.activity_type==='JNLC'&&r.id===getState(db,'accounting:seed-activity-id')) {
        const seed=db.prepare("SELECT amount9,settles_on FROM cash_events WHERE kind='seed' AND ref='seed'").get() as any;
        if(!seed||d9(seed.amount9)!==d9(String(r.net_amount))||seed.settles_on!==String(r.date).slice(0,10))throw new Error('Inception journal changed');
        continue;
      }
      if(r.activity_type !== 'FEE') {
        ensureAccountingTables(db);
        const settled=db.prepare('SELECT activity_hash FROM entitlement_settlements WHERE activity_id=?').get(r.id) as any;
        if(settled && settled.activity_hash===brokerActivityHash(r))continue;
        if(!getState(db,'halt:book'))setState(db,'halt:book','Unmatched broker cash/stock distribution; entitlement settlement requires review');
        const key=`accounting:unmatched:${r.id}`;
        const payload=JSON.stringify({status:'unresolved',id:r.id,type:r.activity_type,activityHash:hash(r),
          evidence:Object.fromEntries(['date','net_amount','symbol','qty','per_share_amount'].filter(k=>r[k]!=null).map(k=>[k,r[k]]))});
        const previous=getState(db,key);
        if(previous===null)setState(db,key,payload);
        else if(previous!==payload)throw new Error('Unmatched activity evidence changed; reviewed settlement required');
        continue;
      }
      const amount=d9(String(r.net_amount));if(amount>=0n)throw new Error('Invalid fee sign');
      const date=String(r.date).slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw new Error('Invalid fee date');
      const old=db.prepare("SELECT amount9,settles_on FROM cash_events WHERE kind='fee' AND ref=?").get(r.id) as any;
      if(old&&(d9(old.amount9)!==amount||old.settles_on!==date))throw new Error('Conflicting broker fee replay');
      if(recordCash(db,{ts:date+'T12:00:00Z',kind:'fee',amount9:amount,settlesOn:date,ref:r.id,note:'Broker-confirmed fee; date-only source'})){
        inserted++;
        if(!opts.restating)overlayEconomicCash(db,`fee:${r.id}`,date,amount);
      }
    }
    db.exec('RELEASE cash_activities');return inserted;
  } catch(e) {db.exec('ROLLBACK TO cash_activities');db.exec('RELEASE cash_activities');throw e;}
}

/** Corrected marks coexist with immutable as-reported rows. An altered source invalidates overlay. */
export function correctedMark(db: DatabaseSync,date:string,series:string,source:unknown): D9 | null {
  if(!accountingEnabled(db))return null;
  ensureAccountingTables(db);
  const rows=db.prepare(`SELECT m.* FROM accounting_marks m JOIN accounting_repairs r ON r.id=m.repair_id
    WHERE m.date=? AND m.series=? AND r.reversed_ts IS NULL`).all(date,series) as any[];
  if(rows.length>1||(rows.length===1&&rows[0].source_hash!==hash(source)))throw new Error('Accounting restatement source changed');
  const overlays=db.prepare('SELECT source_hash,delta9 FROM accounting_cash_overlays WHERE date=? AND series=?').all(date,series) as any[];
  if(overlays.some(o=>o.source_hash!==hash(source)))throw new Error('Accounting cash-overlay source changed');
  if(!rows.length&&!overlays.length)return null;
  const base=rows.length?d9(rows[0].economic9):d9((source as any)[series==='book'?'equity9':'value9']);
  return base+overlays.reduce<D9>((s,r)=>s+d9(r.delta9),0n);
}

/** Late fee receipts / dividend discoveries amend only derived economic history. Original marks
 *  are never rewritten. Sleeve cash deltas use the aggregate-before/after allocation, avoiding
 *  cumulative one-unit rounding errors from independently rounding each fee. */
export function overlayEconomicCash(db:DatabaseSync,sourceId:string,date:string,amount9:D9):void{
  ensureAccountingTables(db);
  if(amount9===0n)return;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='book_marks'").get())return;
  const marks=db.prepare('SELECT * FROM book_marks WHERE date>=? ORDER BY date').all(date) as any[];
  for(const mark of marks){
    correctedMark(db,mark.date,'book',mark); // reject changed underlying marks before appending
    const base=db.prepare("SELECT m.evidence_json FROM accounting_marks m JOIN accounting_repairs r ON r.id=m.repair_id WHERE m.date=? AND m.series='book' AND r.reversed_ts IS NULL").get(mark.date) as any;
    const detail=base?JSON.parse(base.evidence_json):null;
    const rights=db.prepare('SELECT cash_rights9 FROM accounting_mark_rights WHERE date=?').get(mark.date) as any;
    let before=detail?d9(detail.cash9)+d9(detail.cashEntitlements9):d9(mark.cash9)+(rights?d9(rights.cash_rights9):0n);
    before+=(db.prepare("SELECT delta9 FROM accounting_cash_overlays WHERE date=? AND series='book'").all(mark.date) as any[]).reduce<D9>((s,r)=>s+d9(r.delta9),0n);
    db.prepare('INSERT INTO accounting_cash_overlays VALUES(?,?,?,?,?)').run(sourceId,mark.date,'book',hash(mark),d9str(amount9));
    for(const [sleeve,weight] of Object.entries({mom:'0.4',ins:'0.25',anc:'0.25',wld:'0.1'})){
      const series=`sleeve:${sleeve}`;
      const row=db.prepare('SELECT * FROM bench_marks WHERE date=? AND series=?').get(mark.date,series) as any;
      if(!row)continue;
      correctedMark(db,mark.date,series,row);
      const delta=mul9(before+amount9,d9(weight))-mul9(before,d9(weight));
      db.prepare('INSERT INTO accounting_cash_overlays VALUES(?,?,?,?,?)').run(sourceId,mark.date,series,hash(row),d9str(delta));
    }
  }
  if(marks.length){
    const all=db.prepare('SELECT * FROM book_marks ORDER BY date').all() as any[];
    const peak=all.reduce<D9>((p,m)=>{const value=correctedMark(db,m.date,'book',m)??d9(m.equity9);return value>p?value:p;},0n);
    setState(db,'brake:peak9',peak.toString());
  }
}
