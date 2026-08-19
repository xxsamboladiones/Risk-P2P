# Risk — comunicação P2P

Risk é um aplicativo Web/Electron para chamadas de voz, vídeo, compartilhamento de tela e chat P2P via WebRTC.

## Arquitetura atual

O desktop é entregue como **um único aplicativo para o usuário**, mas internamente possui dois processos:

- Electron + React para a interface;
- `risk-desktop-backend`, sidecar Rust iniciado automaticamente pelo Electron.

```text
Risk Desktop
│
├── Electron Main
│   ├── inicia o frontend
│   ├── inicia o backend Rust
│   ├── aguarda readiness + /health
│   └── encerra o backend junto com o app
│
├── React UI
│   └── HTTP local autenticado
│
└── Rust Desktop Backend
    └── SQLite em app.getPath("userData")

Supabase Realtime ── rendezvous / signaling efêmero
WebRTC Mesh       ── áudio / vídeo / tela / DataChannel
STUN/TURN         ── conectividade entre redes
```

O desktop **não exige PostgreSQL, Docker ou um backend social externo instalado pelo usuário**. O banco é criado localmente pelo sidecar Rust.

O diretório de dados é fornecido pelo Electron através de `RISK_DATA_DIR`; o arquivo SQLite é criado como `risk.sqlite3`. O banco nunca é gravado dentro de `resources`, `app.asar` ou da pasta de instalação.

## Componentes

- `apps/web`: interface React, chamadas, chat P2P e signaling Supabase Realtime;
- `apps/desktop`: processo principal e preload Electron;
- `desktop-backend`: backend local Rust/Axum + SQLite usado pelo aplicativo desktop;
- `packages/rtc`: mídia, DataChannel e gerenciamento WebRTC;
- `packages/protocol`: tipos compartilhados;
- `server`: backend central PostgreSQL legado/experimental, mantido separadamente do caminho crítico do desktop;
- `infrastructure`: coturn, Docker e empacotamento.

## Backend desktop local

Quando o Electron inicia, ele:

1. gera um token aleatório por execução;
2. inicia `risk-desktop-backend` como processo filho;
3. fornece `RISK_DATA_DIR`, `RISK_LOCAL_TOKEN`, `RISK_WEB_ORIGIN` e `RISK_BACKEND_BIND=127.0.0.1:0`;
4. o Rust abre/cria o SQLite e executa migrations;
5. o Rust escolhe uma porta livre e escreve uma mensagem de readiness em stdout;
6. o Electron valida `/health`;
7. somente então a janela do Risk é aberta.

A URL do backend e o token local não são hardcoded no bundle Vite. O preload expõe `getBackendConfig()` ao renderer e o cliente API resolve o endpoint em runtime.

Toda API do sidecar, exceto `/health`, exige `X-Risk-Desktop-Token`. O servidor escuta apenas em `127.0.0.1`.

## Persistência

O backend desktop usa SQLite para dados locais como:

- contas/perfis locais;
- sessão ativa local;
- amizades e pedidos mantidos pela API local;
- comunidades e canais;
- mensagens mantidas pela API local;
- salas e memberships locais.

A migração dos registros P2P que ainda passam pelas abstrações de IndexedDB para SQLite está em andamento. A identidade criptográfica WebCrypto continua no navegador/Electron porque sua chave privada é mantida como `CryptoKey` não extraível.

## Supabase Signaling

O Supabase Realtime é usado apenas para coordenação temporária:

- Presence descobre peers conectados;
- Broadcast transporta offer, answer, ICE, perfil e estado efêmero;
- nenhuma tabela Supabase é necessária para chamadas;
- SDP, ICE e histórico de chamadas não são persistidos pelo Risk;
- mídia e mensagens P2P trafegam pelo WebRTC.

Configure apenas chaves públicas no frontend:

```dotenv
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-publica
VITE_DEBUG_SIGNALING=false
```

Nunca coloque `service_role`, senha de banco, `JWT_SECRET` ou `TURN_SECRET` no frontend.

## ICE / STUN / TURN

O cliente aceita configuração pública de servidores ICE por build:

```dotenv
VITE_ICE_SERVERS_JSON=[{"urls":["stun:stun.example.com:3478"]}]
```

