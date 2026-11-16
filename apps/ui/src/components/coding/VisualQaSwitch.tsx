import type { CodingProject } from "@mrog/shared";

import { useUpdateCodingSettings } from "../../hooks/coding";
import { useModels, useRuntime } from "../../hooks/runtime";
import { VISUAL_QA_HINT, visualQaWarning } from "../../lib/visualQa";
import { Switch } from "./Switch";

/** The Visual QA switch: QA also uses the running app once its other checks pass. With a note when its model can't see. */
export function VisualQaSwitch({ botId, project }: { botId: string; project: CodingProject }) {
  const settings = useUpdateCodingSettings(botId);
  const { data: catalog } = useModels();
  const { data: runtime } = useRuntime();
  const on = project.visualQa ?? false;
  const warning = on ? visualQaWarning(project, runtime?.settings.sharedModel, catalog?.models) : null;
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex items-center gap-2" title={VISUAL_QA_HINT}>
        <Switch
          on={on}
          onChange={(visualQa) => settings.mutate({ visualQa })}
          label="Visual QA"
          disabled={settings.isPending}
        />
        Visual QA
      </label>
      {warning && <p className="max-w-80 text-[11.5px] text-warning">{warning}</p>}
    </div>
  );
}
