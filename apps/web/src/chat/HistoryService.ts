import { MessageService } from "./MessageService";
import {
  HISTORY_CHUNK_MESSAGES,
  HISTORY_CHUNK_EVENTS,
  MAX_HISTORY_IDS,
  localToSignedWire,
  type HistoryChunkWireMessage,
  type HistoryCompleteWireMessage,
  type HistoryRequestWireMessage,
  type SignedChatWireMessage,
  type SignedChatEventWireMessage,
} from "./MessageProtocol";

export type HistoryPeerContext = {
  channelId: string;
  remotePeerId: string;
  send(wire: string, peerId: string): number;
  isActive(): boolean;
  includeEvents?: boolean;
};

type HistoryRequestState = {
  requestId: string;
  context: HistoryPeerContext;
  messageBefore?: string;
  messageBeforeId?: string;
  eventBeforeTimestamp?: number;
  eventBeforeId?: string;
  messagesDone: boolean;
  eventsDone: boolean;
};

export class HistoryService {
  private readonly requests = new Map<string, HistoryRequestState>();

  constructor(
    private readonly messages: MessageService,
    private readonly verify: (message: SignedChatWireMessage) => Promise<boolean>,
    private readonly verifyEvent: (event: SignedChatEventWireMessage) => Promise<boolean>,
  ) {}

  resetSession(): void { this.requests.clear(); }
  forgetPeer(remotePeerId: string): void { this.requests.delete(remotePeerId); }

  async request(context: HistoryPeerContext): Promise<void> {
    if (this.requests.has(context.remotePeerId)) return;
    const [knownIds, knownEventIds] = await Promise.all([
      this.messages.history(context.channelId, { limit: MAX_HISTORY_IDS }).then((messages) => messages
      .slice(-MAX_HISTORY_IDS)
      .map((message) => message.id)),
      context.includeEvents
        ? this.messages.eventHistory(context.channelId, { limit: MAX_HISTORY_IDS }).then((events) => events.map((event) => event.id))
        : Promise.resolve(undefined),
    ]);
    if (!context.isActive()) return;
    const state: HistoryRequestState = {
      requestId: crypto.randomUUID(),
      context,
      messagesDone: false,
      eventsDone: !context.includeEvents,
    };
    this.issueRequest(state, knownIds, knownEventIds);
  }

  async respond(context: HistoryPeerContext, request: HistoryRequestWireMessage): Promise<void> {
    const known = new Set(request.knownIds);
    const messagePage = request.messagesDone ? [] : await this.messages.history(context.channelId, {
      limit: MAX_HISTORY_IDS,
      before: request.messageBefore,
      beforeId: request.messageBeforeId,
    });
    const messages = messagePage
      .map(localToSignedWire)
      .filter((message): message is SignedChatWireMessage => Boolean(message) && !known.has(message!.id));
    const knownEvents = new Set(request.knownEventIds ?? []);
    const eventPage = !request.eventsDone && request.knownEventIds
      ? await this.messages.eventHistory(context.channelId, {
        limit: MAX_HISTORY_IDS,
        beforeTimestamp: request.eventBeforeTimestamp,
        beforeId: request.eventBeforeId,
      })
      : [];
    const events = eventPage.filter((event) => !knownEvents.has(event.id));
    if (!context.isActive()) return;

    for (let index = 0; index < messages.length; index += HISTORY_CHUNK_MESSAGES) {
      if (!context.isActive()) return;
      const chunk: HistoryChunkWireMessage = {
        version: 2,
        type: "chat.history.chunk",
        channelId: context.channelId,
        requestId: request.requestId,
        messages: messages.slice(index, index + HISTORY_CHUNK_MESSAGES),
      };
      if (context.send(JSON.stringify(chunk), context.remotePeerId) === 0) return;
    }
    for (let index = 0; index < events.length; index += HISTORY_CHUNK_EVENTS) {
      if (!context.isActive()) return;
      const chunk: HistoryChunkWireMessage = {
        version: 2,
        type: "chat.history.chunk",
        channelId: context.channelId,
        requestId: request.requestId,
        messages: [],
        events: events.slice(index, index + HISTORY_CHUNK_EVENTS),
      };
      if (context.send(JSON.stringify(chunk), context.remotePeerId) === 0) return;
    }
    if (!context.isActive()) return;
    const complete: HistoryCompleteWireMessage = {
      version: 2,
      type: "chat.history.complete",
      channelId: context.channelId,
      requestId: request.requestId,
      ...(messagePage.length === MAX_HISTORY_IDS ? {
        nextMessageBefore: messagePage[0]!.createdAt,
        nextMessageBeforeId: messagePage[0]!.id,
      } : {}),
      ...(eventPage.length === MAX_HISTORY_IDS ? {
        nextEventBeforeTimestamp: eventPage[0]!.timestamp,
        nextEventBeforeId: eventPage[0]!.id,
      } : {}),
    };
    context.send(JSON.stringify(complete), context.remotePeerId);
  }