Sem essa variável, existe um STUN de fallback.

O backend desktop **não contém `TURN_SECRET`**. Um segredo TURN permanente dentro do executável poderia ser extraído por qualquer usuário. Para produção, credenciais TURN temporárias devem vir de infraestrutura remota/gerenciada ou de um emissor mínimo separado do armazenamento social local.

## Desenvolvimento

Pré-requisitos para desenvolvimento: Node 22+, pnpm 10.15+ e Rust estável.

1. copie `.env.example` para `.env`;
2. configure `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`;
3. execute `pnpm install`;
4. execute:

```powershell
pnpm dev:desktop
```

O comando compila o `risk-desktop-backend` em modo debug antes de iniciar Electron. O Electron então sobe o sidecar automaticamente.

Enquanto `pnpm dev:desktop` estiver rodando, **a mesma UI também pode ser aberta diretamente em `http://localhost:5173` no navegador**. Em desenvolvimento, o Vite usa `/__risk-api` como proxy para o sidecar ativo e injeta `X-Risk-Desktop-Token` no processo Node, sem expor o token ao JavaScript da página. Assim Electron e navegador usam o mesmo backend e o mesmo `risk.sqlite3`.

O arquivo temporário de descoberta fica em `.risk/dev-backend.json`, é ignorado pelo Git e removido pelo Electron ao encerrar. O proxy só aceita clientes loopback; abrir a UI pelo endereço LAN do Vite não concede acesso ao backend local autenticado.

Para desenvolver somente a interface web:

```powershell
pnpm dev:web
```

Sem o Electron/sidecar ativo, chamadas a `/__risk-api` retornam 503. Para apontar deliberadamente o Vite para outra API durante desenvolvimento, defina `RISK_DEV_API_URL`. Em builds web de produção, `VITE_API_URL` continua disponível para uma API HTTP externa. Essa variável não é necessária para o desktop empacotado.

## Build desktop

Windows:

```powershell
pnpm package:win
```

Linux:

```bash
pnpm package:linux
```

Linux via Docker no Windows:

```powershell
pnpm package:linux:docker
```

O pipeline executa:

```text
cargo build --release (desktop-backend)
        ↓
pnpm build:web
        ↓
tsc Electron
        ↓
copia sidecar para apps/desktop/resources/backend
        ↓
electron-builder
```

O `electron-builder` coloca o binário Rust em `resources/backend/`, fora do ASAR. No Linux o script de preparação também aplica permissão executável.

Os artefatos finais ficam em `apps/desktop/release/`.

## Segurança Electron

O desktop mantém:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- preload CommonJS mínimo;
- novas janelas bloqueadas;
- navegação externa bloqueada;
- permissões de mídia limitadas à origem local do Risk;
- IPC validado pela origem;
- token efêmero para a API local;
- single-instance lock.

O frontend empacotado é servido em uma porta local dinâmica, evitando colisão com uma porta fixa.

## WebRTC e convites

O `MeshWebRTCTransport` limita cada cliente a cinco peers remotos, totalizando seis participantes por chamada.

Convites P2P usam códigos temporários no formato:

```text
risk-XXXX-XXXX-XXXX-XXXX
```

O código vira um rendezvous SHA-256 separado por namespace. Após abrir o DataChannel, solicitação, identidade pública, aceite/recusa e ACK usam mensagens ECDSA P-256 assinadas. A chave privada local é não extraível e nunca é enviada ao Supabase ou a outros peers.

## Testes e CI

```powershell
pnpm test
pnpm typecheck
```

A CI valida:

- TypeScript;
- testes Web/P2P;
- build Web;
- compilação do sidecar Rust desktop;
- bundle Electron contendo o sidecar;
- `cargo fmt`, `clippy` e testes do backend central legado;
- `cargo fmt`, `clippy` e testes do backend SQLite desktop.

Antes de sair de draft ainda são necessários smoke tests reais de NSIS/AppImage/DEB e testes WebRTC/TURN em duas máquinas/redes diferentes.

Consulte também [docs/architecture.md](docs/architecture.md) e [docs/protocol.md](docs/protocol.md).