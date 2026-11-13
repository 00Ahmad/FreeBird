import { contextBridge, ipcRenderer } from "electron";

/** The only bridge the UI gets: where the harness is, its token, the OS, and a folder dialog. */
contextBridge.exposeInMainWorld("mrog", {
  harness: ipcRenderer.sendSync("mrog:harness") as { url: string; token: string } | null,
  platform: process.platform,
  /** Opens the system folder dialog; the chosen folder's path, or null when cancelled. */
  pickFolder: () => ipcRenderer.invoke("mrog:pick-folder") as Promise<string | null>,
});
