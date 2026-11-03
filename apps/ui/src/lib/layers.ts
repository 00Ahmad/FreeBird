/** Dialogs and menus open over the app, in the order they opened. Only the topmost one answers Escape. */
export function createLayerStack() {
  const layers: { close(): void }[] = [];
  return {
    /** Puts a layer on top; the returned function takes it off again. */
    push(close: () => void): () => void {
      const layer = { close };
      layers.push(layer);
      return () => {
        const at = layers.indexOf(layer);
        if (at !== -1) layers.splice(at, 1);
      };
    },
    /** Closes the topmost layer; false when nothing is open. */
    escape(): boolean {
      const top = layers.at(-1);
      if (!top) return false;
      top.close();
      return true;
    },
    get open() {
      return layers.length > 0;
    },
  };
}

const stack = createLayerStack();
let listening = false;

/** Registers a dialog or menu; Escape closes whichever is on top, so a nested dialog never closes its parent. */
export function pushLayer(close: () => void): () => void {
  if (!listening) {
    listening = true;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || event.isComposing) return;
        if (stack.escape()) event.stopPropagation();
      },
      true,
    );
  }
  return stack.push(close);
}

/** True while a dialog or menu covers the app: global shortcuts leave the keyboard to it. */
export const layerOpen = () => stack.open;
