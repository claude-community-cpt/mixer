-- Matching guests to the event sign-up list (for example the approved guests
-- on Luma) without keeping anyone's email address.
--
-- The host loads the list on the host page. The server turns each address
-- into a keyed fingerprint (HMAC-SHA256 with a secret that is not in this
-- database) and keeps only the fingerprint. When a guest joins they type the
-- address they registered with, the server fingerprints it the same way and
-- looks for a match. The address itself is never written anywhere.

create table public.registrations (
  event_id uuid not null references public.events (id) on delete cascade,
  email_hash text not null,
  -- The guest who arrived with this sign-up, so the host can see how many have arrived.
  guest_id uuid references public.guests (id) on delete set null,
  primary key (event_id, email_hash)
);
create index registrations_guest_idx on public.registrations (guest_id);

-- true: matched a sign-up. false: joined with an address that was not on the
-- list. null: not checked (no list loaded, or added by the host).
alter table public.guests add column registered boolean;

alter table public.registrations enable row level security;
revoke all on public.registrations from anon, authenticated;
