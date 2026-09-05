import assert from "node:assert/strict";
import { openDb } from "./v2/db.js";
import { queueReconcileApproval } from "./v2/rituals/morning.js";

const db = openDb(":memory:");
const evidence = { mismatches: [{symbol:"APH", ledger9:"2.520154706", broker9:"1.260077353", haltedSleeves:["mom"]}],
  untaggedFills: [] as string[], notes:["cash delta 10.58"] };
const first = queueReconcileApproval(db, "position mismatch", evidence);
assert.equal(queueReconcileApproval(db, "position mismatch", {...evidence,notes:["cash delta 10.59"]}), first);
assert.equal((db.prepare("SELECT count(*) n FROM approvals").get() as {n:number}).n, 1);
assert.match((db.prepare("SELECT payload FROM approvals WHERE id=?").get(first) as {payload:string}).payload, /10.59/);
db.prepare("UPDATE approvals SET status='approved' WHERE id=?").run(first);
const recurring = queueReconcileApproval(db, "position mismatch", evidence);
assert.notEqual(recurring, first, "a resolved incident recurring needs a new operator card");
const changed = queueReconcileApproval(db, "position mismatch", {...evidence, untaggedFills:["external-fill"]});
assert.notEqual(changed, recurring, "new foreign fills are new evidence, not suppressed");
db.prepare("INSERT INTO approvals(ts,kind,title,payload,status) VALUES('now','reconcile-mismatch','bad','{}','pending')").run();
assert.equal(queueReconcileApproval(db, "position mismatch", evidence), recurring, "malformed historic row cannot mask existing valid incident");
db.close();
console.log("Reconciliation cards: repeated, changed, resolved and malformed-evidence checks pass");
