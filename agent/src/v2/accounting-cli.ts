// Explicit path only. Plan is read-only; apply/reverse need a reviewed exact plan hash.
import { readFileSync,writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { prepareRepair,applyRepair,reverseRepair,type RepairEvidence,type RepairPlan } from './accounting-repair.js';
import { hash } from './accounting.js';
const args=process.argv.slice(2);
const op=args.shift();
const options=new Map<string,string>();
for(let i=0;i<args.length;i+=2){
  if(!['--db','--evidence','--plan','--output','--reviewed-hash'].includes(args[i])||!args[i+1]||options.has(args[i]))throw new Error('Invalid or duplicate option');
  options.set(args[i],args[i+1]);
}
const required=(name:string)=>{const value=options.get(name);if(!value)throw new Error(`Required: ${name}`);return value;};
if(!['plan','apply','reverse'].includes(op??''))throw new Error('Use plan, apply or reverse');
const db=new DatabaseSync(required('--db'),{readOnly:op==='plan'});
try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if(op==='reverse')console.log(JSON.stringify({reversed:reverseRepair(db,required('--reviewed-hash'))}));
  else{
    const evidence=JSON.parse(readFileSync(required('--evidence'),'utf8')) as RepairEvidence;
    if(op==='plan'){
      const plan=prepareRepair(db,evidence);
      writeFileSync(required('--output'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
      console.log(JSON.stringify({planHash:hash(plan),reversals:plan.reversals.length,fees:plan.fees.length,lots:plan.lots.length,entitlements:plan.entitlements.length,restatements:plan.marks.length,cashAfter9:plan.cashAfter9,roundingResidue9:plan.roundingResidue9}));
    }else{
      const plan=JSON.parse(readFileSync(required('--plan'),'utf8')) as RepairPlan;
      console.log(JSON.stringify(applyRepair(db,plan,evidence,required('--reviewed-hash'))));
    }
  }
}finally{db.close();}
