import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {hash} from './accounting.js';
import {captureSettlement,prepareSettlement,applySettlement,type SettlementPlan} from './entitlement-settlement.js';
const [op,...args]=process.argv.slice(2),options=new Map<string,string>();
if(!['plan','apply'].includes(op))throw Error('Use plan or apply');
for(let i=0;i<args.length;i+=2){if(!['--db','--entitlement','--activity','--output','--plan','--reviewed-hash','--env'].includes(args[i])||!args[i+1]||options.has(args[i]))throw Error('Invalid option');options.set(args[i],args[i+1]);}
const required=(key:string)=>{const value=options.get(key);if(!value)throw Error('Required '+key);return value;};
process.loadEnvFile(required('--env'));
if(process.env.ALPACA_BASE_URL!=='https://paper-api.alpaca.markets'||!process.env.ALPACA_API_KEY||!process.env.ALPACA_API_SECRET)throw Error('Paper broker configuration required');
const db=new DatabaseSync(required('--db'),{readOnly:op==='plan'});
try{
 db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
 const evidence=await captureSettlement(db,async path=>{const r=await fetch('https://paper-api.alpaca.markets'+path,{headers:{'APCA-API-KEY-ID':process.env.ALPACA_API_KEY!,'APCA-API-SECRET-KEY':process.env.ALPACA_API_SECRET!},signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Broker read failed '+r.status);return r.json();});
 if(op==='plan'){
   const plan=prepareSettlement(db,evidence,required('--entitlement'),required('--activity'));
   writeFileSync(required('--output'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
   console.log(JSON.stringify({reviewHash:hash(plan),kind:plan.entitlement.kind,planned:true}));
 }else console.log(JSON.stringify(applySettlement(db,JSON.parse(readFileSync(required('--plan'),'utf8')) as SettlementPlan,evidence,required('--reviewed-hash'))));
}finally{db.close();}
