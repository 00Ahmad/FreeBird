import { ArrowLeft, Loader2, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { useState } from "react";

import {
  AVATAR_COLORS,
  DISCUSSION_GOALS,
  MAX_CLUSTER,
  MAX_DISCUSSION_ROUNDS,
  MIN_CLUSTER,
  type ClusterMember,
  type DiscussionGoal,
} from "@mrog/shared";
import { BotAvatar, Button, cn } from "@mrog/ui-kit";

import { useCreateCluster, useProposeCluster } from "../hooks/discussion";
import { useUi } from "../state";
import { Modal } from "./Modal";
import { ModelSelect } from "./ModelSelect";

const GOALS = Object.entries(DISCUSSION_GOALS) as [DiscussionGoal, { label: string; description: string }][];

const field =
  "w-full rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent";

/** What's wrong with the team, or null when it can start. */
function teamProblem(team: ClusterMember[]): string | null {
  if (team.length < MIN_CLUSTER) return `A cluster needs at least ${MIN_CLUSTER} experts.`;
  if (team.some((member) => !member.name.trim())) return "Give every expert a name.";
  if (team.some((member) => !member.expertise.trim() || !member.personality.trim()))
    return "Give every expert an expertise and a personality.";
  const names = team.map((member) => member.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Give each expert a different name.";
  return null;
}

/**
 * New cluster: type a topic, get the 3–5 experts it needs (names and personalities), adjust them, start. The
 * experts are made for this cluster and live only in it.
 */
export function NewClusterDialog() {
  const setOverlay = useUi((state) => state.setOverlay);
  const select = useUi((state) => state.select);
  const propose = useProposeCluster();
  const create = useCreateCluster();
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState<DiscussionGoal>("decide");
  const [rounds, setRounds] = useState(2);
  const [team, setTeam] = useState<ClusterMember[] | null>(null);
  const close = () => setOverlay(null);
  const ready = topic.trim().length >= 3;

  const ask = () =>
    propose.mutate({ topic: topic.trim(), goal }, { onSuccess: (members) => setTeam(members) });

  const change = (index: number, patch: Partial<ClusterMember>) =>
    setTeam(
      (current) => current?.map((member, i) => (i === index ? { ...member, ...patch } : member)) ?? null,
    );

  const problem = team ? teamProblem(team) : null;
  const replies = (team?.length ?? 0) * rounds;

  return (
    <Modal title="New cluster" onClose={close} className="max-w-2xl">
      {!team ? (
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !propose.isPending) ask();
          }}
        >
          <p className="text-[13px] text-ink-2">
            Give it a topic. You'll get the {MIN_CLUSTER}–{MAX_CLUSTER} experts it needs, each with a
            personality and a point of view, to check before they start discussing.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Topic</span>
            <textarea
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (ready && !propose.isPending) ask();
                }
              }}
              rows={3}
              placeholder="For example: Should our 20-person company move from AWS to its own servers?"
              className={cn(field, "resize-none py-2")}
            />
          </label>

          <fieldset className="grid grid-cols-3 gap-2">
            <legend className="mb-1.5 text-[13px] font-medium">Goal</legend>
            {GOALS.map(([value, info]) => (
              <label
                key={value}
                title={info.description}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-lg border border-border px-3 py-2",
                  goal === value && "border-accent bg-selected",
                )}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  <input type="radio" name="goal" checked={goal === value} onChange={() => setGoal(value)} />
                  {info.label}
                </span>
                <span className="text-[11.5px] leading-snug text-ink-3">{info.description}</span>
              </label>
            ))}
          </fieldset>

          {propose.error && <p className="text-xs text-danger">{propose.error.message}</p>}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-ink-3">
              {propose.isPending
                ? "Working out which experts this topic needs… (up to a minute on a local model)"
                : ""}
            </span>
            <Button variant="primary" type="submit" disabled={!ready || propose.isPending}>
              {propose.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {propose.isPending ? "Proposing…" : "Propose a team"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex min-h-0 flex-col">
          <div className="flex items-start gap-2 border-b border-border px-5 py-3">
            <button
              type="button"
              onClick={() => setTeam(null)}
              className="mt-0.5 rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink"
              aria-label="Back to the topic"
              title="Back to the topic"
            >
              <ArrowLeft size={15} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{topic.trim()}</div>
              <div className="text-xs text-ink-3">
                {DISCUSSION_GOALS[goal].label} · check the team, then start
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={ask} disabled={propose.isPending}>
              {propose.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Propose again
            </Button>
          </div>

          <ul className="flex min-h-0 flex-col gap-2.5 overflow-y-auto px-5 py-4">
            {team.map((member, index) => (
              <li key={index} className="flex gap-3 rounded-xl border border-border p-3">
                <BotAvatar
                  avatar={{
                    shape: "circle",
                    color: member.color ?? AVATAR_COLORS[index % AVATAR_COLORS.length]!,
                  }}
                  size={32}
                  className="mt-0.5"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex gap-2">
                    <input
                      value={member.name}
                      onChange={(event) => change(index, { name: event.target.value })}
                      aria-label="Name"
                      placeholder="Name"
                      maxLength={40}
                      className={cn(field, "h-8 w-32 shrink-0 font-medium")}
                    />
                    <input
                      value={member.expertise}
                      onChange={(event) => change(index, { expertise: event.target.value })}
                      aria-label="Expertise"
                      placeholder="Expertise, e.g. Cloud cost analyst"
                      maxLength={80}
                      className={cn(field, "h-8 min-w-0 flex-1")}
                    />
                    <ModelSelect
                      value={member.model ?? null}
                      onChange={(model) => change(index, { model })}
                      label={`${member.name || "This expert"}'s model`}
                      className="h-8 w-40 shrink-0"
                    />
                  </div>
                  <textarea
                    value={member.personality}
                    onChange={(event) => change(index, { personality: event.target.value })}
                    aria-label="Personality and point of view"
                    placeholder="Personality and point of view on the topic"
                    rows={2}
                    maxLength={1500}
                    className={cn(field, "resize-none py-1.5 text-[12.5px] text-ink-2")}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setTeam(team.filter((_, i) => i !== index))}
                  disabled={team.length <= MIN_CLUSTER}
                  aria-label={`Remove ${member.name || "this expert"}`}
                  title={
                    team.length <= MIN_CLUSTER ? `A cluster needs at least ${MIN_CLUSTER} experts` : "Remove"
                  }
                  className="self-start rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-30"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
            {team.length < MAX_CLUSTER && (
              <button
                type="button"
                onClick={() =>
                  setTeam([
                    ...team,
                    {
                      name: "",
                      expertise: "",
                      personality: "",
                      color: AVATAR_COLORS[team.length % AVATAR_COLORS.length],
                    },
                  ])
                }
                className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-[13px] text-ink-2 hover:border-accent hover:text-accent"
              >
                <Plus size={14} /> Add an expert ({team.length} of {MAX_CLUSTER})
              </button>
            )}
          </ul>

          <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
            <label className="flex items-center gap-2 text-[13px]">
              Rounds
              <select
                value={rounds}
                onChange={(event) => setRounds(Number(event.target.value))}
                className="select w-16"
              >
                {Array.from({ length: MAX_DISCUSSION_ROUNDS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <span className="min-w-0 flex-1 text-xs text-ink-3">
              {problem ?? `${replies} turns and a final report.`}
            </span>
            {(create.error ?? propose.error) && (
              <span className="w-full text-xs text-danger">{(create.error ?? propose.error)!.message}</span>
            )}
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(problem) || create.isPending}
              onClick={() =>
                create.mutate(
                  {
                    topic: topic.trim(),
                    goal,
                    rounds,
                    members: team.map((member) => ({
                      ...member,
                      name: member.name.trim(),
                      expertise: member.expertise.trim(),
                      personality: member.personality.trim(),
                    })),
                  },
                  {
                    onSuccess: ({ thread }) => {
                      select(thread.id);
                      close();
                    },
                  },
                )
              }
            >
              {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Start cluster
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
