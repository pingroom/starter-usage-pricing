import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportProposal } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE, id } from './mock.js';
const input = await readJson(new URL('../examples/usage.json', import.meta.url), 65536);
for (const choice of ['a', 'b', 'unknown']) {
  const directory = await mkdtemp(join(tmpdir(), 'pricing-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    const pending = await step(options); assert.equal(pending.status, 'pending');
    api.answer(id(1), choice); const result = await step(options);
    if (choice === 'unknown') { assert.equal(result.proposal, null); await assert.rejects(exportProposal(directory, input)); }
    else { const exported = await exportProposal(directory, input); assert.equal(exported.proposal.cardId, choice); }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    console.log(JSON.stringify({ choice, status: result.status, proposal: result.proposal }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
for (const failure of ['lost-response', 'cancelled']) {
  const directory = await mkdtemp(join(tmpdir(), 'pricing-failure-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    if (failure === 'lost-response') api.controls.loseNext = true;
    const initial = await step(options);
    if (failure === 'lost-response') {
      assert.equal(initial.status, 'create_unknown'); assert.equal((await step(options)).status, 'create_unknown');
      api.answer(id(1), 'a'); assert.equal((await step({ ...options, command: 'recover', attachId: id(1) })).status, 'complete');
    } else {
      api.terminal(id(1), 'cancelled'); assert.equal((await step(options)).proposal, null); await assert.rejects(exportProposal(directory, input));
    }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    console.log(JSON.stringify({ scenario: failure, posts: 1, outcome: failure === 'lost-response' ? 'Recovered original Question' : 'Proposal withheld' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
