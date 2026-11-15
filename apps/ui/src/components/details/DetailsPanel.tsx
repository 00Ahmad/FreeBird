import { Download, FileText, Pencil, Plus, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { MAX_GROUP_MEMBERS, type Bot, type Thread } from "@mrog/shared";
import { BotAvatar, Button, cn, IconButton } from "@mrog/ui-kit";

import { useBots, useDeleteBot, useUpdateBot } from "../../hooks/bots";
import { formatBytes } from "../../hooks/runtime";
import {
  useBotFiles,
  useDeleteGroup,
  useMemory,
  useMemoryActions,
  useSkillActions,
  useSkills,
  useUpdateGroup,
} from "../../hooks/team";
import { useThreads } from "../../hooks/threads";
import { botActions, isTeamThread } from "../../lib/codingTeam";
import { chatFor } from "../../lib/groups";
import { exportTemplate } from "../../lib/templates";
import { useUi } from "../../state";
import { ModelMenu } from "../chat/ModelMenu";
import { groupTitle } from "../Sidebar";
import { BotRoutines } from "../routines/BotRoutines";
import { ToolsBlock } from "./ToolsBlock";

/** Single-column details pane. */
export function DetailsPanel({ thread }: { thread: Thread }) {
  const { data: bots } = useBots();
  const setPanel = useUi((state) => state.setPanel);
  const bot =
    thread.kind === "direct" ? bots?.find((candidate) => candidate.id === thread.memberIds[0]) : undefined;
  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-surface"
      aria-label="Details"
    >
      <div className="flex items-center border-b border-border px-4 py-3">
        <h2 className="flex-1 text-[14px] font-semibold">Details</h2>
        <IconButton label="Close details" onClick={() => setPanel("details")}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {bot ? <BotDetails bot={bot} /> : <GroupDetails thread={thread} bots={bots ?? []} />}
      </div>
    </aside>
  );
}

function Block({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3.5">
      <div className="mb-2 flex items-center">
        <h3 className="flex-1 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function InlineText(props: {
  value: string;
  placeholder: string;
  onSave(value: string): void;
  multiline?: boolean;
  className?: string;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const save = () => {
    if (draft !== null && draft.trim() !== props.value) props.onSave(draft.trim());
    setDraft(null);
  };
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setDraft(props.value)}
        aria-label={`Edit ${props.label}`}
        className={cn(
          "w-full rounded-md px-1.5 py-1 text-left hover:bg-hover",
          props.className,
          !props.value && "text-ink-3",
        )}
      >
        <span className={cn(props.multiline && "whitespace-pre-wrap")}>
          {props.value || props.placeholder}
        </span>
      </button>
    );
  }
  const common = {
    value: draft,
    autoFocus: true,
    "aria-label": props.label,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: save,
    className: cn("w-full rounded-md border border-accent bg-bg px-1.5 py-1 outline-none", props.className),
  };
  return props.multiline ? (
    <textarea {...common} rows={6} onKeyDown={(event) => event.key === "Escape" && setDraft(null)} />
  ) : (
    <input
      {...common}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}

