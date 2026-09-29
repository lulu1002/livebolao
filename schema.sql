-- Schema do Bolão. O servidor executa este arquivo ao iniciar (é seguro repetir).
-- Você também pode colar no SQL Editor do Supabase.

create table if not exists users (
  id           text primary key,
  twitch_id    text not null unique,
  login        text not null,
  display_name text not null,
  avatar_url   text,
  is_house     boolean not null default false, -- conta fictícia ("a casa"), sem login real
  created_at   timestamptz not null default now()
);
alter table users add column if not exists is_house boolean not null default false;

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
  position integer not null,
  is_house boolean not null default false -- opção oculta usada só quando "a casa ganha"
);
alter table poll_options add column if not exists is_house boolean not null default false;
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

-- Níveis de conquista, editáveis pelo admin em /admin (nome, emoji, imagem e
-- meta de cada um). "code" em achievements guarda o id daqui, sem uma foreign
-- key de verdade — mesmo estilo usado em awards.poll_id, pra não travar a
-- limpeza quando um nível é apagado (feita à parte, no servidor).
create table if not exists achievement_defs (
  id         text primary key,
  type       text not null check (type in ('points', 'streak')),
  threshold  integer not null check (threshold > 0),
  label      text not null,
  emoji      text not null default '🏆',
  image_url  text,
  created_at timestamptz not null default now()
);

-- Só semeia os níveis padrão na primeira vez (tabela vazia). Depois disso, o
-- admin manda: editar, apagar ou criar novos não é desfeito nos próximos deploys.
insert into achievement_defs (id, type, threshold, label, emoji)
select * from (values
  ('points_50', 'points', 50, 'Bronze', '🥉'),
  ('points_150', 'points', 150, 'Prata', '🥈'),
  ('points_300', 'points', 300, 'Ouro', '🥇'),
  ('points_600', 'points', 600, 'Platina', '💎'),
  ('streak_3', 'streak', 3, 'Em chamas', '🔥'),
  ('streak_5', 'streak', 5, 'Imparável', '⚡'),
  ('streak_10', 'streak', 10, 'Lendário', '👑')
) as seed(id, type, threshold, label, emoji)
where not exists (select 1 from achievement_defs);

-- Emblemas desbloqueados por participante. Nunca é apagado (nem ao zerar o
-- ranking): uma vez conquistado, o emblema fica para sempre, a não ser que o
-- admin apague o nível em si (aí some pra todo mundo que tinha).
create table if not exists achievements (
  user_id     text not null references users(id) on delete cascade,
  code        text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, code)
);

create table if not exists settings (
  key   text primary key,
  value text not null
);

-- Inscrições de notificação push do navegador. Não depende de login: qualquer
-- visitante que aceitar o convite entra aqui.
create table if not exists push_subscriptions (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
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
alter table achievements  enable row level security;
alter table achievement_defs enable row level security;
alter table sessions      enable row level security;
alter table push_subscriptions enable row level security;