  async acceptChunk(remotePeerId: string, chunk: HistoryChunkWireMessage): Promise<void> {
    if (this.requests.get(remotePeerId)?.requestId !== chunk.requestId) return;
    for (const message of chunk.messages) {
      if (this.messages.hasProcessed(message.id) || !(await this.verify(message))) continue;
      await this.messages.persistSigned(message);
    }
    for (const event of chunk.events ?? []) {
      if (this.messages.hasProcessedEvent(event.id) || !(await this.verifyEvent(event))) continue;
      await this.messages.persistEvent(event);
    }
  }

  acceptComplete(remotePeerId: string, complete: HistoryCompleteWireMessage): void {
    const state = this.requests.get(remotePeerId);
    if (!state || state.requestId !== complete.requestId) return;

    const hasMessageCursor = complete.nextMessageBefore !== undefined && complete.nextMessageBeforeId !== undefined;
    const hasEventCursor = complete.nextEventBeforeTimestamp !== undefined && complete.nextEventBeforeId !== undefined;
    const messageAdvances = !hasMessageCursor || cursorAdvances(
      state.messageBefore,
      state.messageBeforeId,
      complete.nextMessageBefore!,
      complete.nextMessageBeforeId!,
    );
    const eventAdvances = !hasEventCursor || eventCursorAdvances(
      state.eventBeforeTimestamp,
      state.eventBeforeId,
      complete.nextEventBeforeTimestamp!,
      complete.nextEventBeforeId!,
    );
    if (!messageAdvances || !eventAdvances) {
      this.requests.delete(remotePeerId);
      return;
    }

    const next: HistoryRequestState = {
      ...state,
      requestId: crypto.randomUUID(),
      messageBefore: hasMessageCursor ? complete.nextMessageBefore : state.messageBefore,
      messageBeforeId: hasMessageCursor ? complete.nextMessageBeforeId : state.messageBeforeId,
      eventBeforeTimestamp: hasEventCursor ? complete.nextEventBeforeTimestamp : state.eventBeforeTimestamp,
      eventBeforeId: hasEventCursor ? complete.nextEventBeforeId : state.eventBeforeId,
      messagesDone: state.messagesDone || !hasMessageCursor,
      eventsDone: state.eventsDone || !hasEventCursor,
    };
    if (next.messagesDone && next.eventsDone) {
      this.requests.delete(remotePeerId);
      return;
    }
    this.issueRequest(next, [], next.eventsDone ? undefined : []);
  }

  private issueRequest(state: HistoryRequestState, knownIds: string[], knownEventIds?: string[]): void {
    const request: HistoryRequestWireMessage = {
      version: 2,
      type: "chat.history.request",
      channelId: state.context.channelId,
      requestId: state.requestId,
      knownIds,
      ...(knownEventIds ? { knownEventIds } : {}),
      ...(state.messageBefore && state.messageBeforeId ? { messageBefore: state.messageBefore, messageBeforeId: state.messageBeforeId } : {}),
      ...(state.eventBeforeTimestamp && state.eventBeforeId ? { eventBeforeTimestamp: state.eventBeforeTimestamp, eventBeforeId: state.eventBeforeId } : {}),
      ...(state.messagesDone ? { messagesDone: true } : {}),
      ...(state.eventsDone ? { eventsDone: true } : {}),
    };
    this.requests.set(state.context.remotePeerId, state);
    if (!state.context.isActive() || state.context.send(JSON.stringify(request), state.context.remotePeerId) === 0) {
      this.requests.delete(state.context.remotePeerId);
    }
  }
}

function cursorAdvances(previousTimestamp: string | undefined, previousId: string | undefined, nextTimestamp: string, nextId: string): boolean {
  return previousTimestamp === undefined
    || nextTimestamp < previousTimestamp
    || (nextTimestamp === previousTimestamp && previousId !== undefined && nextId < previousId);
}

function eventCursorAdvances(previousTimestamp: number | undefined, previousId: string | undefined, nextTimestamp: number, nextId: string): boolean {
  return previousTimestamp === undefined
    || nextTimestamp < previousTimestamp
    || (nextTimestamp === previousTimestamp && previousId !== undefined && nextId < previousId);
}
