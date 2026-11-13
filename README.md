# Bolão

Enquetes com palpites e ranking. O admin publica a enquete, os participantes entram com a Twitch e votam, e no final o admin define a resposta certa: quem acertou soma pontos.

- Site: `/` (enquetes e ranking, atualiza sozinho)
- Painel admin: `/admin` por padrão, ou o endereço que você definir em `ADMIN_PATH` (protegido por `ADMIN_PASSWORD`), organizado em abas — Enquetes, Casa, Bônus, Conquistas, Backup — responsivo tanto no celular quanto no PC
- Stack: Node.js + Express + Postgres (Supabase), frontend em HTML/CSS/JS puro
- No ranking aparece o nome e a foto da conta Twitch de cada participante

## Enquetes com odd (apostas)

Ao criar uma enquete no admin, marque **Enquete com odd** (cada enquete decide; dá para misturar com enquetes normais).

- O participante escolhe uma opção e aposta pontos do **ranking geral** (saldo = total de pontos menos o que já está apostado em enquetes sem resultado). Pode trocar a aposta até a votação encerrar (a menos que a Trava de voto esteja ligada).
- Odd = total de apostadores ÷ apostadores na opção. Quem acerta recebe `aposta × odd` (ganho líquido = isso − aposta); quem erra perde a aposta. Pouca gente na opção certa = prêmio alto; muita gente = prêmio baixo; todo mundo na mesma opção = devolve a aposta.
- **Dois tipos de odd** (escolha ao marcar “Enquete com odd”): **Aposta** (acima) ou **Prêmio fixo**. No prêmio fixo ninguém usa pontos do próprio ranking: o admin define os pontos da enquete (campo “Prêmio total”) e eles são divididos entre quem acertar (prêmio ÷ nº de acertadores, arredondado para baixo). Pouca gente na opção certa = parte grande; muita gente = parte pequena; quem erra não perde nada. O “Ganho máximo por pessoa” também vale aqui. Se a casa ganhar, o prêmio é dividido entre as contas da casa escolhidas.
- **Pontos por opção** (outro modo, sem odd): marque “Pontos por opção” e escreva as opções como `Texto | pontos` (ex.: `Time A | 5`). Quem votar na opção certa leva os pontos dela (de 0 a 1000; uma opção com 0 conta como acerto, para a sequência e as conquistas, mas não dá pontos); quem errar leva 0. Se a casa ganhar, as contas da casa levam os “Pontos por acerto”. Não combina com odd e não dá para ligar/desligar depois de publicar.
- Em “Pontos por opção” há também a caixa **Somar os pontos da enquete aos pontos da opção** (desligada por padrão): ligada, quem acerta leva os “Pontos por acerto” da enquete **mais** os da opção certa (enquete 10 + opção 5 = 15); desligada, só os da opção. Pode mudar a qualquer momento (o ranking recalcula). Se a casa ganhar, as contas da casa continuam levando só os pontos da enquete.
- Em “Pontos por opção” há a caixa **Mostrar os pontos de cada opção na enquete**: desligada, os participantes não veem a pontuação das opções durante a votação (o servidor nem envia os valores); eles aparecem quando o resultado é definido. Dá para mudar a qualquer momento.
- O admin pode definir, por enquete, uma **aposta máxima** e um **ganho máximo** por pessoa (campos opcionais; em branco = sem limite). O ganho máximo limita o lucro líquido de quem acertar.
- Se a casa ganhar ("ninguém acertou"), os apostadores perdem a aposta e as contas da casa escolhidas recebem os "Pontos por acerto" da enquete.
- O ganho/perda entra no ranking geral e no semanal; reabrir ou apagar a enquete mantendo/zerando pontos funciona igual às enquetes normais.
- Só dá para ligar/desligar a odd de uma enquete antes do primeiro voto.
- O banco é atualizado sozinho no deploy (colunas `polls.odds`, `polls.max_stake`, `polls.max_win`, `votes.stake`, `awards.gain`).

## Admins com níveis de acesso

Quem entra com a senha do servidor (`ADMIN_PASSWORD`, deixando o campo "Usuário" em branco) é o **dono**: acesso total e único que cria admins. Na aba **🔑 Admins** o dono cadastra outros admins (nome + senha, mínimo 8 caracteres) e marca o que cada um pode fazer:

