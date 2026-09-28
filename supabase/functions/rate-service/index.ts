/// A paid capability, sold to other agents for a tenth of a cent.
///
/// This exists to make the other half of the loop real. Remesso already sells
/// `trigger-run`, so agents can pay it; nothing could be paid BY it, and an
/// economy with one direction is a shop. This is a second, independent service
/// — the kind anybody could stand up — so the whole path can be exercised
/// end to end: one agent discovers a price, pays USDC, and gets an answer.
///
/// What it sells: the live USDT/NGN and USDC/NGN rate, as makers are actually
/// quoting it, with the spread and the depth available at that price. Remesso
/// needs this itself to set an honest floor, and a remittance agent pricing a
/// naira corridor needs it for the same reason.
///
/// The upstream feed is free and public. What a caller pays for is the
/// aggregation, the freshness guarantee and not having to know where it comes
/// from — which is what most paid endpoints are, stated plainly.
///
/// `verify_jwt = false`: the payment is the authentication.
import {
  decodePayment,
  encodeSettlement,
  paymentRequiredBody,
  requirements,
  settle,
  verify,
  X402,
} from "../_shared/x402.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-payment",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Expose-Headers": "x-payment-response",
};

/// A tenth of a cent. Small enough that an agent polling it every minute costs
/// pennies a day, large enough to be a real payment rather than a gesture.
const PRICE_UNITS = Deno.env.get("RATE_SERVICE_PRICE_UNITS") ?? "1000";

const FEED = "https://api.textilecredit.com/tickers";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const resource = `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1/rate-service`;

  // A GET describes the service and its price without charging. Discovery
  // should never cost money, or nobody discovers you.
  if (req.method === "GET") {
    return json({
      name: "naira-rate",
      description:
        "Live USDT/NGN and USDC/NGN rates with spread and available depth, " +
        "aggregated from on-chain RFQ makers.",
      price: { asset: "USDC", amount: PRICE_UNITS, decimals: 6, protocol: "x402", network: "celo" },
      call: "POST with an X-PAYMENT header; POST without one to see the 402.",
    });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (!X402.isConfigured) return json({ error: "this service is not configured to take payment" }, 503);

  const reqs = { ...requirements(resource, "Live NGN rate"), maxAmountRequired: PRICE_UNITS };

  const payment = decodePayment(req.headers.get("x-payment"));
  if (!payment) return json(paymentRequiredBody(reqs), 402);

  const check = await verify(payment, reqs);
  if (!check.ok) return json(paymentRequiredBody(reqs, check.reason ?? "payment invalid"), 402);

  // Fetch before settling. A caller who paid and got nothing is worse than a
  // caller who got nothing and paid nothing.
  let rates: Rate[];
  try {
    rates = await naira();
  } catch (e) {
    console.error("rate-service: upstream failed", (e as Error).message);
    return json({ error: "rates unavailable — you were not charged" }, 503);
  }

  const paid = await settle(payment, reqs);
  if (!paid.ok) console.error("rate-service: SETTLEMENT FAILED after serving", check.payer);

  return new Response(
    JSON.stringify({ rates, asOf: new Date().toISOString(), payer: check.payer ?? null }, null, 2),
    {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "X-PAYMENT-RESPONSE": encodeSettlement(paid.txHash),
      },
    },
  );
});

type Rate = {
  pair: string;
  bid: string;
  ask: string;
  mid: number;
  spreadBps: number | null;
};

async function naira(): Promise<Rate[]> {
  const res = await fetch(FEED, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const rows = await res.json() as Array<Record<string, string>>;

  return rows
    .filter((r) => (r.target_currency ?? "").toUpperCase() === "NGN")
    .map((r) => {
      const bid = Number(r.bid);
      const ask = Number(r.ask);
      // A zero bid means nobody is quoting that side right now. Reporting it
      // as a spread of "everything" would be arithmetic pretending to be
      // information.
      const both = bid > 0 && ask > 0;
      return {
        pair: r.ticker_id,
        bid: r.bid,
        ask: r.ask,
        mid: both ? (bid + ask) / 2 : Number(r.last_price),
        spreadBps: both ? Math.round(((ask - bid) / ((ask + bid) / 2)) * 10_000) : null,
      };
    });
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
