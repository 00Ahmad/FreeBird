import { FileUp, Loader2, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import { Button, cn } from "@mrog/ui-kit";

import { useImportCoding } from "../../hooks/coding";
import { edgeLabel } from "../../lib/coding";
import { linkedFiles } from "../../lib/codingBoard";
import {
  canApplyImport,
  existingWarning,
  importInput,
  needsReplace,
  previewCounts,
  type ImportPreview,
} from "../../lib/codingImport";
import { Modal } from "../Modal";

/**
 * Import a plan: pick a file or paste text (a chat reply with the JSON inside works), look at what the server
 * understood, then apply. Applying leaves the plan waiting for your approval. If the board has already moved, you
 * confirm that it will be reset.
 */
export function ImportDialog({ botId, onClose }: { botId: string; onClose(): void }) {
  const run = useImportCoding(botId);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  // The plan to send again when applying (as read from the text), and whether the board must be reset to apply it.
  const [plan, setPlan] = useState<unknown>(null);
  const [replace, setReplace] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch {
      setProblem(`Couldn't read ${file.name}.`);
    }
  };

  const check = async () => {
    const input = importInput(text);
    if (!input.ok) return setProblem(input.problem);
    setProblem(null);
    setPlan(input.plan);
    const ask = (withReplace: boolean) =>
      run.mutateAsync({ plan: input.plan, dryRun: true, replace: withReplace });
    try {
      let result;
      try {
        result = await ask(false);
        setReplace(false);
      } catch (error) {
        if (!needsReplace(error)) throw error;
        // The board has moved: the preview is of what applying would do after a reset.
        result = await ask(true);
        setReplace(true);
      }
      setPreview(result.preview);
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const apply = async (withReplace: boolean) => {
    setProblem(null);
    try {
      await run.mutateAsync({ plan, replace: withReplace });
      onClose();
    } catch (error) {
      if (needsReplace(error)) setConfirming(true);
      else setProblem((error as Error).message);
    }
  };

  const warning = preview ? existingWarning(preview.existing) : null;

  return (
    <Modal title="Import a plan" onClose={onClose} className="max-w-2xl">
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
          {!preview ? (
            <>
              <p className="text-[13px] text-ink-2">
                Import a plan made somewhere else, for example by a larger model: a FreeBird plan file, or a
                chat reply with the JSON in it. The Planner is skipped, and you still approve the plan before
                any code is written.
              </p>
              <div className="flex items-center gap-2">
                <input
                  ref={picker}
                  type="file"
                  accept=".json,.txt,.md,application/json,text/*"
                  className="sr-only"
                  aria-label="Plan file"
                  tabIndex={-1}
                  onChange={(event) => {
                    void readFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <Button size="sm" onClick={() => picker.current?.click()}>
                  <FileUp size={13} /> Choose a file…
                </Button>
                <span className="min-w-0 truncate text-xs text-ink-3">
                  {fileName ?? "or paste the text below"}
                </span>
              </div>
              <textarea
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setFileName(null);
                  setProblem(null);
                }}
                rows={10}
                spellCheck={false}
                aria-label="Plan text"
                placeholder='{"format": "freebird-coding-plan", "version": 1, "nodes": [...], "edges": [...]}'
                className="resize-y rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-[12px] outline-none focus:border-accent"
              />
            </>
          ) : (
            <Preview preview={preview} warning={warning} />
          )}

          {replace && preview && (
            <p className="flex items-start gap-2 rounded-lg bg-hover px-3 py-2 text-[12.5px] text-warning">
              <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
              The board has already moved. Applying this plan resets the board and starts again from the plan.
            </p>
          )}
          {problem && (
            <p role="alert" className="text-[12.5px] whitespace-pre-wrap text-danger select-text">
              {problem}
            </p>
          )}
        </div>

        {confirming ? (
          <div className="flex flex-col gap-2 border-t border-border px-5 py-3">
            <p className="flex items-start gap-2 text-[13px]">
              <TriangleAlert size={15} className="mt-px shrink-0 text-warning" aria-hidden />
              Work has already started on this board. Applying the plan resets the board: every card goes back
              to Todo and the comments are removed.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Keep the board
              </Button>
              <Button variant="primary" onClick={() => void apply(true)} disabled={run.isPending}>
                {run.isPending && <Loader2 size={14} className="animate-spin" />} Reset the board and apply
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 border-t border-border px-5 py-3">
            <span className="min-w-0 flex-1 text-xs text-ink-3">
              {preview ? previewCounts(preview) : "Nothing is changed until you apply."}
            </span>
            {preview ? (
              <>
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void apply(replace)}
                  disabled={!canApplyImport(preview) || run.isPending}
                >
                  {run.isPending && <Loader2 size={14} className="animate-spin" />} Apply the plan
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void check()}
                  disabled={!text.trim() || run.isPending}
                >
                  {run.isPending && <Loader2 size={14} className="animate-spin" />} Preview
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** What the server understood: counts, errors as they are, the existing-file warning, then the files and links. */
function Preview({ preview, warning }: { preview: ImportPreview; warning: string | null }) {
  const ready = canApplyImport(preview);
  return (
    <div className="flex flex-col gap-3 text-[12.5px]">
      <p className={cn("font-medium", ready ? "text-success" : "text-danger")}>
        {ready
          ? `Understood: ${previewCounts(preview)}.`
          : `Can't use this plan yet (${previewCounts(preview)} read).`}
      </p>
      {preview.errors.length > 0 && (
        <ul
          role="alert"
          className="flex flex-col gap-1 rounded-lg bg-hover px-3 py-2 text-danger select-text"
        >
          {preview.errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
      {warning && (
        <p className="flex items-start gap-2 rounded-lg bg-hover px-3 py-2 text-warning">
          <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
          {warning}
        </p>
      )}
      {preview.nodes.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">Files</h3>
          <ul className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
            {preview.nodes.map((node) => (
              <li key={node.id} className="flex gap-2">
                <span className="shrink-0 font-mono">{node.path}</span>
                <span className="min-w-0 truncate text-ink-3" title={node.purpose}>
                  {node.purpose}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview.edges.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">Connections</h3>
          <ul className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
            {preview.edges.map((edge, index) => (
              <li key={edge.id} className="flex gap-2">
                <span className="shrink-0 font-medium">{edgeLabel(index)}</span>
                <span className="min-w-0">
                  {edge.description}
                  <span className="block truncate font-mono text-[11.5px] text-ink-3">
                    {linkedFiles(edge, preview.nodes)
                      .map((file) => file.path)
                      .join("  ·  ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
