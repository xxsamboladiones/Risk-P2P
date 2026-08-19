# Protocolos P2P e signaling

O Risk separa descoberta/negociação do transporte real. `SignalingProvider` coordena peers; `MeshWebRTCTransport` carrega mídia e DataChannels.

## Namespaces Realtime

Os namespaces atuais são:

- `room`: chamadas de voz/vídeo/tela;
- `chat`: DataChannel de canais de texto;
- `friend`: convites temporários de amizade;
- `group`: convites temporários para grupos.

O identificador lógico é convertido localmente em SHA-256. No provider Supabase, o tópico usa o namespace e parte do hash; o envelope carrega o hash completo derivado, não o identificador original.

## Presence

Presence contém somente dados pequenos e efêmeros:

```ts
{
  peerId: string;
  joinedAt: number;
  clientVersion?: string;
}
```

`peerId` é um UUID aleatório por sessão P2P. O provider reconcilia `presenceState()` no evento `sync`, emite `peerJoined`/`peerLeft` e mantém apenas peers remotos válidos.

Mensagens de Broadcast recebidas são descartadas se o `fromPeerId` não estiver atualmente no conjunto local de Presence. Essa verificação associa o envelope a um peer observado no canal, mas não constitui autenticação criptográfica permanente.

## Broadcast

Eventos utilizados pelo signaling:

- `webrtc.offer`;
- `webrtc.answer`;
- `webrtc.ice-candidate`;
- `peer.state`;
- `peer.profile`.

Cada payload usa envelope versão 1:

```ts
{
  version: 1;
  roomId: string;
  fromPeerId: string;
  targetPeerId?: string;
  messageId: string;
  timestamp: number;
  type: string;
  payload: object;
}
```

Offer, answer e ICE são direcionados. Estado e perfil podem ser broadcast para a sala.

Antes de tocar `RTCPeerConnection`, mensagens externas são verificadas por:

- versão e tipo esperados;
- UUIDs válidos;
- hash de sala esperado;
- `targetPeerId` quando presente;
- peer remetente presente;
- timestamp dentro da janela aceita;
- tamanho máximo do envelope;
- estrutura específica do payload;
- deduplicação por `messageId`;
- rate limit local por peer/tipo.

Caches de deduplicação e janelas antigas de rate limit são podados em memória.

## Negociação WebRTC

Na descoberta inicial, a ordem lexical dos `peerId`s define quem inicia a conexão. O transporte também implementa Perfect Negotiation para colisões de offer.

ICE usa trickle. Candidatos recebidos antes de `remoteDescription` são guardados em uma fila em memória, limitada a 256 entradas por peer.

O Mesh aceita por padrão até cinco peers remotos. Com o participante local, isso totaliza seis participantes por cliente.

Ao sair, o provider executa `untrack`/remoção do canal e o transporte fecha DataChannels/PeerConnections e limpa filas locais.

## Estado de mídia

`peer.state` contém:

```ts
{
  microphone: boolean;
  camera: boolean;
  screenShare: boolean;
  cameraStreamId?: string;
  screenStreamId?: string;
  screenAudio?: boolean;
}
```

`peer.profile` transporta somente o nome de exibição necessário à interface. Esses dados são efêmeros e não substituem a identidade persistente da conta.

## Chat por DataChannel

Quando existe handler de dados, o peer iniciador cria um DataChannel ordenado chamado `risk.chat`.

Mensagem wire versão 1:

```ts
{
  version: 1;
  type: "chat.message";
  channelId: string;
  id: string;
  author: string;
  content: string;
  timestamp: number;
}
```

O receptor valida canal, UUID da mensagem, tamanho, conteúdo e timestamp. O campo `author` continua no wire por compatibilidade, porém o `ChatController` não confia nele para a identidade exibida: a mensagem é associada ao `remotePeerId` real do DataChannel e ao `peer.profile` observado para aquele peer.

O transporte rejeita payloads acima de 64 KiB. O chat usa limite menor na validação e mensagens de até 4.000 caracteres. Quando `RTCDataChannel.bufferedAmount` ultrapassa o limite local de segurança, novas mensagens deixam de ser enfileiradas e o envio retorna falha ao chamador.

O conteúdo do chat não passa pelo Supabase. A cópia recebida é salva no IndexedDB local.

## Convites temporários

O código amigável possui o formato:

```text
risk-XXXX-XXXX-XXXX-XXXX
```

O alfabeto evita caracteres visualmente ambíguos. A normalização aceita variações de caixa/separadores, mas não trunca entrada excedente para transformá-la artificialmente em um código válido.

O rendezvous é derivado por:

```text
SHA-256("risk:" + tipo + ":" + codigo-normalizado)
```

Assim, o mesmo código em `friend` e `group` produz rendezvous distintos.

### Mensagem assinada

Depois que o DataChannel abre, o protocolo de convite usa mensagens assinadas ECDSA P-256:

```ts
{
  version: 1;
  type:
    | "friend.request"
    | "friend.accept"
    | "friend.reject"
    | "group.join.request"
    | "group.join.accept"
    | "group.join.reject"
    | "invite.ack"
    | "invite.busy";
  requestId: string;
  timestamp: number;
  identity: PublicPeerIdentity;
  group?: PublicGroupMetadata;
  reason?: string;
  signature: string;
}
```

A assinatura cobre a representação canônica dos campos não assinados. A chave pública acompanha a identidade e é importada apenas para verificação. A chave privada local nunca é enviada.

### Confirmação bilateral

O aceite usa ACK explícito para não considerar a operação concluída apenas porque `RTCDataChannel.send()` aceitou dados na fila:

```text
Joiner                 Creator
  | friend.request        |
  |---------------------->|
  |                       | aprovação humana
  | friend.accept         |
  |<----------------------|
  | persiste localmente   |
  | invite.ack            |
  |---------------------->|
  |                       | persiste localmente
  |     cleanup dos dois peers
```

O mesmo vale para `group.join.accept` e para rejeições. O ACK é reenviado algumas vezes se o DataChannel falhar imediatamente.

Um candidato que não abre DataChannel dentro do timeout é removido. O criador volta ao estado de espera enquanto o convite ainda estiver válido. Tentativas de entrada compartilham um limitador em memória na sessão do renderer.

## Persistência local de identidade

A identidade P2P usa ECDSA P-256. Na primeira criação, a chave pública é exportada para JWK e a chave privada é reimportada como `CryptoKey` com `extractable=false` antes de ser salva no IndexedDB. Identidades antigas com chave extraível são migradas ao serem carregadas.

Isso reduz exposição acidental da chave, embora qualquer código executado com acesso ao mesmo contexto origin ainda possa solicitar operações de assinatura usando o `CryptoKey`. Segurança do renderer continua sendo parte do modelo de confiança.

## Limitações deliberadas

- sem peer online não existe entrega P2P remota;
- Presence não é uma identidade de conta autenticada criptograficamente;
- o chat ainda não assina cada mensagem com a identidade persistente;
- conhecer/derivar um tópico Realtime não é o mesmo que passar por autorização de membership do backend;
- Mesh é adequado a grupos pequenos; para grupos maiores seria necessário considerar SFU/arquitetura diferente.
