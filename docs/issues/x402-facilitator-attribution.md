# Hosted Celo facilitator: settlements carry no ERC-8021 tag — what is the plan once x402-rs#99 lands?

**Repo:** `celo-org/attribution-tags`
**Related:** #17 (x402 watch 2026-09-21), [x402-rs/x402-rs#99](https://github.com/x402-rs/x402-rs/pull/99)

---

I run an x402 seller on Celo mainnet and tag everything I send myself, so this
is a report from the one position that can see the gap from the outside: every
transaction my app causes is tagged `remesso` **except** the ones the hosted
facilitator submits on my behalf, and there is nothing I can do about those
from where I sit.

Filing here rather than against the facilitator because `celo-org/x402-facilitator`
is not public. Please route it if there is a better home.

## What I observe today

A settlement through `api.x402.celo.org`, mainnet, 2026-09-28:

```
tx     0xe2a1a88725b8c8e9025cb393b372ef414233d6428790f6b071ae77e19af46cc7
from   0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48   (facilitator signer)
to     0xcebA9300f2b948710d2653dD7B07f33A8B32118C   (USDC)
input  0xe3ee160e…  transferWithAuthorization, 292 bytes
```

292 bytes is `4 + 9 × 32` exactly — the ABI encoding and not one byte more, so
there is no suffix, tagged or otherwise. For scale, that signer has sent
**765,747 transactions**. I have byte-checked one of them (mine); I am not
claiming the other 765,746 are untagged, only that the mechanism that would tag
them does not appear to be in the path.

`GET /supported` advertises one extension, `eip2612GasSponsoring`. `/verify`
and `/settle` take no attribution field, and the seller is not the sender — the
facilitator builds and signs the transaction — so a seller cannot append a
suffix even in principle.

## What I read afterwards

#17 and [x402-rs#99](https://github.com/x402-rs/x402-rs/pull/99), which is
exactly this, already built: `builder-code` extension, Schema 2 CBOR `{a, w, s}`,
`a`/`s` from the payment payload and `w` from facilitator config. It is out of
draft as of 2026-09-29 with a Celo Sepolia settlement decoded in the
description. So the protocol work is done and my question is only about the
hosted deployment.

## What I am asking

1. **When #99 merges, will `api.x402.celo.org` run it, and roughly when?**
   `/health` reports an `upstream`, so the hosted endpoint looks like a wrapper
   in front of a facilitator implementation — is that upstream x402-rs, and
   does a merge there reach this endpoint by upgrade?

2. **Will the hosted facilitator accept a seller's `builder-code` extension**
   (the `a` and `s` codes from the payload), or only set its own `w`? The
   difference matters: `w` alone attributes the volume to the facilitator, and
   `a` is what attributes it to the app that generated it.

3. **Is there anything a seller should do in the meantime**, other than wait?
   The only alternative I can see is to stop using the hosted facilitator and
   submit `transferWithAuthorization` myself, which is a strange thing to do
   for attribution alone — see below.

## Why it is worth a deployment, not just a merge

Measured on my own transactions at 202 gwei with CELO near $0.09: an x402
settlement is ~85,842 gas, about **$0.0016**. My cheapest paid endpoint sells
for **0.001 USDC**. Self-settling to get a tag would cost more than the sale,
so for micropayment sellers the hosted facilitator is not a convenience, it is
the only economic option — and today choosing it means the transaction is
unattributable.

That is the part that does not wash out over time. Per the SDK's own README,
untagged transactions cannot be claimed retroactively, so every settlement
between now and the deployment is permanently unattributed volume for whichever
app caused it. x402 volume is precisely the traffic Celo is trying to grow, and
it is currently the traffic least able to prove it happened.

Happy to test against mainnet the day it ships and report back with decoded
calldata — I have a live seller, a live buyer and a spare wallet already
pointed at it.

---

<sub>Context: Remesso, recurring stablecoin remittances on Celo, ERC-8004 agent
`9867`. Two paid endpoints at 0.001 and 0.01 USDC behind the hosted
facilitator.</sub>
