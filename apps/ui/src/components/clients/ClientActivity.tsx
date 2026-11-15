import type { ClientProject } from "@mrog/shared";

/** What the Client Bot did, newest first. */
export function ClientActivity({ project }: { project: ClientProject }) {
  const lines = project.log.toReversed();
  if (lines.length === 0) return <p className="p-4 text-[13px] text-ink-3">Nothing yet.</p>;
  return (
    <ol className="flex flex-col gap-1.5 p-4 text-[12.5px]">
      {lines.map((line, index) => (
        <li key={`${line.at}-${index}`} className="flex gap-2">
          <time className="shrink-0 text-ink-3" dateTime={line.at}>
            {new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
          <span className="min-w-0">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}
