# Arquitetura e operação

O backend Rust continua responsável pelos dados duráveis do produto: contas, amizades, grupos, canais, mensagens e emissão de credenciais TURN temporárias. Ele não participa mais do signaling de chamadas.

```text
React / Electron ── HTTP ── Axum ── PostgreSQL (dados duráveis do app)
       │
       ├── Supabase Realtime (Broadcast + Presence efêmeros)
       │          offer / answer / ICE / estado pequeno
       │
       └════════ WebRTC Mesh P2P ════════ outros peers
                    áudio / vídeo / tela
                              │
                         STUN / TURN
```

O Supabase não recebe mídia e não contém tabelas do Risk. Broadcast não persiste SDP/ICE; Presence desaparece quando o canal é encerrado. TURN continua separado e só retransmite mídia quando a conectividade direta não é possível.

O chat conectado usa o mesmo `SignalingProvider` para negociar um `RTCDataChannel`. O conteúdo das mensagens nunca passa pelo Supabase: é enviado diretamente no Mesh e salvo somente no IndexedDB de cada participante. Sem peers online, não há entrega remota.

## Limites e segurança

O Mesh mantém no máximo uma `RTCPeerConnection` por peer e é indicado para aproximadamente seis participantes. Cada entrada gera um UUID efêmero. A sala é transformada em SHA-256 antes de virar tópico Realtime. Mensagens têm validação estrutural, limite de 64 KiB, expiração, deduplicação e rate limit local.

Somente `VITE_SUPABASE_URL` e a chave pública `VITE_SUPABASE_ANON_KEY` chegam ao renderer. Nunca exponha `service_role`, secret key, senha do banco, JWT do backend ou credenciais TURN permanentes.

O cliente não chama `.from()`, Supabase Storage ou Edge Functions. O SDK é configurado sem sessão Supabase persistente e é utilizado apenas para Realtime.

## Diagnóstico

`CallController.getDiagnostics()` retorna status do signaling, status do canal, peer/sala derivados, peers de Presence, quantidade de mensagens processadas e, para cada conexão, `connectionState`, `iceConnectionState`, `signalingState` e fila de ICE. Conteúdo de SDP, candidatos e credenciais não é incluído.

Use `VITE_DEBUG_SIGNALING=true` somente em desenvolvimento para eventos resumidos. Mesmo nesse modo, SDP, ICE, chaves e tokens não são registrados.

## TURN em produção

Defina `external-ip`, realm público, TLS e faixa de relay no coturn; publique 3478 UDP/TCP, 5349 TLS e a faixa UDP configurada. As credenciais entregues ao cliente são temporárias e assinadas pelo backend.
