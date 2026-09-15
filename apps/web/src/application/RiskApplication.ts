import type { CallController } from "../call";
import type { ChatController } from "../chat";
import type { BackgroundChatManager } from "../services/chat/background-manager";
import type { VoiceActivityDirectory } from "../services/supabase/voice-activity";
import type { RuntimeActivityTracker } from "../performance/activity";
import type { PerformanceCoordinator } from "../performance/coordinator";
import type { InviteApplicationService } from "./InviteApplicationService";
import type { SessionService } from "./SessionService";
import type { RiskGateway } from "./contracts";

export type RiskApplicationDependencies = {
  gateway: RiskGateway;
  call: CallController;
  chat: ChatController;
  callChat: ChatController;
  backgroundChats: BackgroundChatManager;
  voiceActivities: VoiceActivityDirectory;
  session: SessionService;
  invites: InviteApplicationService;
  performance: PerformanceCoordinator;
  performanceActivity: RuntimeActivityTracker;
  resetRuntimeAdapters(): void;
};

/** Única superfície entregue à camada React pelo composition root. */
export class RiskApplication {
  readonly gateway: RiskGateway;
  readonly call: CallController;
  readonly chat: ChatController;
  readonly callChat: ChatController;
  readonly backgroundChats: BackgroundChatManager;
  readonly voiceActivities: VoiceActivityDirectory;
  readonly session: SessionService;
  readonly invites: InviteApplicationService;
  readonly performance: PerformanceCoordinator;
  readonly performanceActivity: RuntimeActivityTracker;
  private readonly resetAdapters: () => void;

  constructor(dependencies: RiskApplicationDependencies) {
    this.gateway = dependencies.gateway;
    this.call = dependencies.call;
    this.chat = dependencies.chat;
    this.callChat = dependencies.callChat;
    this.backgroundChats = dependencies.backgroundChats;
    this.voiceActivities = dependencies.voiceActivities;
    this.session = dependencies.session;
    this.invites = dependencies.invites;
    this.performance = dependencies.performance;
    this.performanceActivity = dependencies.performanceActivity;
    this.resetAdapters = dependencies.resetRuntimeAdapters;
  }

  backendChanged(): void {
    this.resetAdapters();
  }
}
