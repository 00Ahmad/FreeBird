import { useEffect, useState } from "react";

import { cn } from "@mrog/ui-kit";

import { useConnection } from "../state";

const LABELS = { connecting: "Connecting…", online: "Connected", offline: "Offline · retrying" } as const;
const DOTS = { connecting: "bg-warning", online: "bg-success", offline: "bg-danger" } as const;

export function ConnectionStatus() {
  const { status, version, lastHeartbeat } = useConnection();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const age = lastHeartbeat ? Math.max(0, Math.round((now - lastHeartbeat) / 1000)) : null;
  return (
    <div
      className="flex items-center gap-2 px-2 text-xs text-ink-3"
      title={age === null ? "No heartbeat yet" : `Last heartbeat ${age}s ago`}
      role="status"
      aria-live="polite"
    >
      <span className={cn("size-2 rounded-full", DOTS[status])} aria-hidden="true" />
      <span>{LABELS[status]}</span>
      {version && status === "online" && <span className="ml-auto tabular-nums">v{version}</span>}
    </div>
  );
}
