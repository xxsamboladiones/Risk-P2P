# Risk — comunicação P2P

Aplicativo web/Electron de comunicação com contas persistentes, amizades, grupos, canais de texto e chamadas WebRTC Mesh.

## Arquitetura

- `apps/web`: interface React, chamadas, chat P2P e provider Supabase Realtime;
- `apps/desktop`: processo principal e preload Electron;
- `packages/rtc`: mídia, DataChannel e gerenciamento das conexões WebRTC;
- `packages/protocol`: tipos compartilhados de mídia/estado;
- `server`: API Rust/Axum central para autenticação, dados duráveis e credenciais TURN temporárias;
- `infrastructure`: configuração do coturn e empacotamento.

```text
React / Electron ─── HTTP ─── Rust/Axum ─── PostgreSQL
       │
       ├── Broadcast + Presence ─── Supabase Realtime
       │
       └════════ WebRTC Mesh P2P ════════ outros peers
             áudio / vídeo / tela / DataChannel
                         │
                    STUN / TURN
```

> O desktop **não contém PostgreSQL nem inicia o backend Rust localmente**. Um pacote de produção precisa ser compilado com `VITE_API_URL` apontando para uma API Risk acessível. Isso é intencional: o backend atual é um serviço central, não um sidecar do Electron.

## Supabase Signaling

O Supabase Realtime é usado somente para coordenação temporária:

- Presence descobre peers conectados;
- Broadcast transporta offer, answer, ICE, nome de exibição e estado efêmero de mídia;
- nenhuma tabela Supabase é necessária;
- não há inserts, updates ou deletes no banco Supabase;
- não são usados Storage ou Edge Functions;
- SDP, ICE, presença e histórico de chamadas não são persistidos pelo Risk;
- áudio, vídeo, compartilhamento de tela e mensagens de chat passam pelo WebRTC;
- o histórico P2P do chat é salvo somente no IndexedDB de cada dispositivo;
- TURN é separado e atua como relay quando a rota direta falha.

Configure no `.env`:

```dotenv
VITE_API_URL=http://localhost:8080
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-publica
VITE_DEBUG_SIGNALING=false
```

A chave anon/publishable do Supabase foi feita para existir no cliente. Nunca coloque `service_role`, secret key, senha do banco, `JWT_SECRET`, `TURN_SECRET` ou outro segredo no frontend.

O cliente valida envelopes e só aceita mensagens de peers atualmente observados no Presence. Isso reduz spoofing acidental e tráfego fora da sala, mas o `peerId` efêmero do signaling ainda não é uma identidade criptográfica permanente.

## Desenvolvimento

Pré-requisitos: Node 22+, pnpm 10.15+, Rust estável e Docker.

1. Copie `.env.example` para `.env`.
2. Troque `JWT_SECRET` e `TURN_SECRET` por valores aleatórios fortes.
3. Configure as variáveis públicas do Supabase.
4. Execute `docker compose up -d postgres coturn backend`.
5. Execute `pnpm install` e `pnpm dev:web`.
6. Abra `http://localhost:5173` em dois perfis de navegador para testar os fluxos P2P.

O `docker-compose.yml` injeta `TURN_SECRET` no coturn; não é necessário duplicar o segredo em `turnserver.conf`.

Para Electron, use:

```powershell
pnpm dev:desktop
```

O processo Electron mantém `contextIsolation` e sandbox ativos, usa um preload CommonJS mínimo e restringe IPC, navegação, novas janelas e permissões à origem do Risk.

## Produção

Antes de empacotar, configure pelo menos:

```dotenv
VITE_API_URL=https://api.seu-dominio.com
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-publica
```

Os comandos de pacote executam `scripts/verify-build-env.mjs` e interrompem o build se essas variáveis estiverem ausentes.

No backend, uma implantação HTTPS normalmente usará algo semelhante a:

```dotenv
WEB_ORIGINS=https://app.seu-dominio.com,http://localhost:5173
COOKIE_SECURE=true
TURN_HOST=turn.seu-dominio.com
```

`WEB_ORIGINS` aceita uma lista separada por vírgulas. Com `COOKIE_SECURE=true`, o refresh token usa `Secure` e `SameSite=None`, adequado quando frontend e API estão em sites distintos sobre HTTPS.

Para TURN fora da máquina local:

- `TURN_HOST` precisa ser um host/IP alcançável pelos clientes; `localhost` serve apenas para desenvolvimento local;
- configure `external-ip` no coturn quando houver NAT;
- publique 3478 UDP/TCP;
- publique a faixa UDP de relay configurada, atualmente `49160-49200` no Docker de desenvolvimento;
- para produção, considere TLS/TURNS e uma faixa de relay dimensionada para a carga esperada.

