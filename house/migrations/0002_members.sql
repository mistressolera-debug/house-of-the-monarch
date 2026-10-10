-- Inner court: one row per signed-in member, plus audience requests.
create table if not exists members (
  user_id    text primary key,
  station    text not null default 'familiar',
  created_at timestamptz not null default now(),
  constraint members_station_check check (station in ('familiar', 'devotee', 'sovereign'))
);

create table if not exists audience_requests (
  id         serial primary key,
  user_id    text not null,
  duration   text not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  constraint audience_duration_check check (duration in ('half', 'hour'))
);
create index if not exists audience_requests_user_id_idx on audience_requests (user_id);