function BotDetails({ bot }: { bot: Bot }) {
  const update = useUpdateBot();
  const setOverlay = useUi((state) => state.setOverlay);
  const { data: skills } = useSkills(bot.id);
  const { data: bots } = useBots();
  // A Coding Bot's role is named after its team.
  const canRename = botActions(bot, bots ?? []).rename;
  const patch = (value: Parameters<typeof update.mutate>[0]["patch"]) =>
    update.mutate({ id: bot.id, patch: value });

  return (
    <>
      <div className="flex flex-col items-center gap-2 border-b border-border px-4 py-5">
        <button
          type="button"
          onClick={() => setOverlay({ avatarFor: bot.id })}
          aria-label="Edit picture"
          className="group relative rounded-[30%]"
        >
          <BotAvatar avatar={bot.avatar} size={72} />
          <span className="absolute right-0 bottom-0 rounded-full bg-surface p-1 shadow-pop group-hover:bg-hover">
            <Pencil size={11} />
          </span>
        </button>
        {canRename ? (
          <InlineText
            label="name"
            value={bot.name}
            placeholder="Name"
            onSave={(name) => name && patch({ name })}
            className="text-center text-[15px] font-semibold"
          />
        ) : (
          <p className="px-1.5 py-1 text-center text-[15px] font-semibold">{bot.name}</p>
        )}
        <InlineText
          label="label"
          value={bot.label ?? ""}
          placeholder="Add a label"
          onSave={(label) => patch({ label: label || null })}
          className="text-center text-[12.5px] text-ink-2"
        />
        <ModelMenu bot={bot} />
      </div>

      <Block title="About">
        <InlineText
          label="instructions"
          multiline
          value={bot.instructions}
          placeholder="What this bot does, where to look, and when to check with you. You can also just tell it in chat."
          onSave={(instructions) => patch({ instructions })}
          className="text-[13px]"
        />
      </Block>

      <Block title="Notifications">
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={bot.notifications}
            onChange={(event) => patch({ notifications: event.target.checked })}
          />
          Notify me when {bot.name} replies while I'm elsewhere
        </label>
      </Block>

      <TeamBlock bot={bot} />

      <ToolsBlock bot={bot} />

      <MemoryBlock bot={bot} />
      <SkillsBlock bot={bot} />
      <BotRoutines bot={bot} />
      <FilesBlock bot={bot} />

      <Block title="Share">
        <Button size="sm" onClick={() => exportTemplate(bot, skills ?? [])}>
          <Download size={13} /> Share as template
        </Button>
        <p className="mt-1.5 text-[11.5px] text-ink-3">
          Saves a file with the profile, instructions and skills. No chats, memory or keys.
        </p>
      </Block>
    </>
  );
}

