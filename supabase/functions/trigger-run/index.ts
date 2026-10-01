/// A paid endpoint that asks Remesso to send a payment now.
///
/// This is the part that makes Remesso callable rather than only watchable. An
/// app, a person or another agent pays a cent in USDC or USAT over x402 and one run of
/// a schedule fires ahead of its cadence. No account, no API key, no invoice —
/// the payment IS the authentication.
///
/// What it cannot do, and this is the whole design:
///   - it cannot choose the destination, the amount, the asset or the rate
///   - it cannot run a schedule whose sender did not nominate this executor as
///     its trigger, and did not authorise early sends
///   - it cannot exceed the run cap, the expiry, the floor, or the sender's
///     ERC20 allowance
///   - it cannot bring forward a naira payout while the cNGN rails are off
///
/// The caller is buying timing. Everything else was fixed when the sender
/// signed, and `runNow` re-checks all of it on-chain.
///
/// Order of operations: verify the payment, run, then settle. A caller whose
/// run reverts is not charged; a caller who is charged got their run.
import {
  executorAccount,
  executorV4,
  getSchedule,
  runNow,
  triggerability,
  v4Runnability,
} from "../_shared/celo.ts";
import { CNGN_RAILS_ENABLED, PAYOUT_DIRECT, RAIL_DISABLED_DETAIL } from "../_shared/rails.ts";
import {
  decodePayment,
  paymentRequired,
  requirements,
  settle,
  settlementHeaders,
  verify,
  X402,
  X402_CORS,
} from "../_shared/x402.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Without these an agent's browser-side client can neither discover the
  // price nor read the settlement.
  ...X402_CORS,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (!X402.isConfigured || !executorV4) {
    return json({ error: "paid triggering is not available" }, 503);
  }

  let body: { schedule?: string | number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const raw = String(body.schedule ?? "");
  if (!/^\d{1,78}$/.test(raw)) return json({ error: "schedule must be an on-chain id" }, 400);
  const id = BigInt(raw);

  // The canonical, public URL of this endpoint. Not `req.url`: behind
  // Supabase's proxy that arrives as http:// and without the /functions/v1
  // prefix, and `resource` is part of what the payer signs — a payment scoped
  // to a URL that does not exist is a bad receipt and a worse audit trail.
  const resource = Deno.env.get("X402_RESOURCE_URL") ||
    `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1/trigger-run`;
  const accepts = requirements();
  const what = { url: resource, description: `Send schedule #${raw} now`, mimeType: "application/json" };

  // Ask the contract before charging anyone. A schedule nobody nominated this
  // executor for is a 402 that would always fail, so it is a 403 instead —
  // the caller should not pay to discover that.
  let canTrigger: boolean;
  let floor: bigint;
  let payoutType: number;
  try {
    const t = await triggerability(id);
    canTrigger = t.canTrigger;
    floor = (await v4Runnability(id)).floor;
    payoutType = (await getSchedule(id)).payoutType;
  } catch (e) {
    console.error("trigger-run: chain read failed", (e as Error).message);
    return json({ error: "could not read the schedule" }, 502);
  }

  // A cNGN schedule is refused here, not priced. The contract would happily
  // run it — the rails are compiled in and immutable — so this endpoint is one
  // of only two places that can decline, and the rail is read from the chain
  // rather than from our mirror of it because a payer is about to spend money
  // on the answer.
  if (!CNGN_RAILS_ENABLED && payoutType !== PAYOUT_DIRECT) {
    return json({ error: "this schedule cannot be triggered", detail: RAIL_DISABLED_DETAIL }, 403);
  }

  if (!canTrigger) {
    return json({
      error: "this schedule cannot be triggered",
      detail:
        "its sender has not authorised early sends for this executor, or none are left, " +
        "or the schedule is paused, expired, finished, or was triggered in the last minute",
      trigger: executorAccount().address,
    }, 403);
  }

  // --- the 402 half ------------------------------------------------------
  const payment = decodePayment(req);
  if (!payment) {
    const q = paymentRequired(accepts, what);
    return json(q.body, 402, q.headers);
  }

  // Settlement must reuse the entry that verified — see `verify`.
  const check = await verify(payment, accepts, what);
  if (!check.ok || !check.matched) {
    const q = paymentRequired(accepts, what, check.reason ?? "payment invalid");
    return json(q.body, 402, q.headers);
  }

  // --- the work ----------------------------------------------------------
  let hash: string;
  try {
    const out = await runNow(id, floor);
    hash = out.hash;
  } catch (e) {
    // Nothing is settled, so nothing is charged. The contract's own revert is
    // the honest answer: it knows why better than this handler does.
    console.error("trigger-run: runNow reverted", raw, (e as Error).message);
    return json({ error: "the run did not go through", detail: (e as Error).message.slice(0, 200) }, 409);
  }

  // --- settlement --------------------------------------------------------
  const paid = await settle(payment, check.matched, what);
  if (!paid.ok) {
    // The run happened and we were not paid for it. Loud, because it is our
    // loss and the caller's free lunch — and because a facilitator failing
    // here repeatedly is a bug, not weather.
    console.error("trigger-run: SETTLEMENT FAILED after a successful run", raw, hash);
  }

  return new Response(JSON.stringify({ ok: true, schedule: raw, txHash: hash, settled: paid.ok }), {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      ...settlementHeaders(paid.txHash),
    },
  });
});

const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
