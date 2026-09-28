/// What Remesso is, in the form another program can read.
///
/// An agent that cannot be described cannot be called. This is the document a
/// caller needs before it does anything: who this agent is, what it will do,
/// what that costs, and — the part most capability docs leave out — what it
/// will refuse. The refusals are the interesting half, because they are the
/// reason a sender is willing to leave a mandate lying around for an agent to
/// draw on.
///
/// Public and unauthenticated (`verify_jwt = false`): a capability document
/// nobody can fetch without credentials is not discovery. It contains no
/// secret, quotes no sender, and names no schedule.
import { CELO, SELF_API } from "../_shared/config.ts";
import { ATTRIBUTION_CODE } from "../_shared/attribution.ts";
import { X402 } from "../_shared/x402.ts";
import { executorAccount, executorV4 } from "../_shared/celo.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const BASE = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");

/// The address a payer grants. Undefined rather than a throw if the key is
/// missing: a capability document that 500s teaches a caller nothing.
function triggerAddress(): string | undefined {
  try {
    return executorAccount().address;
  } catch {
    return undefined;
  }
}

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  return json({
    name: "Remesso",
    description:
      "Recurring stablecoin payments on Celo, bound by a mandate the payer signs " +
      "on-chain. Another agent can bring a payment forward; nothing can redirect, " +
      "resize or extend one.",

    // Identity, so a caller can check who they are dealing with rather than
    // trusting this document. The agent id is soulbound to a human who proved
    // themselves with a passport.
    identity: {
      /// ERC-8004, so an agent can find this one through the registry rather
      /// than because somebody handed over a URL. The metadata there is a
      /// `data:` URI inside the token: what was registered cannot be changed
      /// afterwards by whoever still controls a server.
      erc8004: {
        agentId: 9867,
        registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
        chainId: 42220,
      },
      selfAgentId: Deno.env.get("SELF_AGENT_ID") ?? "191",
      agentAddress: Deno.env.get("SELF_AGENT_ADDRESS") ??
        "0x5C3EBb0084233156ba51a5C2dfD42d88d5a74CA6",
      registry: "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944",
      proof: "self-agent-id",
      humanVerified: true,
    },

    chain: {
      network: "celo",
      chainId: CELO.chainId,
      executor: executorV4 || CELO.executor,
      /// The address a payer names as `trigger` if they want Remesso able to
      /// collect on their behalf — which is what makes `trigger-run` usable
      /// for their schedule at all.
      // Derived from the signing key, not configured: an address is public
      // and a second copy of it is a second thing to keep in step.
      trigger: triggerAddress(),
      attributionCode: ATTRIBUTION_CODE,
    },

    services: [
      {
        name: "naira-rate",
        description:
          "Live USDT/NGN and USDC/NGN rates with spread, from on-chain RFQ makers. " +
          "What Remesso uses to price a naira corridor honestly.",
        endpoint: `${BASE}/functions/v1/rate-service`,
        method: "POST",
        input: {},
        payment: X402.isConfigured
          ? {
            protocol: "x402",
            version: 1,
            network: "celo",
            asset: "USDC",
            amount: Deno.env.get("RATE_SERVICE_PRICE_UNITS") ?? "1000",
            decimals: 6,
            facilitator: X402.base,
            discover: "POST without X-PAYMENT and read the 402 body",
          }
          : { protocol: "none", note: "not configured to take payment" },
        refusals: [
          "503 if the upstream rate feed is unreachable — you are not charged",
        ],
      },
      {
        name: "capabilities",
        description: "This document. Free, because discovery that costs money is discovery nobody does.",
        endpoint: `${BASE}/functions/v1/agent`,
        method: "GET",
        payment: { protocol: "none" },
      },
      {
        name: "trigger-run",
        description:
          "Bring one payment of an existing schedule forward. The caller buys " +
          "timing and nothing else.",
        endpoint: `${BASE}/functions/v1/trigger-run`,
        method: "POST",
        input: { schedule: "on-chain schedule id, as a decimal string" },
        payment: X402.isConfigured
          ? {
            protocol: "x402",
            version: 1,
            network: "celo",
            asset: "USDC",
            amount: X402.priceUnits,
            decimals: 6,
            facilitator: X402.base,
            /// Unpaid calls answer 402 with the exact requirements, so a
            /// caller never has to take this document's word for the price.
            discover: "POST without X-PAYMENT and read the 402 body",
          }
          : { protocol: "none", note: "paid triggering is not configured" },
        refusals: [
          "403 if the schedule's payer did not grant this executor the right to collect",
          "403 once the granted collections are used up",
          "403 within 60 seconds of the previous collection",
          "409 if the payment itself reverts — the caller is not charged",
        ],
      },
    ],

    /// What a payer's mandate can never be made to do, whoever is asking.
    guarantees: [
      "The recipient is fixed when the payer signs and cannot be changed by anyone.",
      "The amount per payment is fixed at the same moment.",
      "A collection consumes one scheduled payment; it never adds one.",
      "Collections stop at the count the payer granted, and at their end date.",
      "The payer can withdraw the grant at any time, without our cooperation.",
      "Revoking the token allowance stops everything, also without our cooperation.",
    ],

    verification: {
      contract: `https://celoscan.io/address/${executorV4 || CELO.executor}`,
      source: "https://github.com/crackedstudio/Remesso",
      /// Anyone can read the mandate themselves instead of believing this.
      reads: {
        triggerability: "triggerability(uint256 id, address caller) view",
        schedule: "getSchedule(uint256 id) view",
      },
    },

    identityChecksAvailable: SELF_API.isConfigured,
  });
});

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      // A capability document changes rarely and is polled by machines.
      "Cache-Control": "public, max-age=300",
    },
  });
