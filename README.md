# Bolão

Enquetes com palpites e ranking. O admin publica a enquete, os participantes entram com a Twitch e votam, e no final o admin define a resposta certa: quem acertou soma pontos.

- Site: `/` (enquetes e ranking, atualiza sozinho)
- Painel admin: `/admin` por padrão, ou o endereço que você definir em `ADMIN_PATH` (protegido por `ADMIN_PASSWORD`), organizado em abas — Enquetes, Casa, Bônus, Conquistas, Backup — responsivo tanto no celular quanto no PC
- Stack: Node.js + Express + Postgres (Supabase), frontend em HTML/CSS/JS puro
- No ranking aparece o nome e a foto da conta Twitch de cada participante

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

Ao clicar em **Zerar semanal** (ou **Zerar geral**, que zera o semanal junto), o servidor grava o pódio da semana — 1º ao 3º lugar, com pontos e acertos — antes de mover a data de corte. Empatados dividem o lugar, contas da casa e quem não pontuou ficam de fora, e semana em que ninguém pontuou não grava nada. O histórico aparece na aba **Hall da fama** do ranking e no perfil de cada pessoa, e nenhum "zerar" apaga o hall. No painel admin (aba 🏆 Hall) dá para **mostrar/ocultar** o hall para os participantes e excluir uma semana gravada por engano. A conquista **Campeão semanal** (tipo "Títulos semanais", níveis 1, 3 e 5 por padrão, editáveis em Conquistas) conta as vezes em 1º lugar. O pódio só começa a ser gravado a partir do primeiro "Zerar" depois deste deploy.


## Prêmios únicos

Na aba **🏅 Prêmio** do painel você cria prêmios com nome, emoji ou imagem (link https) e uma pontuação do **ranking geral**. Cada prêmio tem um só dono: quem cruzar a pontuação primeiro leva (empate no mesmo resultado: quem tinha mais pontos), e quem chegar depois não ganha. Contas da casa e banidos não disputam. Se já houver gente acima da pontuação ao criar o prêmio, ele vai para quem chegou primeiro. Quando alguém conquista um prêmio, os inscritos recebem uma notificação com o **nome da pessoa e o do prêmio** (chave liga/desliga na própria aba Prêmio, ligada por padrão; dispara uma vez só por conquista, inclusive quando o prêmio é entregue ao criar ou liberar). O dono aparece com o prêmio ao lado do nome no ranking geral e no perfil, e a aba **Prêmios** do ranking mostra a vitrine (com dono, disponível ou sem dono).

**Remover do dono** deixa o prêmio sem dono até você clicar em **Liberar de novo**; quem perdeu o prêmio nunca o ganha de volta. Ao liberar, ele vai para quem chegou primeiro entre os demais (se já houver alguém acima da pontuação, é entregue na hora).

## Usuários (pontos e banimento)

Na aba **👥 Usuários**: busque alguém e use **± Pontos** para somar ou subtrair (com motivo opcional e lista de ajustes com **Desfazer**). O ajuste conta como pontos ganhos naquele momento, no ranking geral e no semanal, e some do ranking que for zerado depois. **Banir** desconecta a pessoa, impede de entrar e votar e a esconde dos rankings, do hall e do perfil; os votos ficam guardados e **Desbanir** devolve tudo. Contas da casa ficam fora desta lista.


## Tema claro/escuro

O botão 🌙/☀️ no topo do site (e do painel admin) alterna entre o tema claro e o escuro. Na primeira visita o tema segue o do aparelho; depois que a pessoa clica, a escolha fica salva naquele navegador (`localStorage`, chave `theme`) e vale para o site e para o admin. O arquivo `public/theme.js` aplica o tema antes da página aparecer, para não piscar. As cores dos dois temas ficam nas variáveis do começo de `public/style.css` (`:root` e `:root[data-theme="dark"]`): para ajustar uma cor do escuro, mude só ali.
