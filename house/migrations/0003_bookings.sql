-- Booking desk: held hours on the house calendar.
create table if not exists bookings (
  id         serial primary key,
  user_id    text not null,
  starts_at  timestamptz not null,
  duration   text not null,
  status     text not null default 'held',
  note       text not null default '',
  created_at timestamptz not null default now(),
  constraint bookings_duration_check check (duration in ('half', 'hour')),
  constraint bookings_status_check check (status in ('held', 'cancelled'))
);
create index if not exists bookings_starts_at_idx on bookings (starts_at);
create index if not exists bookings_user_id_idx on bookings (user_id);
