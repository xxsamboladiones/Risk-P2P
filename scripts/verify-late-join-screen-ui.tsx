// Fixture local: usa o store, a associação de streams e o player reais da chamada.
import { createRoot } from "react-dom/client";
// O compilador desta fixture expõe o componente somente no bundle de teste.
import { VideoTile } from "../apps/web/src/components/CallWorkspace";
import { ParticipantManager } from "../apps/web/src/call/ParticipantManager";
import { useCallStore } from "../apps/web/src/store";

const manager = new ParticipantManager();
function UI() {
  const participants = useCallStore((state) => state.participants);
  return <>{Object.values(participants).map((participant) =>
    <div id={participant.peerId} key={participant.peerId}>
      <VideoTile participant={participant} tileId={participant.peerId} focused={false}
        compact={false} deafened={true} onFocus={() => {}} />
    </div>)}</>;
}
createRoot(document.getElementById("root")!).render(<UI />);
Object.assign(window, {
  testRemoteStream(id: string, remoteId: string, stream: MediaStream, screenId: string) {
    const key = `${id}-${remoteId}`;
    manager.state(key, { microphone: true, camera: false, screenShare: true, screenStreamId: screenId, screenAudio: true });
    manager.remoteStream(key, stream);
  },
  resetUI: () => manager.clear(),
});
