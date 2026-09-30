-- Look for schedules created without the app, every five minutes.
--
-- Not every minute, like the executor: this is discovery, not payment. A
-- schedule found five minutes late still fires on time unless it was created
-- within five minutes of its first run, and the agent that creates one can
-- pull it immediately with `runNow` in the meantime. Scanning the id range on
-- every tick to find nothing, sixty times an hour, is work with no reader.
select cron.unschedule('remesso-sync-schedules')
where exists (select 1 from cron.job where jobname = 'remesso-sync-schedules');

select cron.schedule(
  'remesso-sync-schedules',
  '*/5 * * * *',
  $$ select public.invoke_edge_function('sync-schedules'); $$
);
