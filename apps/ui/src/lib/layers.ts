/** What `push` returns: takes the layer off again, and says whether it is the one on top. */
export type LayerHandle = (() => void) & { isTop(): boolean };

/** Dialogs and menus open over the app, in the order they opened. Only the topmost one answers Escape. */
export function createLayerStack() {
  const layers: { close(): void }[] = [];
  return {
    /** Puts a layer on top; the returned function takes it off again. */
    push(close: () => void): LayerHandle {
      const layer = { close };
      layers.push(layer);
      const pop = () => {
        const at = layers.indexOf(layer);
        if (at !== -1) layers.splice(at, 1);
      };
      return Object.assign(pop, { isTop: () => layers.at(-1) === layer });
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

/**
 * Registers a dialog or menu; Escape closes whichever is on top, so a nested dialog never closes its parent. The
 * handle says whether this layer is the top one, which is when it owns the keyboard (a dialog traps Tab only then).
 */
export function pushLayer(close: () => void): LayerHandle {
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
