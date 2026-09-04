import { openMicrophone } from "./audio";
import { openCamera } from "./video";

export class DeviceManager extends EventTarget {
  constructor() {
    super();
    navigator.mediaDevices.addEventListener("devicechange", () => this.dispatchEvent(new Event("change")));
  }

  async list(): Promise<MediaDeviceInfo[]> {
    return navigator.mediaDevices.enumerateDevices();
  }

  async getMicrophone(deviceId?: string): Promise<MediaStreamTrack> {
    return openMicrophone(deviceId);
  }

  async getCamera(deviceId?: string): Promise<MediaStreamTrack> {
    return openCamera(deviceId);
  }
}
