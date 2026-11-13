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

alter table polls add column if not exists house boolean not null default false; -- enquete com as contas da casa participando

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
-- Texto opcional que o site mostra junto do prêmio (o que é, como ganhar, etc.).
alter table prizes add column if not exists description text not null default '';
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

-- Admins com níveis de acesso. O "dono" é quem entra com ADMIN_PASSWORD (tudo liberado e é o único
-- que cria/edita admins). Os demais entram com nome + senha e só fazem o que está em 'permissions'.
create table if not exists admins (
  id            text primary key,
  name          text not null,
  password_hash text not null,
  permissions   text[] not null default '{}',
  created_at    timestamptz not null default now()
);
create unique index if not exists admins_name_idx on admins (lower(name));
alter table admins enable row level security;
alter table sessions add column if not exists admin_id text references admins(id) on delete cascade;

-- Bot da Twitch: conta que escreve no chat (tokens do OAuth). Uma linha só (id = 1); nunca sai do servidor.
-- A configuração do bot (canal, avisos, mensagens) fica em 'settings' (chaves bot_*).
create table if not exists bot_auth (
  id            integer primary key default 1 check (id = 1),
  bot_user_id   text not null,
  bot_login     text not null,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  updated_at    timestamptz not null default now()
);
alter table bot_auth enable row level security;
-- App da Twitch (Client ID) com o qual a conta do bot foi autorizada: se as credenciais do bot mudarem, é preciso conectar de novo.
alter table bot_auth add column if not exists client_id text;

-- Histórico de ações do painel admin (quem fez o quê e quando). Sem FK de propósito: o registro
-- continua existindo depois que um admin é excluído. Guarda só o necessário, nunca senhas.
create table if not exists admin_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  admin_id   text,
  admin_name text not null,
  action     text not null,
  detail     text
);
create index if not exists admin_log_at_idx on admin_log (id desc);
alter table admin_log enable row level security;

-- Enquetes com odd: o participante aposta pontos do ranking numa opção. Quem
-- acerta recebe a aposta multiplicada pela odd (total de apostadores / apostadores
-- na opção certa), então opção pouco escolhida paga mais. Quem erra perde a aposta.
alter table polls add column if not exists odds boolean not null default false;
alter table votes add column if not exists stake integer;
-- Tetos opcionais (definidos pelo admin) da enquete com odd: aposta máxima e ganho líquido máximo por pessoa. Nulo = sem limite.
-- Enquete cancelada: ninguém ganha nem perde pontos por ela e as apostas ficam livres de novo (dá para reabrir).
alter table polls add column if not exists cancelled boolean not null default false;
-- Pontos por opção: o admin define a pontuação de cada opção (poll_options.points); quem acerta leva os pontos da opção certa.
alter table polls add column if not exists option_points boolean not null default false;
alter table poll_options add column if not exists points integer;
-- Somar os pontos da enquete (polls.points) aos da opção certa. Desligado: vale só o ponto da opção.
alter table polls add column if not exists sum_points boolean not null default false;
-- Mostrar ou esconder os pontos de cada opção para os participantes (escondidos até sair o resultado).
alter table polls add column if not exists show_option_points boolean not null default true;
-- Odd de prêmio fixo (alternativa à aposta): os pontos da enquete (points) são divididos entre quem acertar,
-- então quanto menos gente acerta, maior a parte de cada um. Ninguém aposta pontos do próprio ranking.
alter table polls add column if not exists pool_odds boolean not null default false;
alter table polls add column if not exists max_stake integer;
alter table polls add column if not exists max_win integer;
-- Ganho líquido guardado de rodadas antigas de enquetes com odd (pode ser negativo).
-- Nulo = rodada normal (vale 'points' se acertou, 0 se errou).
alter table awards add column if not exists gain integer;
-- Contas de teste do painel admin (aba Testes): participantes fictícios apagáveis de uma vez.
alter table users add column if not exists is_test boolean not null default false;

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

-- Chat global (sidebar). Só quem está logado vê e envia. Admin com permissão "chat" modera.
create table if not exists chat_messages (
  id          bigserial primary key,
  user_id     text not null references users(id) on delete cascade,
  body        text not null default '' check (char_length(body) <= 500),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  text
);
create index if not exists chat_messages_created_idx on chat_messages (created_at desc);
create index if not exists chat_messages_alive_idx on chat_messages (id desc) where deleted_at is null;

-- Silenciados no chat (1h, 24h ou permanente até desmutar)
create table if not exists chat_mutes (
  user_id     text primary key references users(id) on delete cascade,
  muted_by    text,
  reason      text,
  until       timestamptz,          -- null = permanente
  created_at  timestamptz not null default now()
);

alter table chat_messages enable row level security;
alter table chat_mutes    enable row level security;


-- Anexos de mídia no chat (URL http/https). media_type: image | video
alter table chat_messages add column if not exists media_url text;
alter table chat_messages add column if not exists media_type text;


-- Permite mensagem só com mídia (body vazio)
alter table chat_messages drop constraint if exists chat_messages_body_check;
alter table chat_messages add constraint chat_messages_body_check check (char_length(body) <= 500);


-- Cor do nome escolhida pelo usuário (identidade). Hex da paleta permitida no servidor.
alter table users add column if not exists name_color text;

-- Desafios (bolão 1 contra 1): um participante desafia outro valendo pontos do ranking geral.
--   kind 'poll'   = em cima de uma enquete vigente (cada lado escolhe uma opção diferente; quem estiver na certa leva);
--   kind 'custom' = desafio livre, com um mediador (um participante ou o admin) que paga o lado certo.
-- Status: pending (esperando o desafiado) -> active (aceito, pontos travados) -> settled (vencedor definido;
-- winner_id nulo = empate, nada muda). declined / cancelled / expired devolvem tudo.
create table if not exists challenges (
  id                text primary key,
  kind              text not null check (kind in ('poll', 'custom')),
  creator_id        text not null references users(id) on delete cascade,
  opponent_id       text not null references users(id) on delete cascade,
  mediator_id       text references users(id) on delete set null, -- só em 'custom'; nulo = o admin decide
  poll_id           text references polls(id) on delete set null,
  creator_option_id text,
  opponent_option_id text,
  title             text not null default '',
  description       text not null default '',
  creator_side      text not null default '',
  opponent_side     text not null default '',
  stake             integer not null check (stake between 1 and 1000000),
  status            text not null default 'pending'
                    check (status in ('pending', 'active', 'settled', 'declined', 'cancelled', 'expired')),
  winner_id         text references users(id) on delete set null,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  accepted_at       timestamptz,
  resolved_at       timestamptz
);
create index if not exists challenges_creator_idx  on challenges (creator_id, status);
create index if not exists challenges_opponent_idx on challenges (opponent_id, status);
create index if not exists challenges_poll_idx     on challenges (poll_id);
alter table challenges enable row level security;
