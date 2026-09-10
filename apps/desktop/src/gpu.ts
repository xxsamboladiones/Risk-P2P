import { app } from "electron";
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";

export function configurePlatformRuntime(): void {
  const disabledFeatures: string[] = [];
  if (process.platform === "linux") {
    // pipewire-pulse pode expor o PID do daemon em vez do PID do cliente.
    process.env["PULSE_PROP_application.name"] = "Risk";
    process.env["PULSE_PROP_application.id"] = "com.risk.calls";
    // Impede que o APM do Chromium altere o controle físico de entrada do
    // PipeWire. O AGC escolhido nas configurações continua atuando no sinal
    // processado, sem mover o ganho do dispositivo do sistema.
    disabledFeatures.push("WebRtcAllowInputVolumeAdjustment");
  }

  if (shouldUseLinuxSoftwareRendering()) {
    app.disableHardwareAcceleration();
    disabledFeatures.push("VaapiVideoDecoder", "VaapiVideoEncoder");
    console.info("[desktop] GPU Linux incompatível ou inacessível; usando renderização por software.");
  }

  if (disabledFeatures.length > 0) {
    app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));
  }

  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
}

export function shouldUseLinuxSoftwareRendering(): boolean {
  if (process.platform !== "linux" || process.env.RISK_FORCE_GPU === "1") return false;
  if (process.env.RISK_DISABLE_GPU === "1") return true;

  const gbmDrivers = [
    "/usr/lib/gbm/dri_gbm.so",
    "/usr/lib64/gbm/dri_gbm.so",
    "/usr/lib/x86_64-linux-gnu/gbm/dri_gbm.so",
  ];
  const hasUnreadableGbmDriver = gbmDrivers.some((file) => {
    if (!existsSync(file)) return false;
    try {
      accessSync(file, fsConstants.R_OK);
      return false;
    } catch {
      return true;
    }
  });
  if (hasUnreadableGbmDriver) return true;

  const identity = [
    "/sys/class/dmi/id/sys_vendor",
    "/sys/class/dmi/id/product_name",
    "/sys/class/dmi/id/board_vendor",
  ].map((file) => {
    try { return readFileSync(file, "utf8"); }
    catch { return ""; }
  }).join(" ").toLocaleLowerCase().replace(/\s+/g, " ");

  return [
    "vmware",
    "virtualbox",
    "qemu",
    "kvm",
    "hyper-v",
    "microsoft corporation virtual machine",
    "parallels",
    "bochs",
    "xen",
  ].some((marker) => identity.includes(marker));
}
