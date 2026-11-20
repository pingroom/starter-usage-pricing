import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { quoteUsage, pricingPlan, validateInput, previewInput, requestFor, hash, POLICY_HASH } from '../src/model.js';
import { CONFIG, id } from '../src/mock.js';
const example = JSON.parse(await readFile(new URL('../examples/usage.json', import.meta.url), 'utf8'));
const fixture = (quantity = '0', tiers = [{ upTo: null, unitAmountMinor: '5' }]) => ({ usageId: 'fixture', title: 'Supplied contract', context: 'Consult the contract record.',
  usage: [{ id: 'reading', meterId: 'pages', unit: 'page', quantity }],
  rateCards: [{ id: 'a', label: 'Supplied plan', reference: 'Section two', currency: 'USD', minorUnitExponent: 2, meters: [{ meterId: 'pages', unit: 'page', tiers }] }] });
const tiers = () => [{ upTo: '5', unitAmountMinor: '700' }, { upTo: '10', unitAmountMinor: '650' }, { upTo: null, unitAmountMinor: '600' }];
// Independent bounded oracle: price each numbered unit individually rather than allocating tier capacities.
function unitOracle(quantity, schedule) {
  let amount = 0n;
  for (let unit = 1; unit <= quantity; unit++) {
    const tier = schedule.find(entry => entry.upTo === null || unit <= Number(entry.upTo));
    amount += BigInt(tier.unitAmountMinor);
  }
  return amount.toString();
}

