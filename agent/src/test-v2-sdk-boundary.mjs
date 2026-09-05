// Capture actual role options without spawning the SDK or emitting fleet telemetry.
import assert from 'node:assert/strict';
import { register } from 'node:module';
const sdk = `data:text/javascript,${encodeURIComponent('export const query = args => globalThis.__bullRoleQuery(args);')}`;
const fleet = `data:text/javascript,${encodeURIComponent('export const emitCost = async () => { globalThis.__bullRoleEmits++; }; export const ritualTask = () => "fixture";')}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@anthropic-ai/claude-agent-sdk') return {url:${JSON.stringify(sdk)},shortCircuit:true};
    if (specifier.endsWith('/fleet-emit.js') || specifier.endsWith('/fleet-emit.ts')) return {url:${JSON.stringify(fleet)},shortCircuit:true};
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
let captured;
globalThis.__bullRoleEmits = 0;
globalThis.__bullRoleQuery = async function* (args) {
  captured = args;
  yield {type:'result',subtype:'success',result:'{"fixture":true}'};
};
// Import-time overrides deliberately use fixture IDs to prove role selection is preserved.
for (const role of ['extract','brief','judge','pick']) process.env[`BULL_${role.toUpperCase()}_MODEL`] = `fixture-${role}`;
const { sdkLlmPort } = await import('./v2/judgment/llm-port.ts');
for (const role of ['extract','brief','judge','pick']) {
  assert.equal(await sdkLlmPort.complete(role, 'fixture prompt'), '{"fixture":true}');
  assert.equal(captured.prompt, 'fixture prompt');
  assert.equal(captured.options.model, `fixture-${role}`);
  assert.deepEqual(captured.options.tools, [], `${role} must expose no tools`);
  assert.deepEqual(captured.options.settingSources, []);
  assert.equal(captured.options.maxTurns, 1);
  assert.equal(typeof captured.options.systemPrompt, 'string');
}
assert.equal(globalThis.__bullRoleEmits, 4, 'all telemetry calls must reach the isolated stub');
console.log('Bull four actual role callers preserve stateless zero-tool contract');
