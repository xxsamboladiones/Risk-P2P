# Risk — comunicação P2P

**Risk** é um aplicativo desktop de comunicação P2P com chamadas de voz e vídeo, compartilhamento de tela, chat, grupos e transferência de arquivos usando WebRTC.

> **Versão atual: Alpha 0.1.3**
>
> O projeto ainda está em fase Alpha. Recursos, protocolo e persistência podem mudar entre versões.

## Principais recursos

- chamadas de voz P2P;
- chamadas de vídeo com múltiplos participantes;
- compartilhamento de tela com presets de qualidade até 1080p/60 FPS;
- modo de tela cheia com foco em uma transmissão e zoom pelo scroll do mouse;
- chat integrado durante chamadas;
- envio P2P de arquivos e anexos pelo DataChannel;
- previews de imagens, vídeos e áudios;
- grupos com canais de texto e voz;
- criação, edição e exclusão de canais locais;
- amizades e convites P2P por código;
- armazenamento local no desktop com Rust + SQLite;
- aplicativo Electron para Windows e Linux.

No Windows, o compartilhamento de tela pode capturar o áudio do sistema usando o caminho nativo do Electron. No Linux existe um caminho experimental via PipeWire para compartilhar áudio do sistema sem retransmitir o próprio áudio reproduzido pelo Risk; quando esse caminho não está disponível, o compartilhamento continua somente com vídeo.

## Como o Risk funciona

O desktop é entregue como **um único aplicativo**, mas internamente possui dois processos:

```text
Risk Desktop
│
├── Electron + React
│   ├── interface
│   ├── captura de mídia
│   ├── signaling
│   └── WebRTC
│
└── risk-desktop-backend
    ├── Rust + Axum
    └── SQLite local

Supabase Realtime ── signaling / rendezvous efêmero
WebRTC Mesh       ── áudio / vídeo / tela / chat / arquivos
STUN/TURN         ── conectividade entre redes
```

O desktop **não exige PostgreSQL, Docker ou um servidor social instalado pelo usuário**. O sidecar Rust é iniciado automaticamente pelo Electron e cria o banco local em `app.getPath("userData")`.

O arquivo SQLite é salvo como:

```text
risk.sqlite3
```

O banco não é gravado dentro de `resources`, `app.asar` ou da pasta de instalação.

## P2P e privacidade

O Supabase Realtime é usado apenas para coordenação temporária entre peers:

- Presence encontra peers conectados;
- Broadcast transporta offer, answer, ICE e estado efêmero;
- nenhuma tabela Supabase é necessária para chamadas;
- mídia, mensagens e arquivos trafegam pelo WebRTC;
- SDP, ICE e histórico de chamadas não são persistidos pelo Risk.

Convites P2P usam códigos temporários no formato:

```text
risk-XXXX-XXXX-XXXX-XXXX
```

A identidade P2P usa ECDSA P-256. A chave privada local é mantida como `CryptoKey` não extraível e não é enviada ao Supabase ou a outros peers.

## Transferência de arquivos

Anexos usam um DataChannel dedicado para transferência binária, separado do canal normal de mensagens.

O protocolo inclui:

- transferência em chunks;
- SHA-256 incremental;
- progresso, velocidade e ETA;
- retomada e solicitação de arquivos;
- previews de mídia;
- armazenamento local de anexos.

## Chamadas

O transporte atual usa WebRTC Mesh e limita cada cliente a cinco peers remotos, totalizando até **seis participantes por chamada**.

A interface de chamada suporta:

- microfone;
- câmera;
- compartilhamento de tela;
- seleção de janela/tela dentro do próprio Risk Desktop;
- 720p/30 FPS;
- 720p/60 FPS;
- 1080p/30 FPS;
- 1080p/60 FPS;
- stream em destaque com thumbnails dos demais participantes;
- tela cheia;
- zoom com a roda do mouse no modo tela cheia;
- alternância entre chamada e chat sem encerrar a conexão.

## Componentes

```text
apps/web           Interface React, chat, chamadas e signaling
apps/desktop       Electron Main + preload
packages/rtc       WebRTC, mídia, DataChannels e file transfer
packages/protocol  Tipos e mensagens compartilhadas
desktop-backend    Backend local Rust/Axum + SQLite
server             Backend PostgreSQL legado/experimental
infrastructure     Coturn, Docker e infraestrutura auxiliar
```

## Backend desktop local

Quando o Electron inicia:

1. gera um token local aleatório por execução;
2. inicia `risk-desktop-backend` como processo filho;
3. fornece o diretório de dados e configurações locais;
4. o backend abre/cria o SQLite e executa migrations;
5. escolhe uma porta loopback livre;
6. o Electron valida `/health`;
7. a janela do Risk é aberta.

A API local escuta apenas em `127.0.0.1` e, exceto por `/health`, exige `X-Risk-Desktop-Token`.

## Configuração

Copie `.env.example` para `.env` e configure pelo menos:

```dotenv
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-publica
VITE_DEBUG_SIGNALING=false
```

Configuração pública de ICE também pode ser definida por build:

```dotenv
VITE_ICE_SERVERS_JSON=[{"urls":["stun:stun.example.com:3478"]}]
```

Nunca coloque `service_role`, senha de banco, `JWT_SECRET` ou `TURN_SECRET` no frontend.

## Desenvolvimento

Pré-requisitos:

- Node.js 22+;
- pnpm 10.15+;
- Rust estável.

Instale as dependências:

```powershell
pnpm install
```

Inicie o desktop:

```powershell
pnpm dev:desktop
```

O comando prepara o sidecar Rust em modo debug, inicia o Vite e abre o Electron.

Para trabalhar somente na interface web:

```powershell
pnpm dev:web
```

## Build desktop

### Windows

```powershell
pnpm package:win
```

O Windows usa:

```text
apps/desktop/build/icon.ico
```

### Linux

```bash
pnpm package:linux
```

Ou, no Windows usando Docker:

```powershell
pnpm package:linux:docker
```

O Linux usa:

```text
apps/desktop/build/icon.png
```

Os artefatos finais ficam em:

```text
apps/desktop/release/
```

## Segurança Electron

O desktop mantém:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- preload mínimo;
- novas janelas bloqueadas;
- navegação externa bloqueada;
- permissões de mídia limitadas à origem local do Risk;
- IPC validado pela origem;
- token efêmero para a API local;
- single-instance lock.

## Testes

```powershell
pnpm typecheck
pnpm test
```

A CI valida TypeScript, testes Web/P2P, build Web, Electron e o código Rust dos backends.

## Alpha 0.2.0

Esta versão adiciona e melhora principalmente:

- chamadas de voz e vídeo;
- compartilhamento de tela e presets de qualidade;
- tela cheia com zoom;
- chat durante chamadas;
- transferência de arquivos e anexos;
- previews de mídia;
- gerenciamento de grupos e canais;
- melhorias de estabilidade e conexão P2P;
- suporte experimental a áudio de screen share via PipeWire no Linux;
- nova identidade visual do aplicativo.

## Documentação

Consulte também:

- [Arquitetura](docs/architecture.md)
- [Protocolo](docs/protocol.md)

---

Risk está em desenvolvimento ativo. Bugs e mudanças incompatíveis ainda podem ocorrer durante a fase Alpha.