test('graduated boundary totals use every crossed tier, not a volume rate', () => {
  for (const [quantity, expected] of [[0, '0'], [1, '700'], [5, '3500'], [6, '4150'], [10, '6750'], [11, '7350'], [20, '12750']]) {
    const result = quoteUsage(fixture(String(quantity), tiers()), 'a');
    assert.equal(result.totalAmountMinor, expected); assert.equal(result.reconciliation.matches, true);
    assert.equal(result.meters[0].reconciliation.tierUnits, String(quantity)); assert.equal(result.meters[0].reconciliation.unallocatedUnits, '0');
    assert.deepEqual(result.meters[0].lines.map(line => line.above), ['0', '5', '10']);
  }
});
test('repeated meter readings aggregate before tiers while different units remain separate', () => {
  const result = quoteUsage(example, 'a');
  assert.equal(result.totalAmountMinor, '671');
  assert.deepEqual(result.meters.map(m => [m.meterId, m.quantity, m.amountMinor]), [['covers', '12', '96'], ['pages', '125', '575']]);
  assert.deepEqual(result.meters[1].usageIds, ['batch-east', 'batch-west']);
  assert.deepEqual(result.meters[1].lines.map(line => line.units), ['100', '25']);
  assert.equal(result.reconciliation.usageLineCount, 3); assert.equal(result.reconciliation.tierAmountMinor, '671');
  assert.equal('totalUnits' in result.reconciliation, false);
  assert.equal(quoteUsage(example, 'b').totalAmountMinor, '522');
});
test('zero quantity, free tiers and decreasing or increasing supplied rates remain exact', () => {
  const zero = quoteUsage(fixture('0', tiers()), 'a');
  assert.ok(zero.meters[0].lines.every(line => line.units === '0' && line.amountMinor === '0'));
  for (const rates of [['0', '3'], ['3', '0'], ['1', '9'], ['5', '5']]) {
    const schedule = [{ upTo: '2', unitAmountMinor: rates[0] }, { upTo: null, unitAmountMinor: rates[1] }];
    assert.equal(quoteUsage(fixture('7', schedule), 'a').totalAmountMinor, (2n * BigInt(rates[0]) + 5n * BigInt(rates[1])).toString());
  }
});
test('BigInt handles maximum 30-digit inputs, summed readings and amounts beyond Number range', () => {
  const max = '9'.repeat(30), input = fixture(max, [{ upTo: null, unitAmountMinor: max }]);
  input.usage = Array.from({ length: 16 }, (_, i) => ({ id: `reading-${i}`, meterId: 'pages', unit: 'page', quantity: max }));
  const result = quoteUsage(input, 'a'), units = 16n * BigInt(max), expected = units * BigInt(max);
  assert.equal(result.meters[0].quantity, units.toString()); assert.equal(result.totalAmountMinor, expected.toString());
  assert.equal(result.totalAmountMinor.length, 62); assert.equal(JSON.parse(JSON.stringify(result)).totalAmountMinor, expected.toString());
  const boundary = quoteUsage(fixture(max, [{ upTo: String(BigInt(max) - 1n), unitAmountMinor: '0' }, { upTo: null, unitAmountMinor: max }]), 'a');
  assert.equal(boundary.totalAmountMinor, max); assert.equal(boundary.meters[0].lines[1].units, '1');
});
test('240 independently generated schedules and 81 quantities match a unit-by-unit oracle', () => {
  let cases = 0;
  for (let first = 1; first <= 5; first++) for (let gap = 1; gap <= 4; gap++) for (let seed = 0; seed < 12; seed++) {
    const schedule = [{ upTo: String(first), unitAmountMinor: String(seed % 4) }, { upTo: String(first + gap), unitAmountMinor: String((seed * 3) % 7) }, { upTo: null, unitAmountMinor: String((seed * 5) % 11) }];
    for (let quantity = 0; quantity <= 80; quantity++) {
      const result = quoteUsage(fixture(String(quantity), schedule), 'a');
      assert.equal(result.totalAmountMinor, unitOracle(quantity, schedule));
      assert.equal(result.meters[0].lines.reduce((sum, line) => sum + BigInt(line.units), 0n), BigInt(quantity));
      assert.ok(result.meters[0].lines.every(line => BigInt(line.units) >= 0n)); cases++;
    }
  }
  assert.equal(cases, 19440);
});
test('missing and Unknown card selections withhold proposals, with no default card', () => {
  assert.deepEqual(pricingPlan(example, null), { status: 'incomplete', proposal: null });
  assert.deepEqual(pricingPlan(example, 'unknown'), { status: 'unknown', proposal: null });
  assert.equal(pricingPlan(example, 'a').status, 'complete');
  for (const value of ['', 'missing', undefined, 0]) assert.throws(() => pricingPlan(example, value));
  assert.throws(() => quoteUsage(example, 'unknown'));
});
test('quantities and rates reject floats, exponent notation, leading zeros, signs and unsafe JSON numbers', () => {
  for (const bad of [0, 1, 9007199254740992, null, true, '', '-1', '-0', '+1', '01', '1.0', '1e3', ' 1', '1\n', '9'.repeat(31)]) {
    const input = fixture(); input.usage[0].quantity = bad; assert.throws(() => validateInput(input));
    const rate = fixture(); rate.rateCards[0].meters[0].tiers[0].unitAmountMinor = bad; assert.throws(() => validateInput(rate));
  }
});
test('tier coverage rejects missing infinity, repeated or descending boundaries, interior infinity and sparse tiers', () => {
  for (const schedule of [[], [{ upTo: '1', unitAmountMinor: '1' }], [{ upTo: '0', unitAmountMinor: '1' }, { upTo: null, unitAmountMinor: '1' }],
    [{ upTo: '2', unitAmountMinor: '1' }, { upTo: '2', unitAmountMinor: '2' }, { upTo: null, unitAmountMinor: '1' }],
    [{ upTo: '3', unitAmountMinor: '1' }, { upTo: '2', unitAmountMinor: '2' }, { upTo: null, unitAmountMinor: '1' }],
    [{ upTo: null, unitAmountMinor: '1' }, { upTo: null, unitAmountMinor: '2' }],
    [{ upTo: '01', unitAmountMinor: '1' }, { upTo: null, unitAmountMinor: '2' }], Array(2), Array(9).fill({ upTo: null, unitAmountMinor: '1' })]) assert.throws(() => validateInput(fixture('0', schedule)));
});
test('cards require complete meter coverage, matching units, common currency metadata and distinct schedules', () => {
  for (const mutate of [x => { x.usage[1].id = x.usage[0].id; }, x => { x.usage[1].unit = 'box'; }, x => { x.rateCards[0].meters.pop(); },
    x => { x.rateCards[0].meters[0].meterId = 'other'; }, x => { x.rateCards[0].meters[0].unit = 'sheet'; },
    x => { x.rateCards[0].meters[0] = x.rateCards[0].meters[1]; }, x => { x.rateCards[1].currency = 'EUR'; }, x => { x.rateCards[1].minorUnitExponent = 0; },
    x => { x.rateCards[1].id = 'a'; }, x => { x.rateCards[0].id = 'unknown'; }, x => { x.rateCards[0].currency = 'usd'; },
    x => { x.rateCards[0].minorUnitExponent = 7; }, x => { x.rateCards[0].minorUnitExponent = -0; }, x => { x.rateCards[1].meters = structuredClone(x.rateCards[0].meters); }]) {
    const input = structuredClone(example); mutate(input); assert.throws(() => validateInput(input));
  }
});
test('schema bounds reject extra fields, malformed text, sparse collections and unknown meter IDs', () => {
  for (const mutate of [x => { x.usage = []; }, x => { x.usage = Array(17).fill(x.usage[0]); }, x => { delete x.usage[0]; },
    x => { x.rateCards = []; }, x => { x.rateCards = Array(4).fill(x.rateCards[0]); }, x => { delete x.rateCards[0]; },
    x => { x.title = ' padded'; }, x => { x.context = 'new\nline'; }, x => { x.title = '\ud800'; }, x => { x.usageId = 'bad\n'; },
    x => { x.extra = 1; }, x => { x.usage[0].extra = 1; }, x => { x.rateCards[0].extra = 1; }, x => { x.rateCards[0].meters[0].extra = 1; },
    x => { x.rateCards[0].meters[0].tiers[0].flatAmountMinor = '100'; }, x => { x.usage[0].meterId = 'constructor'; }]) {
    const input = fixture(); mutate(input); assert.throws(() => validateInput(input));
  }
});
test('canonical input binds all usage and rates but treats declaration order as immaterial', () => {
  const input = structuredClone(example), before = JSON.stringify(input), canonical = validateInput(input);
  input.usage.reverse(); input.rateCards.reverse(); input.rateCards.forEach(card => card.meters.reverse());
  assert.equal(hash(validateInput(input)), hash(canonical));
  const result = quoteUsage(example, 'a'); assert.equal(JSON.stringify(example), before);
  assert.equal(result.sourceHash, hash(canonical)); assert.equal(result.policyHash, POLICY_HASH);
  assert.equal(result.contractIndependentlyVerified, false); assert.equal(result.invoiceIssued, false); assert.equal(result.paymentCollected, false);
  input.usage[0].quantity = '13'; assert.notEqual(hash(validateInput(input)), hash(canonical));
});
test('preview and Question bind exact supplied cards while keeping quantities and rates local', () => {
  const preview = previewInput(example, CONFIG), request = requestFor(example, CONFIG, 'card', id(1));
  assert.deepEqual(preview.source, validateInput(example)); assert.equal(preview.question.prompt, request.prompt);
  assert.equal(request.data.cards_hash, hash(validateInput(example).rateCards)); assert.equal(request.data.policy_hash, POLICY_HASH);
  assert.equal(request.target_user_id, CONFIG.participant.id); assert.equal(request.options.length, 3);
  assert.ok(request.prompt.length <= 500); assert.ok(request.options.every(option => option.label.length <= 40));
  assert.equal('usage' in request.data, false); assert.equal('rateCards' in request.data, false);
  const maximal = fixture(); maximal.title = 'T'.repeat(40); maximal.context = 'C'.repeat(80); maximal.usageId = 'i'.repeat(40);
  maximal.rateCards = Array.from({ length: 3 }, (_, i) => ({ ...structuredClone(maximal.rateCards[0]), id: `card${i}`, label: 'L'.repeat(26), reference: 'R'.repeat(40), meters: [{ meterId: 'pages', unit: 'page', tiers: [{ upTo: null, unitAmountMinor: String(i) }] }] }));
  assert.throws(() => validateInput(maximal), /prompt exceeds/);
});
