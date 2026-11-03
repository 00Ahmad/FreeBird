import { X } from "lucide-react";
import type { ReactNode } from "react";

import { cn, IconButton } from "@mrog/ui-kit";

import { useUi, type SettingsSection } from "../../state";
import { Modal } from "../Modal";
import { RoutinesSettings } from "../routines/RoutinesSettings";
import { LocalModelSettings } from "./LocalModelSettings";
import { BrowserSettingsPage } from "./BrowserSettings";
import { AppsSettings, VaultSettings, VoiceSettingsPage } from "./Phase5Settings";
import { ComputerSettings, GeneralSettings } from "./PermissionsSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { SETTINGS_PAGES } from "./pages";
import { UsageSettings } from "./UsageSettings";

/** What each settings page draws; the menu order and labels are in SETTINGS_PAGES. */
const RENDER: Record<SettingsSection, () => ReactNode> = {
  general: () => <GeneralSettings />,
  model: () => <LocalModelSettings />,
  providers: () => <ProvidersSettings />,
  computer: () => <ComputerSettings />,
  browser: () => <BrowserSettingsPage />,
  routines: () => <RoutinesSettings />,
  apps: () => <AppsSettings />,
  vault: () => <VaultSettings />,
  voice: () => <VoiceSettingsPage />,
  usage: () => <UsageSettings />,
};

export function SettingsDialog() {
  const section = useUi((state) => state.settingsOpen);
  const open = useUi((state) => state.openSettings);
  if (!section) return null;
  const page = SETTINGS_PAGES.find((candidate) => candidate.id === section) ?? SETTINGS_PAGES[0]!;

  return (
    <Modal
      title="Settings"
      onClose={() => open(null)}
      bare
      className="h-[min(720px,90vh)] max-w-4xl flex-row"
    >
      <nav
        className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar p-3"
        aria-label="Settings"
      >
        <h2 className="px-2 pt-1 pb-3 text-[15px] font-semibold">Settings</h2>
        {SETTINGS_PAGES.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => open(candidate.id)}
            aria-current={candidate.id === page.id ? "page" : undefined}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-left text-[13px]",
              candidate.id === page.id ? "bg-selected font-medium text-ink" : "text-ink-2 hover:bg-hover",
            )}
          >
            {candidate.label}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center border-b border-border px-6 py-3">
          <h2 className="flex-1 text-[15px] font-semibold">{page.label}</h2>
          <IconButton label="Close settings" onClick={() => open(null)}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{RENDER[page.id]()}</div>
      </div>
    </Modal>
  );
}
