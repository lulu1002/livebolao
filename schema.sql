-- Schema do Bolão. O servidor executa este arquivo ao iniciar (é seguro repetir).
-- Você também pode colar no SQL Editor do Supabase.

create table if not exists users (
  id           text primary key,
  twitch_id    text not null unique,
  login        text not null,
  display_name text not null,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table if not exists polls (
  id                text primary key,
  title             text not null,
  description       text not null default '',
  points            integer not null default 10 check (points between 1 and 1000),
  closes_at         timestamptz,
  closed            boolean not null default false,
  visible           boolean not null default true,
  counted           boolean not null default true,
  correct_option_id text,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);

create table if not exists poll_options (
  id       text primary key,
  poll_id  text not null references polls(id) on delete cascade,
  label    text not null,
  position integer not null
);
create index if not exists poll_options_poll_idx on poll_options(poll_id);

create table if not exists votes (
  poll_id  text not null references polls(id) on delete cascade,
  user_id  text not null references users(id) on delete cascade,
  option_id text not null references poll_options(id) on delete cascade,
  voted_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);

-- Pontos guardados de enquetes já apagadas
create table if not exists awards (
  id         bigserial primary key,
  poll_id    text not null,
  poll_title text not null,
  user_id    text not null references users(id) on delete cascade,
  hit        boolean not null,
  points     integer not null,
  resolved_at timestamptz
);
alter table awards add column if not exists resolved_at timestamptz;
create index if not exists awards_user_idx on awards(user_id);

create table if not exists settings (
  key   text primary key,
  value text not null
);

create table if not exists sessions (
  token_hash text primary key,
  kind       text not null,
  user_id    text references users(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists sessions_expires_idx on sessions(expires_at);

-- O Supabase expõe tabelas do schema "public" pela API REST (chave anon).
-- Ligar o RLS sem criar políticas bloqueia esse acesso; o servidor usa a
-- connection string do Postgres, que não é afetada.
alter table users         enable row level security;
alter table polls         enable row level security;
alter table poll_options  enable row level security;
alter table votes         enable row level security;
alter table awards        enable row level security;
alter table settings      enable row level security;
alter table sessions      enable row level security;
