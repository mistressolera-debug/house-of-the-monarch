-- Deposits are tribute on Throne. Pending occupies the hour until matched or expired.
alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('pending', 'held', 'cancelled'));

alter table bookings add column if not exists tribute_code text;
alter table bookings add column if not exists deposit_cents integer not null default 0;
alter table bookings add column if not exists tribute_event_id text;
alter table bookings add column if not exists tribute_sent_at timestamptz;

create unique index if not exists bookings_tribute_code_uidx
  on bookings (tribute_code) where tribute_code is not null;
create unique index if not exists bookings_tribute_event_uidx
  on bookings (tribute_event_id) where tribute_event_id is not null;