- **Enquetes:** criar; editar título/descrição/pontos/prazo/casa/tópico; definir odd e tetos; encerrar, reabrir e definir a resposta certa; ocultar/mostrar; excluir.
- **Outros:** tópicos, contas da casa, usuários (banir/pontos), rankings e pódio, prêmios, conquistas, configurações gerais, aba de testes (que ainda pede a própria senha) e backup.

Admins sem permissão **veem tudo em modo somente leitura** (as abas ficam visíveis, com os campos e botões travados e um aviso). Ficam de fora, só para quem tem permissão: as abas Testes e Backup, e Admins e Histórico (só o dono). Há modelos rápidos (Editor de enquetes, Moderador, Todas, Nenhuma). Mudar permissões vale na hora; trocar a senha desconecta o admin; excluir tira o acesso imediatamente. O servidor recusa qualquer ação sem permissão (a tela só esconde os botões). Um admin sem "definir odd" não consegue mudar a odd nem os tetos, mesmo podendo editar o resto da enquete.

### Histórico de ações

Toda ação que muda algo no painel (criar/editar/encerrar/excluir enquete, resultado, pontos, banimentos, configurações, admins…) é registrada com quem fez, o quê e quando. O dono vê na aba **📜 Histórico** (filtro por admin, “carregar mais”). Registros com mais de 6 meses são apagados automaticamente. Senhas e o conteúdo das apostas/contas de teste não entram.

## Bot da Twitch

Aba **🤖 Bot** do admin: o bot escreve no chat da sua live quando (1) uma enquete é criada, (2) sai o resultado e (3) alguém conquista um prêmio (marcando o ganhador com @). Cada aviso liga/desliga e tem mensagem editável, com variáveis como `{titulo}`, `{resposta}`, `{usuario}`, `{premio}`, `{link}`.

Configuração (uma vez):
1. **App da Twitch do bot:** o bot pode usar o app (Client ID e Secret) de **outra conta**, separado do app do login do site. Crie o app com a conta do bot em dev.twitch.tv/console (tipo de cliente *Confidential*) e defina `BOT_TWITCH_CLIENT_ID` e `BOT_TWITCH_CLIENT_SECRET` no servidor. Sem elas, o bot usa as mesmas credenciais do login. Em **OAuth Redirect URLs** desse app, adicione `https://SEU-SITE/auth/twitch-bot/callback` (a aba mostra a URL exata). Se você trocar essas credenciais depois, é preciso conectar a conta do bot de novo.
2. Na aba Bot, clique em **Conectar conta do bot** e autorize com a conta que será o bot (pode ser a sua ou uma conta separada). Permissões pedidas: `user:write:chat` e `user:bot`.
3. Informe o **canal** (login da Twitch), ligue o bot, salve e use **Enviar mensagem de teste**.

A conta do bot tem que ser **separada**: o sistema recusa a conta dona do canal e qualquer conta que já entre no site como participante, e a conta do bot não consegue fazer login no site. Dica: para autorizar com outra conta, use uma janela anônima (a Twitch usa a conta aberta no navegador).

Dica: dê `/mod` ao bot no seu canal, para o chat não barrar mensagens (modo só-seguidores, lentidão etc.). As mensagens saem em fila, uma a cada ~1,5 s. O acesso do bot fica só no servidor (tabela `bot_auth`) e é renovado sozinho. Quem tem a permissão “Bot da Twitch” conecta, configura e testa; os outros admins só veem.

## Chat

Botão 💬 no site (só para quem está logado): chat global em tempo real, com menções (`@login`), anexos de imagem e vídeo **por link** (http/https), preview automático de links de imagem, e 🎨 para cada pessoa escolher a **cor do nome** (aparece no chat, ranking e perfil). Guarda as últimas 100 mensagens; limite de 30 por minuto e 500 caracteres.

Aba **💬 Chat** do admin: liga/desliga o chat, liga/desliga imagens, vídeos e preview de links (quem tem a permissão “Configurações gerais”) e a moderação (permissão “Moderar o chat”): apagar mensagens (ficam marcadas para a moderação), remover do banco, silenciar por 1 h, 24 h ou permanente (com motivo) e tirar o silêncio. As ações de moderação entram no Histórico.

As mensagens só chegam a conexões de quem está logado. O banco é atualizado sozinho no deploy (tabelas `chat_messages` e `chat_mutes`, colunas `users.name_color` e as de mídia).

