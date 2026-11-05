import { useCallback } from "react";

import { useUi } from "../state";
import { useBots, useCreateBot } from "./bots";

/** Shortcuts and menus that create a bot have no place of their own for an error: the sidebar shows it. */
const failed = (error: unknown) =>
  useUi
    .getState()
    .notify(`Couldn't create the bot: ${error instanceof Error ? error.message : String(error)}`);

/** Creates a bot, opens its chat, and starts renaming it (create, then name it). */
export function useNewBot() {
  const { data: bots } = useBots();
  const first = (bots?.length ?? 0) === 0;
  const create = useCreateBot();
  return useCallback(async () => {
    try {
      const bot = await create.mutateAsync({ name: "New Bot", isPrimary: first });
      const ui = useUi.getState();
      ui.notify(null);
      ui.select(bot.threadId);
      ui.startRename(bot.id);
    } catch (error) {
      failed(error);
    }
  }, [first, create]);
}

/** Creates a Visual Bot (uses the web only by looking at the screen) and opens it with its Browser panel. */
export function useNewVisualBot() {
  const create = useCreateBot();
  return useCallback(async () => {
    try {
      const bot = await create.mutateAsync({
        name: "Visual Bot",
        label: "Browses by looking at the screen",
        avatar: { shape: "diamond", color: "sky" },
        visual: true,
      });
      const ui = useUi.getState();
      ui.notify(null);
      ui.select(bot.threadId);
      useUi.setState({ panel: "browser" });
      ui.startRename(bot.id);
    } catch (error) {
      failed(error);
    }
  }, [create]);
}