### Pacotes desktop

No Windows:

```powershell
pnpm package:win
```

Em Linux:

```bash
pnpm package:linux
```

No Windows com Docker Desktop em modo Linux:

```powershell
pnpm package:linux:docker
```

Os artefatos são gravados em `apps/desktop/release/`. O build Linux via Docker também recebe `VITE_API_URL` e as variáveis públicas do Supabase.

## Proteções do WebRTC e signaling

- envelopes tipados e validados antes de tocar WebRTC;
- mensagens próprias e destinadas a outros peers são ignoradas;
- mensagens só são aceitas de peers presentes no canal;
- expiração, limite de tamanho, deduplicação e controle local de spam;
- peer UUID efêmero por sessão P2P;
- Perfect Negotiation para reduzir glare;
- fila de ICE em memória até existir `remoteDescription`;
- no máximo cinco peers remotos por `MeshWebRTCTransport`, totalizando seis participantes por cliente;
- backpressure simples para DataChannels congestionados;
- limpeza de Presence, callbacks, tracks, filas e conexões ao sair;
- diagnóstico seguro por `CallController.getDiagnostics()`.

O limite de seis é uma proteção do cliente Mesh, não um mecanismo de autorização do Supabase.

## Chat P2P e dados offline

Em um canal de texto, clique em **Conectar chat**. O Supabase Realtime descobre os participantes e negocia uma conexão WebRTC separada sem solicitar microfone. Quando o botão indicar **Chat P2P conectado**, as mensagens usam `RTCDataChannel` ordenado e são replicadas diretamente aos peers online.

O nome exibido para uma mensagem recebida é associado ao `peerId` da conexão em vez de confiar cegamente no campo `author` enviado pelo DataChannel. Isso dificulta falsificação simples de nome, mas o chat ainda não possui assinatura criptográfica permanente por mensagem.

Cada dispositivo mantém sua própria cópia do histórico no IndexedDB. Não existe entrega quando todos os destinatários estão offline e não existe sincronização central automática do histórico.

## Convites P2P temporários

Em **Adicionar amigo**, escolha **Criar convite** ou **Usar código**. Para grupos, **Adicionar membro** cria convite para o grupo atualmente selecionado e **Entrar em grupo** aceita um código.

Os códigos têm o formato:

```text
risk-XXXX-XXXX-XXXX-XXXX
```

Eles expiram em dez minutos. Caracteres excedentes não são truncados silenciosamente: códigos fora do formato são rejeitados.

O código é normalizado localmente e transformado por SHA-256 em um identificador de rendezvous separado para amizade ou grupo. Presence encontra o outro cliente e Broadcast negocia offer, answer e ICE. Depois que o DataChannel abre, solicitação, identidade pública, aceite/recusa e confirmação trafegam diretamente entre os peers usando mensagens ECDSA P-256 assinadas.

O aceite agora usa confirmação explícita (`invite.ack`): o criador só persiste a amizade ou o novo membro depois de receber o ACK do outro dispositivo. Há timeout de candidato e limite de tentativas compartilhado pela sessão.

Amigos P2P, grupos recebidos, canais e a identidade criptográfica local são gravados no IndexedDB. A chave privada ECDSA é armazenada como `CryptoKey` não extraível e nunca é transmitida.

## Backend e dados persistentes

O backend Rust ainda mantém o modelo central de contas, amizades e comunidades. Ele também:

- emite access tokens de curta duração e rotaciona refresh tokens;
- aplica limite básico de tentativas de login por e-mail normalizado;
- valida tamanhos de nomes, mensagens, e-mails e senhas antes do PostgreSQL;
- mantém `room_members` para salas criadas e canais de voz de comunidades;
- emite credenciais TURN temporárias usando o shared secret do coturn.

`room_members` mantém o estado do backend coerente, mas não transforma por si só um tópico Supabase Realtime em um canal autenticado. Autorização criptográfica/servidor para tópicos Realtime é uma etapa separada caso o modelo de segurança exija isso.

## Testes e CI

Testes unitários P2P usam providers/fakes locais e não dependem do Supabase real:

```powershell
pnpm test
pnpm typecheck
```

Com as variáveis públicas configuradas, valide Presence e Broadcast contra o Supabase real:

```powershell
node apps/web/scripts/verify-supabase-realtime.mjs
```

A CI também compila o frontend, valida o bundle Electron e executa `cargo clippy`, `cargo test` e `cargo fmt --check` no backend.

Consulte [docs/architecture.md](docs/architecture.md) e [docs/protocol.md](docs/protocol.md).