## Cancelar enquete

O botão **Cancelar e devolver pontos** (permissão “encerrar, reabrir e definir resposta”) deixa a enquete na lista como *Cancelada*: ninguém ganha nem perde pontos por ela, as apostas são devolvidas (o saldo volta na hora) e, se ela já tinha resultado, os pontos que deu ou tirou também saem do ranking. Os votos continuam registrados e **Reabrir votação** desfaz o cancelamento. Para apagar de vez, use Excluir.

## Trava de voto

Na aba Criar do admin, a caixa **Não deixar o participante trocar o voto** (desligada por padrão) impede qualquer troca depois do primeiro voto ou aposta, em todas as enquetes.

## X1 Bolados (aposta 1 contra 1)

Aba **⚔️ X1 Bolados** no site (e botão **⚔️ Desafiar alguém nesta enquete** em cada enquete aberta). Um participante desafia outro valendo pontos do **ranking geral**; cada um aposta o mesmo valor.

**Dois tipos:**
- **Numa enquete aberta:** quem desafia escolhe a sua opção; o desafiado **escolhe a dele ao aceitar** (qualquer opção diferente da sua; se sobrar só uma, entra nela). Quando o admin define a resposta certa, quem estiver nela **leva os pontos do outro**. Se nenhuma das duas for a certa (ou "a casa ganha"), empata e ninguém perde. Se o admin trocar a resposta depois, o X1 Bolado é recalculado; se cancelar a enquete, tudo é devolvido.
- **Com mediador (X1 Bolado livre):** o desafiante escreve o X1 Bolado e o lado de cada um e escolhe um **mediador** — outro participante (uma terceira pessoa) ou o **admin**. O mediador decide quem ganhou (ou empate) e o vencedor leva os pontos do outro. O mediador pode desistir de mediar (tudo é anulado e devolvido). O admin pode decidir, corrigir ou anular pela aba **⚔️ X1 Bolados** do painel.

**Fluxo e pontos:** o X1 Bolado nasce *pendente* (os pontos de quem desafiou já ficam travados); o desafiado pode **aceitar** (trava os pontos dele também), **recusar** ou deixar expirar (prazo escolhido ao criar: 6 h a 7 dias; em X1 Bolado de enquete, no máximo até o fechamento da enquete). Pontos travados saem do saldo para apostar (o mesmo saldo das enquetes com odd, então ninguém aposta o que não tem). Ao decidir, o vencedor soma o valor e o perdedor perde o valor no ranking geral **e** no semanal, no histórico do perfil (⚔️) e nos prêmios únicos. X1 Bolado **não** conta como palpite: não mexe em acertos, sequência nem conquistas.

**Avisos:** o desafiado, o mediador e os dois lados recebem notificação push (se ligada) e a aba mostra uma bolinha com quantos X1 Bolados esperam resposta ou decisão. Limites: 10 X1 Bolados pendentes por pessoa; não dá para desafiar a si mesmo, contas da casa, banidos nem contas de teste.

**Admin:** aba **⚔️ X1 Bolados** (permissão própria "X1 Bolado", que o dono pode dar aos outros admins): liga/desliga o recurso, define um valor máximo por X1 Bolado, lista tudo com filtros e permite decidir/corrigir (X1 Bolado livre), **anular** (devolve os pontos, até de um já decidido) e **excluir**. Tudo entra no Histórico de ações.

O banco é atualizado sozinho no deploy (tabela `challenges`, no `schema.sql`; o backup também inclui os X1 Bolados). O código das rotas fica em `challenges.js`.

## Painel de testes

Na aba **🧪 Testes** do admin você cria contas fictícias (com pontos iniciais), faz cada uma votar ou apostar, faz todas votarem aleatoriamente de uma vez e dá ±100 pontos. Elas aparecem no ranking com 🧪, não levam prêmio único nem entram no pódio, e **Apagar contas de teste** remove tudo delas. Evite zerar o ranking semanal com contas de teste ativas.

A aba é protegida por uma segunda senha, a variável `TESTS_PASSWORD` (o Blueprint do Render gera uma; em dev o padrão é `teste123`). Sem ela em produção, a aba fica trancada. O acesso fecha sozinho após 1 hora, ou pelo botão “Trancar aba”.

## 1. Supabase (banco de dados)

