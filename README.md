# Usage pricing with PingRoom

Turn a sealed usage export into a charge proposal after its contract owner selects the applicable rate card through PingRoom. Code aggregates readings by meter, applies graduated tiers using exact integer arithmetic, and exports itemized charges with quantity and amount checks.

Use this between a usage collector and your invoice preparation workflow. Supply the contract rates yourself. This starter creates a local proposal. It does not issue invoices, collect payments or infer contract terms.

## Run offline

Choose **Use this template**, clone your copy, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The fictional paper-print example compares two supplied cards, withholds a proposal for Unknown, and demonstrates a lost creation response and a cancelled Question. Tests and demos use `@pingroom/sdk` **0.8.0** through local mock transports. After installation they require no credentials or network and send no live pings. Dependencies are pinned in the lockfile; `.npmrc` requests a 14-day minimum release age where supported by npm.

## Prepare usage and cards

```sh
cp examples/usage.json usage.json
cp config.example.json config.json
```

Map one completed usage period to `usage.json`. Do not combine overlapping readings or mix unrelated accounting periods. IDs identify readings but do not prove their origin or prevent overlap in your source system.

| Field | Contract |
| --- | --- |
| `usageId` | Stable 1–40 character ID: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context` | Nonempty single-line text, at most 40 and 80 UTF-16 code units. Identify the contract record to consult. |
| `usage` | 1–16 readings, each with `id`, `meterId`, `unit` and `quantity`. Reading IDs must be unique; at most eight meters are allowed. |
| Reading `id` | Uses the `usageId` alphabet and limit. |
| `meterId`, card `id` | Unique within their respective declarations; 1–12 characters using the same alphabet. `unknown`, `constructor`, `prototype` and `__proto__` are reserved. A meter may appear in several readings. |
| `quantity` | Nonnegative whole units as a canonical decimal string, at most 30 digits. For example, `"125"`, not `125` or `"125.0"`. |
| `unit` | Nonempty single-line label, up to 26 UTF-16 code units. Every declaration of a meter must use exactly the same unit. |
| `rateCards` | 1–3 supplied cards, each with `id`, `label`, `reference`, `currency`, `minorUnitExponent` and `meters`. Pricing schedules must differ. |
| Card `label`, `reference` | Single-line descriptions, up to 26 and 40 UTF-16 code units. Use a stable contract section or revision reference. |
| `currency`, `minorUnitExponent` | Three uppercase letters and an integer from 0 through 6. All candidate cards must declare the same pair. These are supplied metadata, not a verified currency registry. For USD cents, use `USD` and `2`. |
| Card `meters` | Every usage meter exactly once, with matching `meterId`, `unit` and `tiers`. No extra meters. |
| `tiers` | 1–8 entries with `upTo` and `unitAmountMinor`. Finite `upTo` values are canonical decimal strings of at most 30 digits, with strictly increasing positive cumulative bounds. The last entry must use `null` for no upper limit. |
| `unitAmountMinor` | Nonnegative integer minor units per whole usage unit, encoded as a canonical decimal string of at most 30 digits. Zero rates are allowed. |

Extra fields, sparse arrays, malformed Unicode, surrounding whitespace, control characters, negative values, leading zeros, fractional values and exponent notation are rejected. Usage, cards and meters canonicalize by ID; tier order remains significant. The complete Question must fit 500 UTF-16 code units.

## Connect and select the contract

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Approve pairing and grant a **standard private room** containing the contract owner, with room-list and Question create/read permissions. Verify the intended person in the app and enter their exact member UUID and label in `config.json`. Names alone do not establish identity.

For an existing connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Blank or partial pairs are rejected; credential sources cannot be combined.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run export
```

`preview` and `validate` show the complete local source, policy, recipient and visible Question without network access. Review that preview alongside the contract. PingRoom receives title/context, usage ID, card labels/references/currency, owner UUID and input/card/policy hashes. Quantities and tier rates stay local. Attempt identifiers are added when the Question is created.

Each invocation creates at most one direct, 15-minute Question or reads the original Question once. Missing, Unknown, expired, cancelled, invalid or misattributed answers withhold a proposal. There is no background polling or automatic replacement Question. A selection records the owner's assertion, not independent verification of the contract.

## Read the proposal

```sh
npm run status
npm run report
npm run export
```

These commands are local and need no credentials. `report` writes `.pricing/report.json`. After a known selection, `export` writes `.pricing/proposal.json`, including the frozen source, selected card, policy, owner and attributed Question evidence. Repeated exports send nothing and leave inputs unchanged. Treat the exported source and rates as private.

For each meter, all its readings are summed **before** applying its tiers once. A finite tier covers units above the preceding bound through its own `upTo` bound. Every tier exports its consumed units, rate and charge, including zero-consumption tiers. The calculation multiplies each tier's units by its rate, sums those charges per meter, then sums meter charges in their shared currency. It never adds quantities with different units.

For example, five units at 700 minor units, the next five at 650, then additional units at 600 gives 4,150 minor units for six units and 12,750 for twenty. This is [graduated pricing](https://docs.stripe.com/subscriptions/pricing-models/tiered-pricing#graduated-pricing); a volume price applied to every unit would give different results. No Stripe dependency or API integration is included.

All quantities, rates and money amounts use `BigInt` internally and decimal strings in JSON. There is no rounding or floating-point money arithmetic; sums and products may exceed the 30-digit input limit. `minorUnitExponent` describes the decimal placement only: the calculation stays in minor units. Zero usage produces zero charges, including zero consumption in every tier.

Per-meter checks reconcile input units with allocated tier units and require zero unallocated units. Amount checks reconcile tier charges with meter subtotals and the overall total. These checks establish arithmetic consistency, not usage accuracy or legal validity. Flat fees, minimum charges, discounts, taxes, fractional quantities, proration, currency conversion and volume pricing are unsupported; do not encode them as graduated tiers.

## Adapt and resume

Write an adapter from your usage collector to the documented JSON shape, preserving the billing-period boundary and meter units. Load your rate cards from a trusted contract source. Consume the exported proposal in a separate review or invoice preparation process. `quoteUsage` in `src/model.js` is the pure calculation helper; CLI export also requires attributed owner evidence. Payment and invoice adapters are not included.

Keep `.pricing/` and `.pingroom/` private and intact. Credentials, real inputs, configuration, state and outputs are ignored by Git. Input/configuration reads are limited to 64/16 KiB; private state and output writes are atomic under a local lock. Changed input, owner, room or credentials cannot reuse a session.

A lost creation response leaves `create_unknown`; the program never automatically resends:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. For uncertain or expired pairing, inspect Connected Agents and resolve/revoke the original registration before archiving pending pairing state. Remove a stale `.lock` only after confirming its process stopped. Restore the original source/session instead of deleting state to retry.

Run commands serially. Exit codes: `0` complete/local result; `1` invalid setup/evidence or refused export; `2` incomplete/Unknown/failed answer; `3` ready/pending/interrupted; `4` uncertain creation.

Tests cover tier boundaries, 19,440 independent unit-by-unit oracle cases, large exact amounts, input rejection, durable recovery, pairing and real CLI subprocesses. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
