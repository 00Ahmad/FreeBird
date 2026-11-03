import { HelpCircle } from "lucide-react";
import { useState } from "react";

import type { MessagePart } from "@mrog/shared";
import { Button } from "@mrog/ui-kit";

import { api } from "../../lib/api";

type QuestionPart = Extract<MessagePart, { type: "question" }>;

export function QuestionCard({ part, live }: { part: QuestionPart; live: boolean }) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!answer.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api(`/questions/${part.questionId}`, { method: "POST", body: { answer: answer.trim() } });
    } catch (caught) {
      setError((caught as Error).message);
      setSending(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface p-3 text-[13px]">
      <div className="flex items-start gap-2">
        <HelpCircle size={15} className="mt-0.5 shrink-0 text-accent" />
        <p className="font-medium select-text">{part.question}</p>
      </div>
      {part.answer !== undefined ? (
        <p className="mt-1.5 pl-6 text-ink-2 select-text">You: {part.answer}</p>
      ) : part.expired ? (
        <p className="mt-1.5 pl-6 text-ink-3">No longer waiting for an answer.</p>
      ) : live ? (
        <form
          className="mt-2 flex gap-2 pl-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Your answer"
            aria-label="Your answer"
            autoFocus
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 outline-none focus:border-accent"
          />
          <Button size="sm" variant="primary" type="submit" disabled={sending || !answer.trim()}>
            Answer
          </Button>
        </form>
      ) : (
        <p className="mt-1.5 pl-6 text-ink-3">Not answered.</p>
      )}
      {error && <p className="mt-1.5 pl-6 text-xs text-danger">{error}</p>}
    </div>
  );
}