1. Crie um projeto em https://supabase.com.
2. Clique em **Connect** e copie a string **Session pooler** (funciona no Render, que não tem IPv6). Troque `[YOUR-PASSWORD]` pela senha do banco.
3. Pronto: as tabelas são criadas sozinhas quando o servidor inicia (`schema.sql`). O RLS fica ligado, então a API pública do Supabase não enxerga essas tabelas.

Projetos gratuitos do Supabase são pausados após uma semana sem atividade; usar o site já mantém o projeto ativo.

## 2. Twitch (login)

1. Ative a verificação em duas etapas na sua conta Twitch (obrigatório para criar apps).
2. Em https://dev.twitch.tv/console/apps clique em **Register Your Application**.
3. **OAuth Redirect URLs**: adicione
   - `https://SEU-APP.onrender.com/auth/twitch/callback`
   - `http://localhost:3000/auth/twitch/callback` (para testar local)
4. Categoria: *Website Integration*. Tipo de cliente: *Confidential*.
5. Copie o **Client ID** e gere um **Client Secret**.

O login não pede nenhuma permissão extra: só identifica a conta.

## 3. Notificações (opcional)

Avisa quem ativou o sino quando uma enquete nova é publicada, mesmo com o navegador fechado (Android) ou em segundo plano (desktop). No iPhone, o Safari só recebe push se o site for adicionado à tela inicial (iOS 16.4+).

1. Gere um par de chaves: `npx web-push generate-vapid-keys`.
2. Defina `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT` (um `mailto:` seu).
3. Sem essas variáveis, o site funciona normal e o botão de notificação simplesmente não aparece.

## 4. Rodar local (ou no Termux)

```bash
npm install
export DATABASE_URL='postgresql://...'
export TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=...
ADMIN_PASSWORD=minhasenha npm start
```

Abra http://localhost:3000.

## 5. Deploy no Render

1. Suba a pasta para um repositório no GitHub.
2. No Render: **New > Blueprint** e escolha o repositório (usa o `render.yaml`). Ele pede `DATABASE_URL`, `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET`.
3. Confira `ADMIN_PASSWORD` em **Environment** (o Blueprint gera uma).
4. Acesse `https://SEU-APP.onrender.com/admin`. Para esconder o painel, defina a variável `ADMIN_PATH` (ex.: `painel-x7k2q9`) em Environment e acesse `https://SEU-APP.onrender.com/painel-x7k2q9`; o endereço `/admin` deixa de existir. Isso só dificulta achar o painel — a proteção de verdade continua sendo a `ADMIN_PASSWORD`.

Se o redirecionamento do login der erro, defina `PUBLIC_URL=https://SEU-APP.onrender.com` (sem barra no final) e confira se a URL de callback na Twitch é exatamente a mesma.

## Como os pontos funcionam

