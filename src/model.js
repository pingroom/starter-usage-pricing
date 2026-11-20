import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,29})$(?![\s\S])/.test(value);
export const POLICY = Object.freeze({ name: 'graduated-usage-minor-units-v1', quantities: 'nonnegative whole units; canonical decimal strings with at most 30 digits',
  aggregation: 'sum usage lines by meter before applying that meter\'s tiers once',
  tiers: 'strictly increasing cumulative upper bounds; each tier consumes only units above its previous bound; final tier is unbounded',
  arithmetic: 'BigInt; consumed units times integer minor-unit rate; no rounding',
  currency: 'all candidate cards declare the same currency and minor-unit exponent; meters use matching units',
  selection: 'one owner-selected supplied rate card; Unknown withholds proposal',
  excluded: 'volume pricing, fractional usage, flat fees, minimums, discounts, tax, proration, currency conversion, invoice issuance and payment collection' });
export const POLICY_HASH = hash(POLICY);
const promptFor = input => `${input.title}\n${input.context}\nWhich supplied contract card applies to ${input.usageId}?\n${input.rateCards.map(card => `${card.id}: ${card.label} / ${card.currency} / ${card.reference}`).join('\n')}\nConsult the contract and local preview, or choose Unknown. Rates and usage stay local.`;
export function validateInput(input) {
  if (!keys(input, ['usageId', 'title', 'context', 'usage', 'rateCards']) || !word(input.usageId) || !line(input.title, 40) || !line(input.context, 80)
    || !Array.isArray(input.usage) || input.usage.length < 1 || input.usage.length > 16
    || !Array.isArray(input.rateCards) || input.rateCards.length < 1 || input.rateCards.length > 3) throw new Error('Supply usage metadata, one to 16 usage lines and one to three contract rate cards.');
  const usageIds = new Set(), units = new Map();
  const usage = Array.from(input.usage, entry => {
    if (!keys(entry, ['id', 'meterId', 'unit', 'quantity']) || !word(entry.id) || usageIds.has(entry.id) || !safeId(entry.meterId)
      || !line(entry.unit, 26) || !decimal(entry.quantity)) throw new Error('Usage lines need unique IDs, safe meter IDs, units and canonical nonnegative integer quantities.');
    if (units.has(entry.meterId) && units.get(entry.meterId) !== entry.unit) throw new Error('All usage lines for a meter must use exactly the same unit.');
    usageIds.add(entry.id); units.set(entry.meterId, entry.unit); return { ...entry };
  }).sort((a, b) => order(a.id, b.id));
  if (units.size > 8) throw new Error('At most eight distinct usage meters are supported.');
  const ids = new Set(), schedules = new Set(); let currency, exponent;
  const rateCards = Array.from(input.rateCards, card => {
    if (!keys(card, ['id', 'label', 'reference', 'currency', 'minorUnitExponent', 'meters']) || !safeId(card.id) || ids.has(card.id)
      || !line(card.label, 26) || !line(card.reference, 40) || typeof card.currency !== 'string' || !/^[A-Z]{3}$(?![\s\S])/.test(card.currency)
      || !Number.isSafeInteger(card.minorUnitExponent) || card.minorUnitExponent < 0 || card.minorUnitExponent > 6 || Object.is(card.minorUnitExponent, -0)
      || !Array.isArray(card.meters) || card.meters.length !== units.size) throw new Error('Rate cards need unique safe IDs, labels/references, a currency, a minor-unit exponent from zero to six, and every usage meter.');
    if (currency !== undefined && (card.currency !== currency || card.minorUnitExponent !== exponent)) throw new Error('All candidate cards must use the same declared currency and minor-unit exponent.');
    currency = card.currency; exponent = card.minorUnitExponent; ids.add(card.id); const meterIds = new Set();
    const meters = Array.from(card.meters, meter => {
      if (!keys(meter, ['meterId', 'unit', 'tiers']) || !units.has(meter.meterId) || meterIds.has(meter.meterId) || meter.unit !== units.get(meter.meterId)
        || !Array.isArray(meter.tiers) || meter.tiers.length < 1 || meter.tiers.length > 8) throw new Error('Each card must cover each usage meter exactly once with matching units and one to eight tiers.');
      meterIds.add(meter.meterId); let previous = 0n;
      const tiers = Array.from(meter.tiers, (tier, index) => {
        if (!keys(tier, ['upTo', 'unitAmountMinor']) || !decimal(tier.unitAmountMinor)) throw new Error('Tier rates must be canonical nonnegative integer minor-unit strings.');
        if (index === meter.tiers.length - 1) {
          if (tier.upTo !== null) throw new Error('The final tier must have a null unbounded upper limit.');
        } else {
          if (!decimal(tier.upTo) || BigInt(tier.upTo) <= previous) throw new Error('Finite tier upper limits must be strictly increasing positive integer strings.');
          previous = BigInt(tier.upTo);
        }
        return { ...tier };
      });
      return { meterId: meter.meterId, unit: meter.unit, tiers };
    }).sort((a, b) => order(a.meterId, b.meterId));
    const scheduleHash = hash({ currency, minorUnitExponent: exponent, meters });
    if (schedules.has(scheduleHash)) throw new Error('Candidate rate cards must have distinct pricing schedules, not renamed copies.');
    schedules.add(scheduleHash); return { ...card, meters };
  }).sort((a, b) => order(a.id, b.id));
  const result = { usageId: input.usageId, title: input.title, context: input.context, usage, rateCards };
  if (promptFor(result).length > 500) throw new Error('Rate-card selection prompt exceeds 500 UTF-16 units.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact contract owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = rawInput => { validateInput(rawInput); return [{ id: 'card' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'card' || !isId(attemptId)) throw new Error('Invalid rate-card selection item or attempt.');
  const key = `pricing-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [...input.rateCards.map(card => ({ value: card.id, label: `${card.id}: ${card.label}`, style: 'default' })), { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), cards_hash: hash(input.rateCards), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'card', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'The attempt UUID, correlation ID and input/card/policy hashes are bound when a session creates its Question.' };
}

/** Pure calculation from supplied integers. CLI export also requires attributed owner evidence. */
export function quoteUsage(rawInput, cardId) {
  const input = validateInput(rawInput), card = input.rateCards.find(item => item.id === cardId);
  if (!card) throw new Error('Select an existing supplied rate card before calculating a proposal.');
  const meters = card.meters.map(meter => {
    const readings = input.usage.filter(entry => entry.meterId === meter.meterId);
    const quantity = readings.reduce((total, entry) => total + BigInt(entry.quantity), 0n);
    let lower = 0n, remaining = quantity, subtotal = 0n, consumed = 0n;
    const lines = meter.tiers.map((tier, index) => {
      const upper = tier.upTo === null ? null : BigInt(tier.upTo), capacity = upper === null ? remaining : upper - lower;
      const units = remaining < capacity ? remaining : capacity, amount = units * BigInt(tier.unitAmountMinor);
      const result = { tier: index + 1, above: lower.toString(), upTo: tier.upTo, units: units.toString(), unitAmountMinor: tier.unitAmountMinor, amountMinor: amount.toString() };
      remaining -= units; consumed += units; subtotal += amount;
      if (upper !== null) lower = upper;
      return result;
    });
    if (remaining !== 0n || consumed !== quantity) throw new Error('Tier quantity reconciliation failed.');
    return { meterId: meter.meterId, unit: meter.unit, usageIds: readings.map(entry => entry.id), quantity: quantity.toString(), lines, amountMinor: subtotal.toString(),
      reconciliation: { inputUnits: quantity.toString(), tierUnits: consumed.toString(), unallocatedUnits: remaining.toString(), matches: consumed === quantity } };
  });
  const total = meters.reduce((sum, meter) => sum + BigInt(meter.amountMinor), 0n);
  const lineTotal = meters.flatMap(meter => meter.lines).reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
  if (lineTotal !== total) throw new Error('Charge amount reconciliation failed.');
  return { cardId: card.id, cardLabel: card.label, contractReference: card.reference, currency: card.currency, minorUnitExponent: card.minorUnitExponent,
    meters, totalAmountMinor: total.toString(), reconciliation: { usageLineCount: input.usage.length, meterCount: meters.length,
      tierLineCount: meters.reduce((sum, meter) => sum + meter.lines.length, 0), tierAmountMinor: lineTotal.toString(), meterAmountMinor: total.toString(), matches: lineTotal === total },
    sourceHash: hash(input), cardHash: hash(card), policyHash: POLICY_HASH, contractIndependentlyVerified: false, invoiceIssued: false, paymentCollected: false };
}
export function pricingPlan(rawInput, choice) {
  const input = validateInput(rawInput);
  if (![null, 'unknown', ...input.rateCards.map(card => card.id)].includes(choice)) throw new Error('Supply a listed rate card, Unknown or a missing choice.');
  return { status: choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : 'complete', proposal: choice === null || choice === 'unknown' ? null : quoteUsage(input, choice) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed usage metadata. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved rate-card selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}



export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'card', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = pricingPlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, usageId: input.usageId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved rate-card selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered rate-card selections must not contain rate-card selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
