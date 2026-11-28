-- The Claude & Coffee event flow: a table on arrival, topics in groups (one
-- group per round), a room vote, a wheel over the top three, a table host at
-- each table, a room discussion with an optional thumbs up or down, and new
-- tables every round.
--
-- Everything here adds to the schema, so the older "api" function keeps
-- working next to the new "mixer" function until the old one is retired.
-- As before, browsers never touch these tables: row level security is on with
-- no policies and all access goes through the Edge Function.

alter table public.events drop constraint events_phase_check;
alter table public.events add constraint events_phase_check
  check (phase in ('lobby', 'seating', 'vote', 'wheel', 'table', 'room', 'finished', 'round', 'poll'));

alter table public.events
  add column table_size int not null default 6 check (table_size between 2 and 12),
  add column vote_seconds int not null default 120 check (vote_seconds between 15 and 900),
  add column room_minutes int not null default 10 check (room_minutes between 1 and 60),
  add column votes_each int not null default 2 check (votes_each between 1 and 5),
  -- One name per round for its group of topics.
  add column group_names jsonb not null default '["Serious", "Practical", "Fun"]'::jsonb,
  -- The line under the guest's name on the keepsake card, such as the date and city.
  add column card_line text,
  -- Set on a practice copy of an event. Only practice events may hold pretend guests.
  add column practice_of uuid references public.events (id) on delete cascade;
create index events_practice_of_idx on public.events (practice_of);

-- What the sign-up form told us about each person. Still no readable email:
-- email_hash is the keyed fingerprint from migration 0002.
alter table public.registrations
  add column first_name text,
  add column experience text check (experience in ('daily', 'regular', 'occasional', 'new')),
  add column will_host boolean not null default false,
  add column role_group text,
  add column interest text,
  add column question text;

-- Copied onto the guest when they sign in, so seating can mix the room.
alter table public.guests
  add column email_hash text,
  add column experience text check (experience in ('daily', 'regular', 'occasional', 'new')),
  add column will_host boolean not null default false,
  add column role_group text,
  add column interest text,
  add column bot boolean not null default false;
-- One guest per sign-up email, so signing in again returns the same guest.
create unique index guests_event_email_idx on public.guests (event_id, email_hash) where email_hash is not null;

alter table public.seats
  add column is_host boolean not null default false,
  -- The guest was moved after being given a table (only a small last table is ever moved).
  add column moved boolean not null default false;

create table public.topics (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  -- The round this topic is voted on in. Empty while a suggestion waits for a host.
  grp int check (grp between 1 and 8),
  text text not null,
  status text not null default 'approved' check (status in ('approved', 'pending', 'hidden')),
  source text not null default 'host' check (source in ('signup', 'guest', 'host')),
  guest_id uuid references public.guests (id) on delete set null,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index topics_event_idx on public.topics (event_id);
create index topics_guest_idx on public.topics (guest_id);

create table public.topic_votes (
  event_id uuid not null references public.events (id) on delete cascade,
  round int not null,
  guest_id uuid not null references public.guests (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, round, guest_id, topic_id)
);
create index topic_votes_guest_idx on public.topic_votes (guest_id);
create index topic_votes_topic_idx on public.topic_votes (topic_id);

-- The result of each round's vote and wheel.
create table public.rounds (
  event_id uuid not null references public.events (id) on delete cascade,
  round int not null,
  top_ids uuid[] not null default '{}',
  top_votes int[] not null default '{}',
  topic_id uuid references public.topics (id) on delete set null,
  topic_text text,
  spun_at timestamptz,
  primary key (event_id, round)
);
create index rounds_topic_idx on public.rounds (topic_id);

create table public.ratings (
  event_id uuid not null references public.events (id) on delete cascade,
  round int not null,
  guest_id uuid not null references public.guests (id) on delete cascade,
  up boolean not null,
  primary key (event_id, round, guest_id)
);
create index ratings_guest_idx on public.ratings (guest_id);

-- Who may sign in to the host page, next to the event PIN. Only a one-way
-- hash of each host's email is kept: sha256('host:' || lower(email)).
-- A row with no event is a host of every event. Rows are added by hand in the
-- database, never from this repository:
--   insert into hosts (email_hash, label)
--   values (encode(sha256(convert_to('host:' || lower('<email>'), 'UTF8')), 'hex'), '<first name>');
create table public.hosts (
  email_hash text primary key,
  label text not null default '',
  event_id uuid references public.events (id) on delete cascade
);
create index hosts_event_idx on public.hosts (event_id);

alter table public.topics enable row level security;
alter table public.topic_votes enable row level security;
alter table public.rounds enable row level security;
alter table public.ratings enable row level security;
alter table public.hosts enable row level security;

revoke all on public.topics, public.topic_votes, public.rounds, public.ratings, public.hosts from anon, authenticated;