- Cada enquete vale N pontos (definido pelo admin, padrão 10).
- Participantes podem trocar o voto até a votação encerrar (manual ou por data).
- Os números de votos só aparecem depois que a votação encerra.
- O ranking é calculado das enquetes resolvidas: se o admin trocar a resposta certa, os pontos se ajustam sozinhos.
- Empate em pontos e acertos divide a mesma posição.
- **Excluir** uma enquete que já tem resposta também pergunta o que fazer com os pontos (igual ao reabrir): manter no ranking ou zerar.
- Apagar uma enquete já resolvida não tira os pontos do ranking: eles ficam guardados.
- **Zerar ranking** (painel admin) volta todos os pontos para 0.
- **Ranking geral e semanal:** o ranking tem duas abas. O **geral** é o placar permanente — mostra os emblemas/conquistas e só reinicia quando você aperta "Zerar geral". O **semanal** mostra só os pontos desde o último "Zerar semanal", sem mexer no geral (zerar o geral também zera o semanal junto, já que ele é uma janela dentro do geral). Nenhum dos dois apaga dado nenhum: só move uma data de corte, então dá pra reverter direto no banco se precisar. É reset manual — não existe zerar sozinho toda semana.
- **Contas da casa:** no painel admin, crie contas fictícias (nome + imagem opcional, link https). Ao resolver uma enquete, use **🏠 A casa ganha** quando nenhuma opção bater — escolha pra qual(is) conta(s) os pontos vão (não precisa ser todas). Quem votou nas opções normais não pontua naquela rodada. As contas da casa aparecem no ranking e no perfil como qualquer participante (inclusive ganham conquistas), com a imagem cadastrada ou um ícone 🏠 padrão.
- Toggle no painel: **Substituir** (a nova enquete tira as anteriores da página principal) ou **Acumular**. Enquetes fora da página seguem no painel e podem ser resolvidas normalmente; dá para ocultar/mostrar cada uma.
- **Reabrir votação** de uma enquete com resposta pergunta o que fazer com os pontos: *manter* (ficam guardados no ranking e os votos são limpos, como nova rodada) ou *zerar* (os pontos dela saem do ranking e os votos são mantidos).
- **Perfil do participante:** clique em um nome no ranking (ou no seu nome no topo). Mostra posição, pontos, acertos, aproveitamento, sequência atual e melhor sequência, e o histórico de palpites já resolvidos. Palpites em aberto nunca aparecem.
- **Bônus de sequência** (painel admin, desligado por padrão): a cada N acertos seguidos a pessoa ganha +B pontos. Só contam enquetes em que ela votou, e um erro zera a sequência. A regra é recalculada em todo o ranking na hora.
- **Conquistas:** níveis de emblema por total de pontos ou por sequência de acertos seguidos, além de **conquistas negativas** por total de erros ou por sequência de erros seguidos, com nome, emoji e imagem (link https, opcional — sem imagem, usa o emoji) totalmente editáveis no painel `/admin`, seção "Conquistas". Uma vez desbloqueado, o emblema fica para sempre no perfil, mesmo depois de zerar o ranking — editar um nível atualiza como ele aparece em quem já tem; apagar um nível remove o emblema de quem tinha. Vem com sete níveis padrão na primeira vez que o servidor sobe (Bronze/Prata/Ouro/Platina por pontos, três por sequência) e seis negativos (Pé frio 3 erros seguidos, Maré de azar 5, Maldição 10, Chutador 10 erros, Anti-vidente 25, Mestre do erro 50 — semeados uma vez, inclusive em bancos que já existiam), que você pode editar, apagar ou complementar à vontade depois. As conquistas negativas já vêm **ocultas** por padrão (inclusive as que o admin criar depois; ligue no botão Mostrar), e as positivas vêm visíveis. Cada nível tem um botão **Ocultar/Mostrar** no painel: oculto, ele some do ranking e dos perfis (e do "faltam X para..."), mas o desbloqueio continua sendo registrado e volta a aparecer ao reativar. Os dois mais altos aparecem ao lado do nome no ranking.
- **Notificações:** botão de sino no topo. No painel admin há uma chave geral (liga/desliga) e, no formulário de nova enquete, uma caixa "Notificar ao publicar" para publicar sem avisar ninguém — só notifica se as duas estiverem ligadas. Avisa todo mundo inscrito quando uma enquete é publicada. Além disso, quem estava logado ao ativar o sino recebe **"você acertou +N pontos"** (ou "dessa vez não deu") quando você define a resposta, e quem ainda não votou recebe um **lembrete cerca de 1 hora antes** da enquete fechar (confere a cada minuto, só com o servidor acordado). Cada tipo tem uma chave liga/desliga no painel admin (aba Enquetes) (não avisa em edição, encerramento ou resultado). As inscrições mortas são limpas sozinhas na próxima tentativa de envio.
- A página principal atualiza sozinha (sem F5) quando o admin publica uma enquete, encerra ou define a resposta.


## Tópicos das enquetes

As enquetes são divididas em **tópicos** (vêm dois: Geral e Casa), que viram divisórias na página principal, igual ao Semanal/Geral do ranking. No painel admin:

- **✏️ Criar:** aba só com o formulário. Ao clicar em Publicar, abre uma caixa perguntando em qual tópico a enquete entra (com um só tópico, publica direto).
- **Enquetes:** uma sub-aba por tópico, com o botão **Mover de tópico** em cada enquete. Em **Gerenciar tópicos** você cria, renomeia e apaga tópicos (só dá para apagar um vazio; sempre fica pelo menos um).
- Editar uma enquete abre o formulário na aba Criar e volta para a lista ao salvar.

No site, a barra de tópicos só aparece quando há enquetes em mais de um tópico, e mostra quantas estão abertas em cada um. Os pontos continuam no mesmo ranking, independente do tópico. No modo "substituir", publicar uma enquete só tira da página as anteriores **do mesmo tópico**. As enquetes que já existiam ficam em Geral.

