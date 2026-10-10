-- Private lockbox: one member's notes, never shared.
create table if not exists vault_notes (
  id         serial primary key,
  user_id    text not null,
  title      text not null,
  body       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vault_notes_user_id_idx on vault_notes (user_id);
