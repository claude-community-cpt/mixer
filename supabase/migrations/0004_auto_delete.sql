-- Attendee data that deletes itself. A host sets a date on the event, and the
-- database removes that event's attendee data once the date has passed, with
-- no page open and nobody signed in.
--
-- Postgres has no built-in expiry for rows, so this is a small function run
-- every hour by pg_cron, the scheduler Supabase ships with.
--
-- Good to know: a project on Supabase's free plan is paused after about a week
-- without use, and a paused project runs no schedule. The delete then happens
-- within the hour of the project being woken. To be sure it runs on time, pick
-- a date within a few days of the event.

alter table public.events
  add column purge_at timestamptz,
  -- When the automatic delete last ran for this event.
  add column purged_at timestamptz;

create extension if not exists pg_cron;

-- Does what "Delete all attendee data" on the host page does (host.wipe in
-- app.ts). Keep the two in step.
create or replace function public.purge_due_events() returns integer
language plpgsql
set search_path = ''
as $$
declare
  due record;
  done integer := 0;
begin
  for due in select id from public.events where purge_at is not null and purge_at <= now() loop
    -- Seats, votes and ratings go with their guest.
    delete from public.guests where event_id = due.id;
    delete from public.rounds where event_id = due.id;
    delete from public.topics where event_id = due.id and source = 'guest';
    delete from public.registrations where event_id = due.id;
    -- The practice copy and everything in it.
    delete from public.events where practice_of = due.id;
    update public.events
      set phase = 'lobby', round = 0, round_ends_at = null, current_poll = null, purge_at = null, purged_at = now()
      where id = due.id;
    done := done + 1;
  end loop;
  return done;
end;
$$;

revoke all on function public.purge_due_events() from public, anon, authenticated;

select cron.schedule('purge-attendee-data', '7 * * * *', $job$select public.purge_due_events()$job$);
