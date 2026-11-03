import { Plus } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import { Button } from "@mrog/ui-kit";

import { useBots } from "../hooks/bots";
import { useRuntime } from "../hooks/runtime";
import { useThread } from "../hooks/threads";
import { useNewBot } from "../hooks/useNewBot";
import { harnessInfo } from "../lib/harness";
import { useUi } from "../state";
import { ChatView } from "./chat/ChatView";
import { SetupPanel } from "./setup/SetupPanel";

const LibraryView = lazy(() => import("./LibraryView").then((module) => ({ default: module.LibraryView })));

export function MainPane() {
  const { data: bots, isPending } = useBots();
  const { data: runtime } = useRuntime();
  const selectedThreadId = useUi((state) => state.selectedThreadId);
  const view = useUi((state) => state.view);
  const thread = useThread(selectedThreadId);
  const newBot = useNewBot();

  if (!harnessInfo()) {
    return (
      <Centered>
        <h1 className="text-lg font-semibold">Can't find the harness</h1>
        <p className="max-w-sm text-center text-ink-2">
          Start the app with <code className="font-mono">pnpm dev</code> so the UI knows where the local
          harness is.
        </p>
      </Centered>
    );
  }
  if (isPending || !runtime) return <main className="h-full bg-bg" />;
  if (!runtime.settings.sharedModel && !bots?.some((bot) => bot.model)) return <SetupPanel />;
  if (view === "library")
    return (
      <Suspense fallback={<main className="h-full bg-bg" />}>
        <LibraryView />
      </Suspense>
    );
  if (thread) return <ChatView key={thread.id} thread={thread} />;

  if (!bots?.length) {
    return (
      <Centered>
        <h1 className="text-xl font-semibold tracking-tight">Your team starts here</h1>
        <p className="max-w-sm text-center text-ink-2">
          Bots are teammates you message. Create your first one; it becomes your Primary Bot.
        </p>
        <Button variant="primary" onClick={() => void newBot()}>
          <Plus size={16} /> Create a Bot
        </Button>
      </Centered>
    );
  }

  return (
    <Centered>
      <p className="text-ink-3">Pick a bot from the sidebar.</p>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6">{children}</main>
  );
}
