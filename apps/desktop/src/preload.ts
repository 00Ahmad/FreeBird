import { contextBridge, ipcRenderer } from "electron";

/** The only bridge the UI gets: where the harness is, its token, and the OS. */
contextBridge.exposeInMainWorld("mrog", {
  harness: ipcRenderer.sendSync("mrog:harness") as { url: string; token: string } | null,
  platform: process.platform,
});
