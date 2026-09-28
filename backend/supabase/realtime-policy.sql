-- Supabase Realtime authorization for servd staff channels.
--
-- Run once in the Supabase SQL editor of the project named by SUPABASE_URL.
-- Then, in Dashboard → Realtime → Settings, turn OFF "Allow public access"
-- so that only private channels (the ones this policy guards) can be joined.
--
-- How it works: the servd API mints a short-lived JWT for each staff session
-- (GET /api/v1/auth/realtime-token) signed with this project's JWT secret.
-- Its `servd_topics` claim lists exactly the channels that person may hear
-- (tenant:{id}:orders, station:{id}, …), computed by the same code that
-- decides socket.io room membership. Realtime evaluates this policy when the
-- client joins a channel and again whenever it presents a new token.
--
-- Clients never send: there is deliberately no INSERT policy, so a browser
-- cannot broadcast into a kitchen feed. Only the API (service role key,
-- which bypasses RLS) publishes.
--
-- realtime.messages already has RLS enabled — do NOT run ALTER TABLE on it
-- (it fails with "must be owner").

drop policy if exists "servd staff receive their own topics" on realtime.messages;

create policy "servd staff receive their own topics"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and realtime.topic() = any (
    array(
      select jsonb_array_elements_text(
        coalesce(
          (current_setting('request.jwt.claims', true)::jsonb -> 'servd_topics'),
          '[]'::jsonb
        )
      )
    )
  )
);
