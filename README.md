# Bolão

Enquetes com palpites e ranking. O admin publica a enquete, os participantes entram com a Twitch e votam, e no final o admin define a resposta certa: quem acertou soma pontos.

- Site: `/` (enquetes e ranking, atualiza sozinho)
- Painel admin: `/admin` (protegido por `ADMIN_PASSWORD`)
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

## 3. Rodar local (ou no Termux)

```bash
npm install
export DATABASE_URL='postgresql://...'
export TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=...
ADMIN_PASSWORD=minhasenha npm start
```

Abra http://localhost:3000.

## 4. Deploy no Render

1. Suba a pasta para um repositório no GitHub.
2. No Render: **New > Blueprint** e escolha o repositório (usa o `render.yaml`). Ele pede `DATABASE_URL`, `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET`.
3. Confira `ADMIN_PASSWORD` em **Environment** (o Blueprint gera uma).
4. Acesse `https://SEU-APP.onrender.com/admin`.

Se o redirecionamento do login der erro, defina `PUBLIC_URL=https://SEU-APP.onrender.com` (sem barra no final) e confira se a URL de callback na Twitch é exatamente a mesma.

## Como os pontos funcionam

- Cada enquete vale N pontos (definido pelo admin, padrão 10).
- Participantes podem trocar o voto até a votação encerrar (manual ou por data).
- Os números de votos só aparecem depois que a votação encerra.
- O ranking é calculado das enquetes resolvidas: se o admin trocar a resposta certa, os pontos se ajustam sozinhos.
- Empate em pontos e acertos divide a mesma posição.
- Apagar uma enquete já resolvida não tira os pontos do ranking: eles ficam guardados.
- **Zerar ranking** (painel admin) volta todos os pontos para 0.
- Toggle no painel: **Substituir** (a nova enquete tira as anteriores da página principal) ou **Acumular**. Enquetes fora da página seguem no painel e podem ser resolvidas normalmente; dá para ocultar/mostrar cada uma.
- A página principal atualiza sozinha (sem F5) quando o admin publica uma enquete, encerra ou define a resposta.
