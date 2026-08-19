# Risk — comunicação P2P

Base monorepo para chamadas WebRTC no navegador e Electron (Windows/Linux), com signaling e autenticação em Rust/Axum.

## O que funciona neste corte

- cadastro e login com senha Argon2 e access token curto;
- criação e entrada em salas por UUID;
- signaling WebSocket autenticado, com validação de pertencimento à sala;
- áudio P2P, câmera, mute e compartilhamento de tela;
- ICE com STUN e credenciais TURN temporárias (TURN REST/HMAC);
- mesh limitado a seis participantes, isolado atrás de `CallTransport`;
- interface React responsiva compartilhada pelo Electron;
- preload Electron isolado, sem Node no renderer;
- PostgreSQL com migrations e ambiente Docker Compose.

Refresh token com rotação, presença Redis, seleção visual de fonte desktop, reconexão completa, VAD e diagnóstico de `getStats()` são a segunda etapa; as tabelas e interfaces necessárias já têm limites claros, mas estes itens não são declarados como prontos.

## Executar

Pré-requisitos: Node 22+, pnpm 10+, Rust estável e Docker.

1. Copie `.env.example` para `.env` e troque todos os segredos.
2. Repita o valor de `TURN_SECRET` em `infrastructure/coturn/turnserver.conf` (em produção, gere o arquivo no deploy em vez de versionar o segredo).
3. Execute `docker compose up -d postgres redis coturn`.
4. Execute `cd server && cargo run`.
5. Em outro terminal, execute `pnpm install && pnpm dev:web`.
6. Abra `http://localhost:5173` em dois perfis/navegadores, crie contas e use o mesmo código de sala.

Para Electron, execute `pnpm dev:desktop`. Builds: `pnpm build:web` e `pnpm build:desktop`.

Em produção, WebRTC exige HTTPS/WSS (exceto localhost), TURN com IP público anunciado, portas UDP liberadas e CORS restrito à origem real.

## Arquitetura

```text
React web ───────┐             ┌─ PostgreSQL (dados duráveis)
                 ├─ HTTP/WS ─ Axum
Electron + React ┘             └─ Redis (presença, próxima etapa)
       ║                             │
       ╚════ WebRTC P2P ═════════════╝ signaling apenas
                    │
               STUN / TURN
```

- `apps/web`: produto e UI.
- `apps/desktop`: processo principal e preload Electron.
- `packages/rtc`: mídia, dispositivos e transporte substituível.
- `packages/protocol`: mensagens signaling discriminadas.
- `server`: API, autenticação, salas, TURN REST e signaling.
- `infrastructure`: serviços locais.
- `docs`: decisões operacionais e protocolo.

Veja [docs/architecture.md](docs/architecture.md) e [docs/protocol.md](docs/protocol.md).
