# Risk — comunicação P2P

Aplicativo web/Electron de comunicação com contas persistentes, amizades, grupos, canais de texto e chamadas WebRTC Mesh.

## Arquitetura

- `apps/web`: interface React, chamadas e provider Supabase Realtime;
- `apps/desktop`: processo principal e preload Electron;
- `packages/rtc`: mídia, dispositivos e gerenciamento centralizado das conexões;
- `packages/protocol`: tipos compartilhados de mídia/estado;
- `server`: API Rust/Axum, autenticação, dados duráveis e credenciais TURN;
- `infrastructure`: configuração do coturn.

```text
Peers ── Broadcast + Presence ── Supabase Realtime
  ║
  ╚════════ áudio / vídeo / tela ════════ WebRTC P2P
```

## Supabase Signaling

O Supabase Realtime é usado exclusivamente para coordenação temporária:

- Presence descobre peers conectados;
- Broadcast transporta offer, answer, ICE e estado efêmero de mídia;
- nenhuma tabela Supabase é necessária;
- não há inserts, updates ou deletes no banco Supabase;
- não são usados Storage ou Edge Functions;
- SDP, ICE, presença e histórico de chamadas não são persistidos;
- áudio, vídeo e compartilhamento de tela passam diretamente entre os peers;
- mensagens de canais conectados passam por `RTCDataChannel` e aparecem imediatamente;
- o histórico do chat é salvo somente no IndexedDB do dispositivo;
- TURN é separado e só atua como relay quando P2P direto falha.

Configure no `.env`:

```dotenv
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-publica
VITE_DEBUG_SIGNALING=false
```

A chave anon/publishable foi criada para existir no cliente. Nunca coloque `service_role`, secret key, senha do banco ou outro segredo no frontend.

No painel Supabase, o projeto precisa apenas do Realtime disponível. Não execute migrations e não crie tabelas para chamadas. Cada sala recebe um canal efêmero com tópico derivado por SHA-256.

## Desenvolvimento

Pré-requisitos: Node 22+, pnpm 10+, Rust estável e Docker.

1. Copie `.env.example` para `.env` e preencha os valores locais, incluindo Supabase.
2. Repita `TURN_SECRET` em `infrastructure/coturn/turnserver.conf`.
3. Execute `docker compose up -d postgres redis coturn backend`.
4. Execute `pnpm install` e `pnpm dev:web`.
5. Abra `http://localhost:5173` em dois perfis de navegador e entre no mesmo canal de voz.

Para Electron, use `pnpm dev:desktop`. Em produção, WebRTC exige HTTPS, TURN com IP público anunciado e portas UDP liberadas.

### Pacotes desktop

No Windows, gere o instalador NSIS com `pnpm package:win`. Para gerar AppImage e DEB em uma máquina Linux, use `pnpm package:linux`. No Windows com Docker Desktop em modo de contêiner Linux, use `pnpm package:linux:docker`; o build roda dentro do Linux e grava os artefatos em `apps/desktop/release/`.

## Proteções do signaling

- envelopes tipados e validados antes de tocar WebRTC;
- mensagens direcionadas e mensagens próprias ignoradas;
- expiração, limite de tamanho, deduplicação e controle de ICE spam;
- peer UUID efêmero por chamada;
- início lexical e Perfect Negotiation contra glare;
- fila de ICE em memória até existir `remoteDescription`;
- limpeza de Presence, canal, callbacks, tracks, filas e conexões ao sair;
- diagnóstico seguro por `CallController.getDiagnostics()`.

## Chat P2P e dados offline

Em um canal de texto, clique em **Conectar chat**. O Supabase Realtime descobre os participantes e negocia uma conexão WebRTC separada, sem solicitar microfone. Quando o botão indicar **Chat P2P conectado**, as mensagens usam `RTCDataChannel` ordenado e são replicadas diretamente para todos os peers conectados.

Não existe polling: mensagens recebidas entram na tela no mesmo momento. Cada dispositivo mantém apenas sua própria cópia no IndexedDB. Não há entrega quando todos os destinatários estão offline e não existe sincronização central do histórico — essas são consequências intencionais do modelo totalmente P2P.

Busca de pessoas por e-mail e solicitações para destinatários offline exigem um diretório/servidor. Num modelo integralmente local, amizades precisam ser estabelecidas por código ou link compartilhado e só podem ser confirmadas quando os dois peers estiverem online.

## Convites P2P temporários

Em **Adicionar amigo**, escolha **Criar convite** ou **Usar código**. Para grupos, o botão de adicionar membro cria o convite e **Entrar em grupo** aceita um código. Os códigos têm o formato `risk-XXXX-XXXX-XXXX-XXXX`, expiram em dez minutos e são descartados após um aceite.

O código é normalizado localmente e transformado por SHA-256 em um identificador de rendezvous separado para amizade ou grupo. Presence encontra o outro navegador e Broadcast negocia offer, answer e ICE. Depois que o `RTCDataChannel` abre, o Supabase deixa de participar da solicitação: identidades públicas e aceite/recusa trafegam diretamente entre os peers em mensagens ECDSA P-256 assinadas.

Amigos, grupos recebidos, canais e a identidade criptográfica local são gravados apenas no IndexedDB deste dispositivo. A chave privada nunca é transmitida. Como não há diretório central ou caixa de entrada no servidor, ambos os peers — incluindo o criador de um convite de grupo — precisam estar online durante todo o fluxo.

Os testes usam um provider em memória e não acessam o Supabase real:

```powershell
pnpm --filter @risk/web test
```

Com as variáveis públicas configuradas, valide Presence, Broadcast direcionado e remoção dos canais no Supabase real:

```powershell
node apps/web/scripts/verify-supabase-realtime.mjs
```

Consulte [docs/architecture.md](docs/architecture.md) e [docs/protocol.md](docs/protocol.md).
