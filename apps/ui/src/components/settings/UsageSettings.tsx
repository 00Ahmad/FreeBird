import { BotAvatar } from "@mrog/ui-kit";

import { useBots } from "../../hooks/bots";
import { useUsage } from "../../hooks/providers";
import { effectiveModel, useRuntime } from "../../hooks/runtime";
import { Section } from "./parts";

const fmt = (n: number) => n.toLocaleString();

export function UsageSettings() {
  const { data: usage } = useUsage();
  const { data: bots } = useBots();
  const { data: runtime } = useRuntime();
  if (!usage || !bots) return null;
  const local = new Set(usage.localProviders);

  return (
    <Section
      title="Tokens by bot"
      description="Counted from every reply. Models on this computer cost nothing; cloud costs depend on your provider's prices."
    >
      <table className="w-full text-left text-[13px]">
        <thead className="text-[12px] text-ink-3">
          <tr>
            <th className="py-1 font-medium">Bot</th>
            <th className="py-1 font-medium">Model</th>
            <th className="py-1 text-right font-medium">Replies</th>
            <th className="py-1 text-right font-medium">Input</th>
            <th className="py-1 text-right font-medium">Output</th>
            <th className="py-1 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {bots.map((bot) => {
            const row = usage.bots.find((candidate) => candidate.botId === bot.id);
            const model = effectiveModel(bot.model, runtime);
            const isLocal = model ? local.has(model.split(":")[0]!) : true;
            return (
              <tr key={bot.id} className="border-t border-border">
                <td className="py-2">
                  <span className="flex items-center gap-2">
                    <BotAvatar avatar={bot.avatar} size={18} /> {bot.name}
                  </span>
                </td>
                <td className="max-w-40 truncate py-2 text-ink-2">{model ?? "—"}</td>
                <td className="py-2 text-right tabular-nums">{fmt(row?.messages ?? 0)}</td>
                <td className="py-2 text-right tabular-nums">{fmt(row?.inputTokens ?? 0)}</td>
                <td className="py-2 text-right tabular-nums">{fmt(row?.outputTokens ?? 0)}</td>
                <td className="py-2 text-right text-ink-2">{isLocal ? "$0 (local)" : "see provider"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}