## Hall da fama

Ao clicar em **Zerar semanal** (ou **Zerar geral**, que zera o semanal junto), o servidor grava o pódio da semana — 1º ao 3º lugar, com pontos e acertos — antes de mover a data de corte. Empatados dividem o lugar, contas da casa também entram, só quem não pontuou fica de fora, e semana em que ninguém pontuou não grava nada. O histórico aparece na aba **Hall da fama** do ranking e no perfil de cada pessoa, e nenhum "zerar" apaga o hall. No painel admin (aba 🏆 Hall) dá para **mostrar/ocultar** o hall para os participantes e excluir uma semana gravada por engano. A conquista **Campeão semanal** (tipo "Títulos semanais", níveis 1, 3 e 5 por padrão, editáveis em Conquistas) conta as vezes em 1º lugar. O pódio só começa a ser gravado a partir do primeiro "Zerar" depois deste deploy.


## Prêmios únicos

Na aba **🏅 Prêmio** do painel você cria prêmios com nome, emoji ou imagem (link https) e uma pontuação do **ranking geral**. Cada prêmio tem um só dono: quem cruzar a pontuação primeiro leva (empate no mesmo resultado: quem tinha mais pontos), e quem chegar depois não ganha. Contas da casa e banidos não disputam. Se já houver gente acima da pontuação ao criar o prêmio, ele vai para quem chegou primeiro. Cada prêmio pode ter uma **descrição** (até 300 caracteres, opcional), que aparece no site junto do prêmio, na aba Prêmios do ranking e no perfil de quem o conquistou. Quando alguém conquista um prêmio, os inscritos recebem uma notificação com o **nome da pessoa e o do prêmio** (chave liga/desliga na própria aba Prêmio, ligada por padrão; dispara uma vez só por conquista, inclusive quando o prêmio é entregue ao criar ou liberar). O dono aparece com o prêmio ao lado do nome no ranking geral e no perfil, e a aba **Prêmios** do ranking mostra a vitrine (com dono, disponível ou sem dono).

**Remover do dono** deixa o prêmio sem dono até você clicar em **Liberar de novo**; quem perdeu o prêmio nunca o ganha de volta. Ao liberar, ele vai para quem chegou primeiro entre os demais (se já houver alguém acima da pontuação, é entregue na hora).

## Usuários (pontos e banimento)

Na aba **👥 Usuários**: busque alguém e use **± Pontos** para somar ou subtrair (com motivo opcional e lista de ajustes com **Desfazer**). O ajuste conta como pontos ganhos naquele momento, no ranking geral e no semanal, e some do ranking que for zerado depois. **Banir** desconecta a pessoa, impede de entrar e votar e a esconde dos rankings, do hall e do perfil; os votos ficam guardados e **Desbanir** devolve tudo. Contas da casa ficam fora desta lista, mas na aba **🏠 Casa** cada conta tem o seu próprio botão **± Pontos**, que funciona igual (soma ou subtrai, com motivo e desfazer).


## Tema claro/escuro

O botão 🌙/☀️ no topo do site (e do painel admin) alterna entre o tema claro e o escuro. Na primeira visita o tema segue o do aparelho; depois que a pessoa clica, a escolha fica salva naquele navegador (`localStorage`, chave `theme`) e vale para o site e para o admin. O arquivo `public/theme.js` aplica o tema antes da página aparecer, para não piscar. As cores dos dois temas ficam nas variáveis do começo de `public/style.css` (`:root` e `:root[data-theme="dark"]`): para ajustar uma cor do escuro, mude só ali.

## Enquete com a opção Casa

No formulário da enquete há o checkbox **🏠 Casa**. Nessas enquetes as contas da casa participam do resultado:

- **Uma opção acerta** (Confirmar resposta certa): antes de confirmar abre o menu **Qual casa erra?**. As contas marcadas erram — perdem a sequência e o erro entra no histórico; as desmarcadas não participam (pode confirmar sem marcar nenhuma). Ao atualizar a resposta, o menu abre de novo e substitui a escolha anterior.
- **A casa ganha** (🏠 A casa ganha): as contas escolhidas somam o acerto e mantêm a sequência; as outras contas da casa ficam de fora.
- Enquetes sem o checkbox funcionam como antes, sem menu.
