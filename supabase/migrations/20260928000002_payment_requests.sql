-- An agent asking to be paid.
--
-- The reverse of every other table here: nothing in it is authorised, signed,
-- or owed. A row is one stranger's claim that they would like a recurring
-- payment, addressed to a wallet. It becomes a payment only when the sender
-- opens it, reads it, edits whatever they like and signs a schedule in their
-- own wallet — at which point the real record is the contract, as always.
--
-- So the safety property is not in the permissions, it is in the shape: there
-- is no column that can make money move, and no code path from a row here to
-- `createSchedule`. The worst a hostile row achieves is a prefilled form the
-- sender is shown and must accept.
create table public.payment_requests (
  id            uuid primary key default gen_random_uuid(),

  -- Who is being asked. An address, not a sender id: whoever is asking knows
  -- a wallet and nothing else about us, which is the point.
  payer_address text not null,
  -- Where the money would go if the sender agrees.
  to_address    text not null,

  -- The terms being proposed, all optional and all editable by the sender.
  -- Text at the token's own scale rather than numeric, like every other
  -- amount in this schema.
  amount        text,
  token_symbol  text,
  interval_seconds integer,
  max_runs      integer,

  -- Who is asking, in their own words, and why. Free text, shown to a human,
  -- length-capped here as well as in the function: a constraint the database
  -- enforces survives a handler somebody edits later.
  from_name     text,
  note          text,

  status        text not null default 'pending',
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,

  constraint payment_requests_payer_is_address check (payer_address ~ '^0x[a-fA-F0-9]{40}$'),
  constraint payment_requests_to_is_address check (to_address ~ '^0x[a-fA-F0-9]{40}$'),
  constraint payment_requests_status_known check (status in ('pending', 'dismissed', 'used')),
  constraint payment_requests_text_bounded check (
    coalesce(length(from_name), 0) <= 40 and coalesce(length(note), 0) <= 120
  ),
  constraint payment_requests_terms_sane check (
    coalesce(interval_seconds, 60) >= 60 and coalesce(max_runs, 1) > 0
  )
);

create index payment_requests_for_payer_idx
  on public.payment_requests (lower(payer_address), created_at desc)
  where status = 'pending';

-- Service role only. The Edge Function writes; the frontend reads through the
-- function below rather than directly, because a wallet address is a claim
-- here (MiniPay cannot sign, see CLAUDE.md) and RLS keyed on an unproven claim
-- would be a permission that only looks like one.
alter table public.payment_requests enable row level security;

-- What a sender sees: requests addressed to their wallet, newest first.
--
-- `security definer` and deliberately readable by anyone who names the
-- address. These rows are inbound requests to be paid — the same thing as an
-- invoice arriving in an inbox — and they contain nothing the recipient of the
-- request did not already know. Nothing here is private to the payer, and
-- guessing a wallet address buys the guesser a list of people who asked it for
-- money.
create or replace function public.payment_requests_for(p_address text)
returns setof public.payment_requests
language sql
security definer
set search_path = public
as $$
  select *
  from public.payment_requests
  where lower(payer_address) = lower(p_address)
    and status = 'pending'
    and created_at > now() - interval '30 days'
  order by created_at desc
  limit 20;
$$;

grant execute on function public.payment_requests_for(text) to anon, authenticated;

-- Dismissing one. The only write a sender makes, and it cannot do anything but
-- hide a row from their own list.
create or replace function public.dismiss_payment_request(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.payment_requests
  set status = 'dismissed', responded_at = now()
  where id = p_id and status = 'pending';
$$;

grant execute on function public.dismiss_payment_request(uuid) to anon, authenticated;

comment on table public.payment_requests is
  'Inbound "please pay me" requests from agents. Advisory only: a row prefills '
  'a form and can never create a schedule or move money.';
