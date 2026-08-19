# Arquitetura e operação

O Risk combina um backend central para identidade/dados duráveis com transporte P2P para comunicação em tempo real.

```text
React / Electron ── HTTP(S) ── Axum ── PostgreSQL
       │
       ├── Supabase Realtime
       │      Presence + Broadcast efêmeros
       │      offer / answer / ICE / estado / perfil
       │
       └════════ WebRTC Mesh P2P ════════ outros peers
              áudio / vídeo / tela / DataChannel
                         │
                    STUN / TURN
```

## Responsabilidades

### Backend Rust

O backend continua responsável por:

- autenticação e rotação de refresh tokens;
- contas e dados sociais persistentes do modelo central;
- comunidades/canais persistentes;
- memberships de voz representadas por `room_members`;
- emissão de credenciais TURN temporárias.

Ele **não participa do signaling WebRTC**. O desktop empacotado também não inclui PostgreSQL nem transforma esse backend em um processo local: builds de produção devem receber `VITE_API_URL` apontando para uma API acessível.

### Supabase Realtime

O Supabase é usado somente como rendezvous/signaling temporário. O cliente não usa `.from()`, Storage, Edge Functions ou tabelas Supabase para chamadas.

Broadcast não é usado como histórico. Presence desaparece quando o canal é encerrado. SDP, ICE e estado de chamada permanecem efêmeros no modelo do Risk.

### WebRTC

O `MeshWebRTCTransport` mantém no máximo uma `RTCPeerConnection` por peer e impõe cinco peers remotos, ou seja, no máximo seis participantes por cliente Mesh. O limite é uma proteção de escalabilidade no cliente; ele não é uma política de autorização do signaling.

Cada entrada gera um UUID efêmero. A sala é transformada em SHA-256 antes de virar tópico Realtime. Candidatos ICE recebidos cedo ficam em memória até `remoteDescription`, com limite por peer.

DataChannels aplicam limite de payload e um limite simples de `bufferedAmount` para evitar continuar enfileirando mensagens quando o canal está congestionado.

## Chat P2P

O chat conectado usa o mesmo `SignalingProvider` para negociar um `RTCDataChannel` ordenado. O conteúdo da mensagem passa diretamente pelo WebRTC e é salvo somente no IndexedDB de cada participante.

O campo `author` recebido pelo DataChannel não é usado cegamente para definir o nome exibido. A interface associa a mensagem ao `peerId` real da conexão e ao primeiro `peer.profile` observado para esse peer. Isso reduz spoofing simples, mas **não substitui assinatura criptográfica permanente de mensagens**.

Sem peers online, não há entrega remota. O histórico local também não é sincronizado automaticamente entre dispositivos.

## Convites P2P

Amizades e entrada em grupos podem ser concluídas por códigos temporários `risk-XXXX-XXXX-XXXX-XXXX`.

O código vira um rendezvous SHA-256 separado por namespace (`friend` ou `group`). Depois que o DataChannel é aberto, identidade pública e decisões usam mensagens ECDSA P-256 assinadas.

O fluxo de aceite é bilateral:

1. joiner envia a solicitação assinada;
2. criador aceita ou recusa;
3. joiner persiste o resultado recebido;
4. joiner envia `invite.ack` assinado;
5. somente após o ACK o criador persiste a amizade ou membership local;
6. ambos limpam signaling e transporte.

Há timeout de candidato para evitar que um peer ocupe o convite indefinidamente e limite de tentativas compartilhado pela sessão do cliente.

A chave privada local é armazenada no IndexedDB como `CryptoKey` não extraível. Ela nunca é enviada para Supabase ou para outro peer.

## Limites de confiança do signaling

Mensagens Realtime externas são verificadas quanto a tipo, IDs, sala, idade, tamanho, destino, deduplicação e rate limit. O provider também rejeita mensagens cujo `fromPeerId` não esteja atualmente presente no canal.

Isso reduz mensagens forjadas vindas de peers não observados, porém Presence e Broadcast continuam usando uma identidade efêmera escolhida pelo cliente. Não há, hoje, uma assinatura criptográfica ligando cada offer/answer/ICE ao usuário permanente da conta.

Da mesma forma, `room_members` mantém o modelo de autorização do backend coerente, mas não autoriza sozinho um tópico Realtime no Supabase. Se for necessário impedir que qualquer cliente conhecedor de um rendezvous assine o tópico, será preciso adicionar uma camada de autorização/autenticação específica para o Realtime.

## Electron

O processo desktop mantém:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- preload CommonJS mínimo (`preload.cjs`);
- IPC `screen:list` permitido somente para a origem do Risk;
- novas janelas bloqueadas;
- navegação para origens externas bloqueada;
- permissões de mídia/display condicionadas à origem confiável;
- single-instance lock para impedir colisão do servidor local de assets.

No pacote, os arquivos estáticos da interface são servidos em uma origem HTTP local previsível. Isso evita depender de `file://` e mantém o modelo de CORS/cookies consistente com o desenvolvimento.

## Backend, CORS e cookies

`WEB_ORIGINS` aceita uma lista separada por vírgulas. `WEB_ORIGIN` ainda é aceito como fallback de compatibilidade.

Quando `COOKIE_SECURE=false`, o refresh cookie usa `SameSite=Lax`, adequado ao desenvolvimento local. Quando `COOKIE_SECURE=true`, usa `SameSite=None; Secure`, necessário para uma implantação HTTPS na qual frontend e API estejam em sites distintos.

O backend também valida os principais limites de entrada, verifica `kind=access` no JWT e possui um limitador de login em memória por e-mail normalizado. Esse limitador é por instância do processo; uma implantação horizontal exigiria armazenamento/limitação compartilhada na borda ou em serviço central.

## Diagnóstico

`CallController.getDiagnostics()` retorna:

- status do signaling;
- status do canal;
- peer/sala derivados;
- peers observados em Presence;
- quantidade de mensagens de signaling processadas;
- `connectionState`, `iceConnectionState`, `signalingState`, fila ICE e estado do DataChannel de cada peer.

SDP, candidatos completos, chaves e credenciais TURN não fazem parte desse diagnóstico.

Use `VITE_DEBUG_SIGNALING=true` apenas em desenvolvimento.

## TURN em produção

As credenciais TURN são temporárias e assinadas pelo backend com `TURN_SECRET`.

Para uma implantação real:

- defina `TURN_HOST` com um hostname/IP alcançável pelos clientes;
- configure `external-ip` quando o servidor coturn estiver atrás de NAT;
- publique 3478 UDP/TCP;
- configure/publice uma faixa UDP de relay;
- considere 5349/TLS (`turns:`) para redes restritivas;
- mantenha `TURN_SECRET` apenas no backend/coturn.

O Docker de desenvolvimento publica `49160-49200/udp` como faixa de relay pequena para testes. Dimensione isso separadamente para produção.