/** Coordinator role and helpers: who can create helper bots and hand out work. */
function TeamBlock({ bot }: { bot: Bot }) {
  const { data: bots } = useBots();
  const { data: threads } = useThreads();
  const update = useUpdateBot();
  const remove = useDeleteBot();
  const select = useUi((state) => state.select);
  const parent = bot.parentId ? bots?.find((candidate) => candidate.id === bot.parentId) : undefined;
  const helpers = (bots ?? []).filter((candidate) => candidate.parentId === bot.id);

  if (bot.parentId) {
    const role = parent?.coding === true || parent?.job === true || parent?.client === true;
    return (
      <Block title="Team">
        <p className="text-[13px] text-ink-2">
          {role ? "Part of the team of " : "Helper of "}
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => parent && select(parent.threadId)}
          >
            {parent?.name ?? "a coordinator"}
          </button>
          {role
            ? `. It is made and deleted with its ${parent?.job ? "Job Bot" : parent?.client ? "Client Bot" : "Coding Bot"}.`
            : bot.temporary
              ? ". Made for a task; it can't hand work to other bots."
              : "."}
        </p>
        {/* A Coding Bot's role can't be dismissed on its own: the team needs all three. */}
        {!role && (
          <Button
            size="sm"
            variant="danger"
            className="mt-2"
            onClick={() =>
              window.confirm(`Dismiss ${bot.name}? Its chats are deleted.`) && remove.mutate(bot.id)
            }
          >
            <Trash2 size={13} /> Dismiss helper
          </Button>
        )}
      </Block>
    );
  }

  return (
    <Block title="Team">
      {bot.isPrimary ? (
        <p className="text-[13px] text-ink-2">
          As your Primary Bot, {bot.name} coordinates: it can create helper bots and give several bots tasks
          at once.
        </p>
      ) : (
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={bot.coordinator}
            onChange={(event) => update.mutate({ id: bot.id, patch: { coordinator: event.target.checked } })}
          />
          <span>
            Coordinator
            <span className="block text-[12px] text-ink-3">
              Can create helper bots and give several bots tasks at once.
            </span>
          </span>
        </label>
      )}
      {helpers.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {helpers.map((helper) => (
            <li key={helper.id} className="flex items-center gap-2 text-[13px]">
              <BotAvatar avatar={helper.avatar} size={18} />
              <button
                type="button"
                onClick={() => select(chatFor(helper, threads ?? []))}
                className="min-w-0 flex-1 truncate text-left hover:underline"
              >
                {helper.name}
              </button>
              {helper.hidden && <span className="text-[11px] text-ink-3">idle</span>}
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function MemoryBlock({ bot }: { bot: Bot }) {
  const { data: notes } = useMemory(bot.id);
  const { add, update, remove, importText } = useMemoryActions(bot.id);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [importing, setImporting] = useState<string | null>(null);

  return (
    <Block
      title={`Memory${notes?.length ? ` · ${notes.length}` : ""}`}
      action={
        <IconButton label="Add memory" onClick={() => setAdding(true)}>
          <Plus size={14} />
        </IconButton>
      }
    >
      {notes?.length === 0 && !adding && (
        <p className="text-[12.5px] text-ink-3">
          Nothing yet. Bots save notes when you ask them to remember something.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {notes?.map((note) => (
          <li key={note.id} className="group flex items-start gap-1 text-[13px]">
            <div className="min-w-0 flex-1">
              <InlineText
                label="memory note"
                value={note.text}
                placeholder=""
                multiline
                onSave={(value) =>
                  value ? update.mutate({ id: note.id, text: value }) : remove.mutate(note.id)
                }
              />
            </div>
            <IconButton
              label="Delete note"
              className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
              onClick={() => remove.mutate(note.id)}
            >
              <Trash2 size={12} />
            </IconButton>
          </li>
        ))}
      </ul>
      {adding && (
        <form
          className="mt-1.5 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) add.mutate(text.trim(), { onSuccess: () => (setText(""), setAdding(false)) });
          }}
        >
          <input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Something to remember"
            aria-label="New memory"
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2 text-[13px] outline-none focus:border-accent"
          />
          <Button size="sm" type="submit" variant="primary">
            Add
          </Button>
        </form>
      )}
      {importing === null ? (
        <button
          type="button"
          onClick={() => setImporting("")}
          className="mt-2 text-[12px] text-accent hover:underline"
        >
          Import from another assistant…
        </button>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          <textarea
            value={importing}
            onChange={(event) => setImporting(event.target.value)}
            rows={5}
            placeholder="Paste what your other assistant remembers about you, one item per line."
            aria-label="Memory to import"
            className="rounded-lg border border-border bg-bg px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="primary"
              disabled={!importing.trim()}
              onClick={() => importText.mutate(importing, { onSuccess: () => setImporting(null) })}
            >
              Add to Memory
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setImporting(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Block>
  );
}

function SkillsBlock({ bot }: { bot: Bot }) {
  const { data: skills } = useSkills(bot.id);
  const { add, remove } = useSkillActions();
  const [form, setForm] = useState<{ name: string; prompt: string } | null>(null);
  return (
    <Block
      title="Skills"
      action={
        <IconButton label="Add skill" onClick={() => setForm({ name: "", prompt: "" })}>
          <Plus size={14} />
        </IconButton>
      }
    >
      {skills?.length === 0 && !form && (
        <p className="text-[12.5px] text-ink-3">
          Save prompts you reuse, then type / in the chat to run one.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {skills?.map((skill) => (
          <li key={skill.id} className="group flex items-center gap-2 text-[13px]">
            <span className="font-mono text-[12px] text-accent">/{skill.name}</span>
            <span className="min-w-0 flex-1 truncate text-ink-3">
              {skill.botId ? skill.prompt : `(all bots) ${skill.prompt}`}
            </span>
            <IconButton
              label={`Delete ${skill.name}`}
              className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
              onClick={() => remove.mutate(skill.id)}
            >
              <Trash2 size={12} />
            </IconButton>
          </li>
        ))}
      </ul>
      {form && (
        <form
          className="mt-2 flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(
              { botId: bot.id, name: form.name.trim(), prompt: form.prompt.trim() },
              { onSuccess: () => setForm(null) },
            );
          }}
        >
          <input
            autoFocus
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="name (e.g. standup)"
            aria-label="Skill name"
            className="h-8 rounded-lg border border-border bg-bg px-2 font-mono text-[12.5px] outline-none focus:border-accent"
          />
          <textarea
            value={form.prompt}
            onChange={(event) => setForm({ ...form, prompt: event.target.value })}
            rows={3}
            placeholder="The prompt this skill sends"
            aria-label="Skill prompt"
            className="rounded-lg border border-border bg-bg px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
          />
          {add.error && <p className="text-xs text-danger">{add.error.message}</p>}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              type="submit"
              variant="primary"
              disabled={!form.name.trim() || !form.prompt.trim()}
            >
              Save skill
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Block>
  );
}

function FilesBlock({ bot }: { bot: Bot }) {
  const { data } = useBotFiles(bot.id);
  return (
    <Block title={`Files${data?.files.length ? ` · ${data.files.length}` : ""}`}>
      {data?.files.length ? (
        <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {data.files.map((file) => (
            <li key={file.path} className="flex items-center gap-2 text-[12.5px]" title={file.modifiedAt}>
              <FileText size={12} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              <span className="text-ink-3">{formatBytes(file.size)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">The bot's folder is empty.</p>
      )}
      {data?.root && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-ink-3 select-text" title={data.root}>
          {data.root}
        </p>
      )}
    </Block>
  );
}

function GroupDetails({ thread, bots }: { thread: Thread; bots: Bot[] }) {
  const update = useUpdateGroup();
  const remove = useDeleteGroup();
  const select = useUi((state) => state.select);
  const members = useMemo(
    () => thread.memberIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []),
    [thread, bots],
  );
  const others = bots.filter((bot) => !thread.memberIds.includes(bot.id) && !bot.hidden && !bot.clusterId);
  const setMembers = (memberIds: string[]) => update.mutate({ id: thread.id, patch: { memberIds } });

  // A Coding Bot's conversation with one of its roles belongs to the team: it can be read, not renamed or changed.
  if (isTeamThread(thread, bots)) {
    return (
      <>
        <div className="border-b border-border px-4 py-4">
          <p className="px-1.5 text-[15px] font-semibold">
            {groupTitle(thread, new Map(bots.map((b) => [b.id, b])))}
          </p>
        </div>
        <Block title={`Members · ${members.length}`}>
          <ul className="flex flex-col gap-1">
            {members.map((bot) => (
              <li key={bot.id} className="flex items-center gap-2 text-[13px]">
                <BotAvatar avatar={bot.avatar} size={22} />
                <span className="flex-1 truncate">{bot.name}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-ink-3">
            A team bot (a Coding Bot, a Job Bot or a Client Bot) and one of its roles work here. It goes when
            that bot is deleted.
          </p>
        </Block>
      </>
    );
  }

  return (
    <>
      <div className="border-b border-border px-4 py-4">
        <InlineText
          label="group name"
          value={thread.title ?? ""}
          placeholder="Name this group"
          onSave={(title) => update.mutate({ id: thread.id, patch: { title: title || null } })}
          className="text-[15px] font-semibold"
        />
      </div>
      <Block title={`Members · ${members.length}`}>
        <ul className="flex flex-col gap-1">
          {members.map((bot) => (
            <li key={bot.id} className="flex items-center gap-2 text-[13px]">
              <BotAvatar avatar={bot.avatar} size={22} />
              <span className="flex-1 truncate">{bot.name}</span>
              <IconButton
                label={`Remove ${bot.name}`}
                className="size-6"
                disabled={members.length <= 2}
                onClick={() => setMembers(thread.memberIds.filter((id) => id !== bot.id))}
              >
                <UserMinus size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
        {members.length < MAX_GROUP_MEMBERS && others.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {others.map((bot) => (
              <Button
                key={bot.id}
                size="sm"
                variant="ghost"
                onClick={() => setMembers([...thread.memberIds, bot.id])}
              >
                <UserPlus size={12} /> {bot.name}
              </Button>
            ))}
          </div>
        )}
        {update.error && <p className="mt-1 text-xs text-danger">{update.error.message}</p>}
      </Block>
      <Block title="Danger zone">
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            if (window.confirm("Delete this group chat and its messages?")) {
              remove.mutate(thread.id, { onSuccess: () => select(null) });
            }
          }}
        >
          <Trash2 size={13} /> Delete group chat
        </Button>
      </Block>
    </>
  );
}
