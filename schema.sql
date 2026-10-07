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

-- Configurações em formato chave/valor. Fica no topo porque os trechos de
-- semeadura mais abaixo consultam esta tabela.
create table if not exists settings (
  key   text primary key,
  value text not null
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

-- Tópicos (categorias) das enquetes, ex.: Geral, Casa. O admin cria, renomeia e
-- apaga no painel. Só semeia os dois padrão na primeira vez (tabela vazia).
create table if not exists poll_topics (
  id         text primary key,
  name       text not null,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists poll_topics_name_idx on poll_topics (lower(name));
insert into poll_topics (id, name, position)
select * from (values ('geral', 'Geral', 0), ('casa', 'Casa', 1)) as seed(id, name, position)
where not exists (select 1 from poll_topics);

-- Cada enquete pertence a um tópico. As que já existiam vão para "Geral".
alter table polls add column if not exists topic_id text references poll_topics(id);
update polls set topic_id = 'geral'
where topic_id is null and exists (select 1 from poll_topics where id = 'geral');

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
  type       text not null check (type in ('points', 'streak', 'misses', 'missstreak', 'titles')),
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

-- Liga/desliga a exibição do nível para os participantes (o desbloqueio continua
-- sendo registrado por baixo; ao reativar, quem já tinha volta a ver o emblema).
alter table achievement_defs add column if not exists active boolean not null default true;

-- Conquistas negativas: 'misses' = total de enquetes erradas, 'missstreak' = erros
-- seguidos. Bancos antigos têm a constraint só com points/streak, então ela é recriada.
-- Remove qualquer regra antiga sobre a coluna "type" (seja qual for o nome) e põe a nova.
-- NOT VALID: vale para linhas novas/editadas, mas não trava o deploy por causa de uma
-- linha antiga com tipo desconhecido.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'achievement_defs'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%type%'
  loop
    execute format('alter table achievement_defs drop constraint %I', c.conname);
  end loop;
end $$;
alter table achievement_defs add constraint achievement_defs_type_check
  check (type in ('points', 'streak', 'misses', 'missstreak', 'titles')) not valid;

-- Níveis negativos padrão, semeados uma única vez (a flag em settings impede de
-- voltarem depois que o admin editar ou apagar).
-- Nascem ocultas (active = false): o admin liga uma a uma no painel quando quiser.
insert into achievement_defs (id, type, threshold, label, emoji, active)
select * from (values
  ('missstreak_3', 'missstreak', 3, 'Pé frio', '🥶', false),
  ('missstreak_5', 'missstreak', 5, 'Maré de azar', '🌧️', false),
  ('missstreak_10', 'missstreak', 10, 'Maldição', '💀', false),
  ('misses_10', 'misses', 10, 'Chutador', '🎲', false),
  ('misses_25', 'misses', 25, 'Anti-vidente', '🔮', false),
  ('misses_50', 'misses', 50, 'Mestre do erro', '🤡', false)
) as seed(id, type, threshold, label, emoji, active)
where not exists (select 1 from settings where key = 'neg_achievements_seeded');
insert into settings (key, value) values ('neg_achievements_seeded', '1')
on conflict (key) do nothing;

-- Migração única: bancos que já tinham as negativas visíveis passam a ocultá-las.
-- A flag garante que isso roda só uma vez; depois, o que o admin ligar fica ligado.
update achievement_defs set active = false
where type in ('misses', 'missstreak')
  and not exists (select 1 from settings where key = 'neg_achievements_hidden_default');
insert into settings (key, value) values ('neg_achievements_hidden_default', '1')
on conflict (key) do nothing;

-- Conquista "Campeão semanal" ('titles' = vezes em 1º lugar no ranking semanal).
-- Semeada uma única vez, visível por padrão.
insert into achievement_defs (id, type, threshold, label, emoji)
select * from (values
  ('titles_1', 'titles', 1, 'Campeão da semana', '🥇'),
  ('titles_3', 'titles', 3, 'Tricampeão', '🏆'),
  ('titles_5', 'titles', 5, 'Dinastia', '🏰')
) as seed(id, type, threshold, label, emoji)
where not exists (select 1 from settings where key = 'titles_achievements_seeded');
insert into settings (key, value) values ('titles_achievements_seeded', '1')
on conflict (key) do nothing;

-- Emblemas desbloqueados por participante. Nunca é apagado (nem ao zerar o
-- ranking): uma vez conquistado, o emblema fica para sempre, a não ser que o
-- admin apague o nível em si (aí some pra todo mundo que tinha).
create table if not exists achievements (
  user_id     text not null references users(id) on delete cascade,
  code        text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, code)
);

-- (a tabela settings é criada no começo deste arquivo)

-- Inscrições de notificação push do navegador. Não depende de login: qualquer
-- visitante que aceitar o convite entra aqui.
create table if not exists push_subscriptions (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- Liga a inscrição de notificações ao participante (quando ele está logado), para
-- avisar "você acertou" e "enquete fechando" só a quem interessa.
alter table push_subscriptions add column if not exists user_id text references users(id) on delete set null;

-- Marca enquetes que já tiveram o aviso de "fechando em breve".
alter table polls add column if not exists closing_notified boolean not null default false;

-- Hall da fama: pódio (1º ao 3º) de cada semana, gravado quando o admin zera o
-- ranking semanal. Nunca é apagado por "zerar" — só pelo admin, semana a semana.
create table if not exists hall_weeks (
  id         text primary key,
  started_at timestamptz not null,
  ended_at   timestamptz not null
);
create table if not exists hall_places (
  week_id text not null references hall_weeks(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  place   integer not null check (place between 1 and 3),
  points  integer not null,
  hits    integer not null,
  primary key (week_id, user_id)
);
create index if not exists hall_places_user_idx on hall_places(user_id);

-- Banimento: quem está banido não entra, não vota e some dos rankings. Os votos
-- antigos ficam guardados, então desbanir devolve tudo como estava.
alter table users add column if not exists banned boolean not null default false;

-- Ajustes manuais de pontos feitos pelo admin (soma ou subtração). Contam como
-- pontos ganhos naquele momento: entram no ranking geral e no semanal enquanto
-- forem mais novos que a última data de "zerar" de cada um.
create table if not exists point_adjustments (
  id         bigserial primary key,
  user_id    text not null references users(id) on delete cascade,
  delta      integer not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists point_adjustments_user_idx on point_adjustments(user_id);

-- Prêmios únicos: só a primeira pessoa a chegar na pontuação (ranking geral) leva.
--   disponível: holder_id nulo e open = true
--   com dono:   holder_id preenchido
--   sem dono:   holder_id nulo e open = false (após o admin remover; só volta a ser
--               conquistável quando o admin libera de novo)
create table if not exists prizes (
  id         text primary key,
  name       text not null,
  emoji      text not null default '🏅',
  image_url  text,
  points     integer not null check (points > 0),
  open       boolean not null default true,
  holder_id  text references users(id) on delete set null,
  won_at     timestamptz,
  created_at timestamptz not null default now()
);
-- Quem já perdeu um prêmio não o ganha de volta quando ele é liberado.
create table if not exists prize_removed (
  prize_id   text not null references prizes(id) on delete cascade,
  user_id    text not null references users(id) on delete cascade,
  removed_at timestamptz not null default now(),
  primary key (prize_id, user_id)
);

-- Datas de corte do ranking geral e semanal. Por padrão ficam em 1970 (ou
-- seja, "desde sempre" — nada foi zerado ainda); o servidor só move essas
-- datas pra "agora" quando o admin aperta um dos botões de zerar.
insert into settings (key, value) values ('weekly_reset_at', '1970-01-01T00:00:00.000Z') on conflict (key) do nothing;
insert into settings (key, value) values ('general_reset_at', '1970-01-01T00:00:00.000Z') on conflict (key) do nothing;

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
alter table poll_topics   enable row level security;
alter table poll_options  enable row level security;
alter table votes         enable row level security;
alter table awards        enable row level security;
alter table settings      enable row level security;
alter table achievements  enable row level security;
alter table achievement_defs enable row level security;
alter table sessions      enable row level security;
alter table push_subscriptions enable row level security;
alter table hall_weeks    enable row level security;
alter table hall_places   enable row level security;
alter table point_adjustments enable row level security;
alter table prizes        enable row level security;
alter table prize_removed enable row level security;
