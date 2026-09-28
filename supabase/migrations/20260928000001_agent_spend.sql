-- Every payment Remesso makes to another agent, written before it is signed.
--
-- This is a ledger first and a rate limiter second. The daily cap is computed
-- from these rows, so a row has to exist before the signature does: a row with
-- no payment is a question to answer later, while a payment with no row is
-- money nobody can account for — and an agent that spends money nobody can
-- account for is the thing everybody is afraid of.
--
-- Amounts are USDC base units (6dp) as text, like every other on-chain amount
-- in this schema: numeric would be fine at this scale and wrong at the next.
create table public.agent_spend (
  id            uuid primary key default gen_random_uuid(),
  url           text not null,
  -- Why this call was made, in the callers own words. Free text on purpose:
  -- an enum here would be a list of the reasons we thought of first.
  purpose       text not null default 'unspecified',
  amount_units  numeric(78,0) not null,
  pay_to        text,
  status        text not null default 'authorising',
  note          text,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz,

  constraint agent_spend_status_known check (
    status in ('authorising', 'paid', 'failed', 'refused')
  ),
  constraint agent_spend_amount_sane check (amount_units >= 0)
);

-- The daily cap reads this window on every paid call.
create index agent_spend_recent_idx on public.agent_spend (created_at desc)
  where status in ('authorising', 'paid');

-- Service role only. Senders have no business reading what the agent spends,
-- and nothing in the frontend writes here.
alter table public.agent_spend enable row level security;

comment on table public.agent_spend is
  'Payments Remesso made to other agents over x402. Written before signing; '
  'the rolling 24h sum of authorising+paid rows is the daily spend cap.';
