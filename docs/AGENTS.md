# Connecting an agent to Remesso

Nothing to clone, nothing to install, no key shared with anyone. Remesso is
three HTTP endpoints and a contract. This page is what another agent — or the
person pointing one at us — needs.

| | |
|---|---|
| ERC-8004 agent | `9867` on Celo, registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Proof of human | Self Agent ID `191`, soulbound, zero-knowledge passport proof |
| Contract | `RemessoExecutorV4` `0x288b7cDD10e069eA64D4984c3E5fa0D9c5816009` (Celo, 42220) |
| Discovery | `GET https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent` |

The ERC-8004 metadata is a `data:` URI embedded in the token, not a link to a
server we control. What is registered cannot be quietly changed afterwards.

---

## What your agent needs, by role

| Role | Needs | Does not need |
|---|---|---|
| **Being paid** by a schedule | An address | Gas, USDC, an account, our software |
| **Paying** for a service | USDC on Celo | CELO — EIP-3009 means the facilitator pays gas |
| **Collecting** a payment early | A grant from the payer, plus a little CELO | — or skip the gas and pay a cent to `trigger-run` |

An agent that only receives money needs an address and nothing else. The payer
and the executor cover everything, including gas.

---

## Paying for a service

Three moves. The 402 is the quote — never trust a published price, including
the ones on this page.

```bash
# 1. what is on offer, and what it costs. Free: discovery that costs money is
#    discovery nobody does.
curl https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service

# 2. ask for the thing without paying. The 402 body carries exact requirements.
curl -X POST https://engaboljiqudghvzmebq.supabase.co/functions/v1/rate-service \
  -H 'content-type: application/json' -d '{}'

# 3. sign a USDC transfer authorisation for exactly that, retry with X-PAYMENT.
```

The signature is EIP-3009 `TransferWithAuthorization` over the USDC domain
(`name: "USDC"`, `version: "2"`, chainId 42220). Any x402 client does this.
`scripts/x402-buy.ts` in this repo is a complete one in about 40 lines if you
would rather read than install.

### Services

| Service | Price | What you get |
|---|---|---|
| `/functions/v1/agent` | free | Capabilities, prices, and what we refuse |
| `/functions/v1/rate-service` | 0.001 USDC | Live USDT/NGN and USDC/NGN with spread, from on-chain RFQ makers |
| `/functions/v1/trigger-run` | 0.01 USDC | Bring one payment of an existing schedule forward |

`trigger-run` answers `403` before quoting a price if the schedule's payer has
not granted our executor the right to collect. Nobody should pay to find that
out.

---

## Being paid on a schedule

Give the payer your address. They authorise once on-chain, and after that:

- the recipient, the amount and the cadence are fixed — nobody can change them,
  including us
- payments continue until their run cap, their expiry, or their cancellation
- you need no gas, no USDC and no relationship with Remesso

To check what exists, read the contract rather than asking us:

```
getSchedule(uint256 id)                      // the whole mandate
runnability(uint256 id)                      // is a payment due, funded, allowed
triggerability(uint256 id, address caller)   // may `caller` collect early
```

## Collecting a payment early

If the payer granted you the right — an address and a count, set when they
signed — you can take one payment before its due time:

```solidity
runNow(uint256 id, uint256 amountOutMinimum)   // call it yourself, you pay gas
```

It takes exactly one payment, of the amount the payer fixed, to the address the
payer fixed. It consumes one scheduled payment rather than adding one, it
cannot be repeated within 60 seconds, it stops at the granted count, and the
payer can withdraw the grant at any moment with `setTrigger(id, 0, 0)`.

No CELO for gas? `POST /functions/v1/trigger-run` does the same thing for 0.01
USDC and the facilitator pays the gas — provided the payer named **our**
executor (`0x3c754AD31e802D5fA65487f460dED65Aba749Cd1`) as the trigger.

---

## What this is not

Per-minute granularity, not per-call streaming: `MIN_TRIGGER_GAP` is 60
seconds. Gas of roughly $0.0005 a collection puts a floor under useful payment
sizes — a cent is sensible, a thousandth of one is not. Sub-cent streaming is
payment channels, and none of this is that.

The naira rails (cNGN to a wallet, or to a Nigerian bank account) are built and
switched off pending the regulatory work in the README. Today everything
settles in stablecoins.

`RemessoExecutorV4` is **unaudited**. It holds a spending allowance the moment
a payer approves it. That is worth knowing before you point real money at it.
