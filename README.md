# Table Mixer

The check-in, table and topic app for the Cape Town Claude community coffee mornings.

Guests scan a QR code, type a first name (and the email they registered with) and get a table straight away. Each round the room votes on a topic, a wheel picks one of the top three, tables talk about it with a table host to get things going, and then the room talks about it together. Everyone gets a new table and a mostly new group each round, and a keepsake card at the end.

A volunteer-run community tool. Not an Anthropic product.

Live at https://claudecapetown.com/mixer/ (and, as a fallback, https://table-mixer.vercel.app).
The event it opens by default is `VITE_EVENT_CODE` in `web/.env`; any other event opens with `?e=<code>` on the address.

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | Guests (phone) | Join, see your table and table mates, suggest a topic, vote, see the round's topic, rate it, save your card |
| `/screen` | Projector | QR code and check-in count, the live vote, the wheel, the topic and timer, the new tables |
| `/host` | Hosts (email and PIN) | Move the event on, review topics, manage guests and table hosts, load the sign-up list, settings, practice event, delete data. Works on a phone: the next-step button stays pinned to the bottom of the screen |

Add `?e=<event code>` to any path to use an event other than the default in `web/.env`.

## How an event runs

| Step | Phones | Big screen | Moves on when |
| --- | --- | --- | --- |
| Doors open | Table number, table mates, "suggest a topic" | QR code, people checked in | A host starts round 1 voting |
| Vote | The round's topics, pick up to two. No results | Live results | The timer ends, or a host ends it |
| Wheel | "Eyes on the big screen" | The top three on a wheel | A host spins, then starts the table discussion |
| Table discussion | The topic, and for the table host a short list of what to do | The topic and a countdown | The timer ends, or a host ends it |
| Room discussion | The topic, optional thumbs up or down | The topic | A host gives out the next tables |
| New tables (rounds 2 and up) | The new table number and who is there | Every table | A host starts the vote |
| Finished | A keepsake card to save or share | Thanks | |

Phones and the big screen follow along by themselves. A guest who refreshes or closes the page comes back to the same place, and a guest who signs in again with the same name and email gets their seat back.

Each round votes on its own group of topics. The groups are named in Setup (by default "Serious", "Practical" and "Fun"). A guest's suggestion reaches the vote only after a host has read it and added it to a group.

## Seating

The logic is in `supabase/functions/mixer/assign.ts`, with tests next to it.

- **On arrival** a guest gets a table at once and keeps it. Two tables fill at a time, a newcomer goes to the one where they add the most variety, and the next table opens when one is full.
- **When round 1 starts**, a last table with half a table of people or fewer is folded into the other tables, as long as no table goes more than one over its size. Nobody else moves.
- **Later rounds** are worked out when the round starts, from who is in the room. The search keeps tables full and even, avoids pairs who have already sat together and tables a guest has already sat at, mixes experience levels and kinds of work, and puts someone who offered to host at every table when there are enough of them.
- **Table hosts** come from the people who ticked "happy to host a table" at sign-up. The one who has hosted least is picked. A table with no volunteer is asked "who will kick things off?", and a host can name anyone from the host page.
- **Latecomers** go to the smallest table in use.

## The sign-up list and privacy

On the host page, "Sign-up list" takes the guest export from the event page as a .csv (or pasted email addresses). The file is read in the browser. Only approved guests are kept, and only what the app needs is sent on: email, first name, how often they use Claude, whether they offered to host, a broad kind of work, and their question.

- **No email address is stored.** The server turns each address into a keyed one-way fingerprint and keeps only that. A guest's address at the door is fingerprinted the same way, compared, and thrown away. A guest who is not found is offered "Join anyway" and shows on the host page as "not on the sign-up list", so a typo never turns anyone away.
- **Hosts** sign in with their email and the event PIN. Host emails are also kept only as a one-way hash, in the `hosts` table. Rows are added by hand in the database (the SQL is in `supabase/migrations/0003_event_flow.sql`), never from this repository. Five wrong tries lock the host page for five minutes.
- **The keepsake card** is drawn on the guest's own phone. Nothing is uploaded.
- **Afterwards**, "Delete all attendee data" on the host page removes guests, seats, votes, ratings and the sign-up list. Do it within 30 days of the event.

