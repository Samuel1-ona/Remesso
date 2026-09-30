-- A sender who never opened the app.
--
-- `auth_user_id` was `not null` because every sender arrived the same way: an
-- anonymous Supabase session created a row, and the wallet was attached to it.
-- That stopped being the only way in the moment an agent could call
-- `createSchedule` directly. Such a schedule is real — the contract holds it,
-- the allowance is real, `runNow` moves it — but `execute-due-runs` takes its
-- work from this database, so without a row here its cadence never fires. It
-- is a valid mandate that silently never runs, which is the worst shape a
-- payment can have.
--
-- So a sender can now be a wallet and nothing else. The row is owned by no
-- auth user, which under RLS means it is visible to nobody: every policy
-- compares against `auth.uid()`, and null matches none of them. That is the
-- correct reading — a wallet that has never opened the app has no session to
-- show it to.
--
-- It stops being ownerless the moment that wallet does open the app:
-- `claim_sender` updates the row matching the wallet and sets `auth_user_id`
-- to the caller, so the schedules, recipients and run history discovered from
-- the chain follow it in. No merge, no duplicate row.
--
-- What this does NOT change: nothing here can move money. The contract checks
-- `msg.sender` for pause and cancel, and a mirror row only tells the executor
-- that a schedule exists — which the chain would have told it anyway.
alter table public.senders
  alter column auth_user_id drop not null;

comment on column public.senders.auth_user_id is
  'The anonymous Supabase user holding this wallet, or null for a sender '
  'discovered on-chain who has never opened the app. A null row is invisible '
  'under RLS until claim_sender binds it to a session.';
