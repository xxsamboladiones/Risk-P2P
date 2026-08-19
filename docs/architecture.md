# Arquitetura e operação

O Risk Desktop usa Electron para a aplicação principal, React no renderer e um sidecar Rust/Axum para persistência local.

```text
┌──────────────────────────── Risk Desktop ────────────────────────────┐
│                                                                      │
│  Electron Main                                                       │
│      │                                                               │
│      ├── frontend React                                              │
│      │       │                                                       │
│      │       └── HTTP local + token efêmero                         │
│      │                                                               │
│      └── risk-desktop-backend                                        │
│              │                                                       │
│              └── SQLite em app.getPath("userData")                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                │                              │
                │ Supabase Realtime            │ STUN/TURN
                │ Presence/Broadcast            │
                └────────── WebRTC Mesh P2P ────┘
                  áudio / vídeo / tela / dados
```

## Desktop backend

`desktop-backend` é o backend usado pelo aplicativo empacotado. Ele não exige PostgreSQL.

Na inicialização:

1. o Electron escolhe/abre uma origem HTTP local para os assets;
2. gera `RISK_LOCAL_TOKEN` aleatório;
3. inicia o sidecar;
4. fornece `RISK_DATA_DIR=app.getPath("userData")`;
5. fornece `RISK_WEB_ORIGIN` e `RISK_BACKEND_BIND=127.0.0.1:0`;
6. o sidecar abre `risk.sqlite3` e executa migrations;
7. o sidecar escreve `RISK_BACKEND_READY {"url":"http://127.0.0.1:..."}`;
8. Electron valida `/health` e só então cria a janela.

O endpoint é dinâmico. Não existe uma porta fixa obrigatória para o backend ou para o servidor de assets do aplicativo empacotado.

Toda rota da API local, exceto `/health`, exige `X-Risk-Desktop-Token`. O token é criado novamente a cada execução e entregue ao renderer somente pelo preload/IPC.

## Persistência SQLite

O banco local fica fora da pasta de instalação. Atualizar ou reinstalar os arquivos do programa não deve sobrescrever o banco em `userData`.

O schema local contém atualmente contas, estado de sessão, amizades/pedidos locais, comunidades, canais, mensagens, salas e memberships. Há também migrations preparadas para mover registros sociais P2P para SQLite.

A chave privada da identidade P2P permanece como `CryptoKey` não extraível no armazenamento WebCrypto/IndexedDB. Isso é intencional: serializar a chave privada em SQLite exigiria torná-la exportável ou adotar um keystore nativo separado.

## Backend PostgreSQL legado

O diretório `server` continua existindo como backend central PostgreSQL legado/experimental. Ele não faz parte do caminho crítico do Risk Desktop e não é iniciado pelo instalador.

O objetivo do desktop é não exigir PostgreSQL, Docker ou credenciais de banco do usuário final.

## Supabase Realtime

Supabase é rendezvous/signaling efêmero:

- Presence descobre peers;
- Broadcast transporta offer/answer/ICE e estado efêmero;
- nenhuma tabela Supabase é necessária para chamadas;
- SDP, ICE e presença não são persistidos pelo Risk;
- mídia e DataChannel seguem diretamente pelo WebRTC.

A sala é derivada antes de virar tópico Realtime. O provider rejeita mensagens próprias, mensagens destinadas a outro peer, mensagens duplicadas, antigas ou de peers que não estejam presentes no canal.

Presence ainda usa identidade efêmera escolhida pelo cliente. O protocolo de convites possui identidade ECDSA permanente, mas signaling geral e chat ainda podem ser endurecidos com handshake/assinaturas ligadas à identidade P2P durável.

## WebRTC

`MeshWebRTCTransport` mantém no máximo cinco peers remotos, totalizando seis participantes por cliente.

O transporte implementa:

- Perfect Negotiation;
- fila ICE até `remoteDescription`;
- limite de peers;
- backpressure simples de DataChannel;
- limpeza de tracks, peer connections e callbacks;
- diagnóstico sem expor SDP ou credenciais completas.

## Chat P2P

O chat negocia um DataChannel ordenado usando o mesmo modelo de signaling. Mensagens trafegam diretamente pelo WebRTC.

O nome recebido não é confiado cegamente ao campo `author`; o cliente o associa ao peer conectado. Ainda falta ligar cada sessão de chat à identidade criptográfica permanente para uma garantia mais forte contra impersonação.

## Convites P2P

Convites usam códigos temporários `risk-XXXX-XXXX-XXXX-XXXX` e rendezvous derivado por SHA-256.

Após conexão WebRTC, as mensagens de convite usam ECDSA P-256 e ACK bilateral:

1. joiner envia solicitação assinada;
2. criador aceita ou recusa;
3. joiner persiste a decisão;
4. joiner envia `invite.ack`;
5. criador persiste somente depois do ACK;
6. signaling/transporte temporários são destruídos.

## TURN

O sidecar local não deve possuir `TURN_SECRET` de um relay público. Qualquer segredo permanente distribuído dentro do aplicativo pode ser extraído.

Para redes em que conexão direta/STUN falha, o Risk deve usar:

- serviço TURN gerenciado; ou
- um emissor remoto mínimo de credenciais TURN temporárias.

Esse serviço não precisa armazenar amigos, mensagens ou grupos.

## Electron

O processo desktop usa:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- preload CommonJS mínimo;
- navegação externa bloqueada;
- `window.open` bloqueado;
- permissões de mídia limitadas à origem Risk;
- IPC validado por origem;
- single-instance lock;
- sidecar iniciado antes da UI ficar disponível.

## Empacotamento

O build de produção segue:

```text
cargo build --release --manifest-path desktop-backend/Cargo.toml
        ↓
apps/desktop/resources/backend/risk-desktop-backend(.exe)
        ↓
pnpm build:web
        ↓
Electron TypeScript
        ↓
electron-builder
```

`extraResources` coloca o sidecar em `resources/backend/`, fora do ASAR. No Linux, o script aplica permissão executável.

## Validação antes de release

Além da CI, validar manualmente:

- NSIS em Windows limpo;
- AppImage em Linux;
- DEB em Linux;
- criação e reapertura do SQLite;
- upgrade sem perda de dados;
- encerramento do sidecar junto com Electron;
- dois PCs em redes diferentes;
- fallback TURN em NAT restritivo;
- câmera, microfone e compartilhamento de tela/áudio.