Never commit a guest export, an attendee list, a host's contact details, a service role key or a host PIN to this repository.

## Practice events

"Practise with pretend guests" on the host page makes a copy of the event called `<code>-practice`, with the same topics and settings, short timers and as many pretend guests as you ask for. The pretend guests arrive, vote, suggest topics and rate by themselves, so one person can run the whole flow, join from their own phone and open the big screen. Nothing in a practice event touches the real one, and starting a practice again replaces the last one.

## Layout

- `web/`: React + Vite + TypeScript front end.
- `supabase/migrations/`: database schema.
- `supabase/functions/mixer/`: the Edge Function all pages talk to. `index.ts` is the HTTP wrapper, `app.ts` holds every action, `assign.ts` the seating, `emails.ts` the fingerprints. `fakedb.ts` and `scenario.ts` are for tests.
- `scripts/simulate.ts`: runs a whole event against the live API with pretend guests.

## How it fits together

Browsers never read or write tables directly. Row level security is on with no policies, and every request goes through the `mixer` Edge Function, which uses the service role. Guests are identified by a random token kept on their phone.

Live updates use a Supabase Realtime broadcast on `event:<code>` that only says "something changed". Pages then refetch, and also poll every 8 seconds in case the socket drops. Timed steps (the vote and the table discussion) end on the server the first time anyone asks for the event after the deadline, so no page has to stay open to keep time.

## Design

The look follows the community site, https://claudecapetown.com: ivory background, ink text, coral accent, serif display headings, pill buttons and soft white cards. The tokens at the top of `web/src/styles.css` use the same names and values as that site (`--coral`, `--ivory`, `--ink` and so on), so a change there can be copied across.

- Fonts are Lora and Poppins from Google Fonts, which are the site's own fallbacks. The site's licensed display fonts and the logo image are not copied into this repo.
- Dark mode follows the device's setting. There is no toggle.
- Tables each get one of eight colours (`--t1` to `--t8`) so a guest can match the number on their phone to the big screen.
- The stickers on the keepsake card are the community's own, copied from the website repository into `web/src/assets/stickers/`.

## Deploying

- **Front end**: merging to `main` updates both copies. `.github/workflows/pages.yml` publishes to GitHub Pages at `claudecapetown.com/mixer/` (GitHub serves this repository under the organisation site's domain, at a path equal to the repository's name), and the Vercel project `table-mixer` (root directory `web`) follows `main` too. Addresses on Pages end in a slash (`/mixer/host/`).
- **Backend**: merging does not deploy anything under `supabase/`. Apply new migrations to the Supabase project, then deploy the function with JWT checks off, since it does its own sign-in:

  ```sh
  supabase functions deploy mixer --no-verify-jwt
  ```

  Through the Supabase connector, where sending every file is slow, the function can be deployed as a copy of `index.ts` whose `./app.ts` import is the raw GitHub address of that file at one exact commit. Supabase fetches it when it builds the function, so redeploy with the new commit after every change.

## Development

Use `bun`.

```sh
cd web
bun install
bun run dev      # local dev server
bun run lint     # Biome lint
bun run build    # type-check and build

cd ..
bun test supabase/functions/mixer web/src   # seating, a whole event in memory, sign-up file reading
API_URL=https://<project-ref>.supabase.co/functions/v1/mixer \
  EVENT_CODE=<test event> HOST_EMAIL=<a host's email> HOST_PIN=<pin> GUESTS=70 bun scripts/simulate.ts
```

`flow.test.ts` runs a whole 70-guest event against an in-memory stand-in for the database, so most changes can be checked without touching Supabase.

The simulation wipes the event it runs against, so only point it at a test event, never one people are using. It refuses the event codes `coffee` and `demo`.

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`:

- **Web app**: `bun run lint` (Biome, rules in `web/biome.json`), `bun run typecheck` and `bun run build`.
- **Tests**: `bun test supabase/functions/mixer web/src`.
- **Backend function**: `deno lint supabase/functions scripts` and `deno check supabase/functions/mixer/index.ts`.

CodeQL runs separately from `codeql.yml`. CI never talks to Supabase, so it does not touch any event.

`web/.env` holds only public values (project URL, publishable key, default event code).
