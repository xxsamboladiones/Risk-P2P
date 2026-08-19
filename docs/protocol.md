# Protocolo de signaling Realtime

As chamadas usam um `SignalingProvider` desacoplado do transporte WebRTC. Em produção, `SupabaseSignalingProvider` implementa a interface com Realtime Broadcast e Presence. Os testes usam `InMemorySignalingProvider`; nenhum teste unitário depende do Supabase real.

Cada sala é convertida localmente em SHA-256. O canal usa `risk:room:<32 primeiros caracteres do hash>` e os envelopes carregam o hash completo, nunca o UUID original da sala.

## Presence

Presence contém somente:

```ts
{ peerId: string; joinedAt: number; clientVersion?: string }
```

O `peerId` é um UUID aleatório criado para cada entrada na chamada. Não são enviados nome, e-mail, token, IP ou credenciais. `sync` reconcilia o conjunto local, cria uma única conexão por peer e remove conexões que desapareceram.

## Broadcast

Eventos utilizados:

- `webrtc.offer`;
- `webrtc.answer`;
- `webrtc.ice-candidate`;
- `peer.state`, somente para mute, câmera e tela efêmeros.
- `peer.profile`, somente para o nome de exibição necessário na interface.

O nome não é colocado no Presence. Ele é enviado por Broadcast efêmero, validado e descartado junto com o canal.

Cada payload usa um envelope versão 1 com `roomId`, `fromPeerId`, `targetPeerId`, `messageId`, `timestamp`, `type` e `payload`. Offer, answer e ICE são direcionados. Cada cliente ignora mensagens próprias ou destinadas a outro peer.

Antes de chegar ao `RTCPeerConnection`, mensagens externas são verificadas quanto a tipo, IDs, sala, idade, tamanho e payload. Há cache temporário contra duplicação, janela de rate limit e limite específico para ICE. SDP e candidatos não são registrados.

## Negociação

Na descoberta inicial, somente o menor `peerId` em ordem lexical inicia a offer. O Mesh também aplica Perfect Negotiation nas renegociações. ICE usa trickle e candidatos recebidos antes de `remoteDescription` ficam em uma fila somente em memória, limitada a 256 itens por peer.

Ao sair: Presence executa `untrack`, o canal é removido, callbacks são descartados, filas e caches são limpos, tracks são paradas e todas as conexões WebRTC são fechadas.

Não existem tabelas, Storage, Edge Functions ou operações Postgres para signaling.

## Mensagens pelo DataChannel

Depois da negociação, cada conexão abre um canal ordenado `risk.chat`. Mensagens usam envelope versão 1 com `type: "chat.message"`, `channelId`, UUID, autor, conteúdo e timestamp. O receptor valida canal, tamanho, idade e campos antes de gravar a cópia no IndexedDB. O Supabase não recebe esse envelope.
