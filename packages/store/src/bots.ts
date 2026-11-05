import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  Bot,
  BotTools,
  compareBots,
  DEFAULT_BOT_TOOLS,
  newId,
  restrictsTools,
  type Avatar,
  type CreateBotInput,
  type UpdateBotInput,
} from "@mrog/shared";

import { transaction, type Db } from "./db";
import { deleteSummaries } from "./settings";

type Row = Record<string, unknown>;

const SELECT_BOTS = `
  SELECT b.*, (
    SELECT tm.thread_id FROM thread_members tm JOIN threads t ON t.id = tm.thread_id
    WHERE tm.bot_id = b.id AND t.kind = 'direct'
  ) AS thread_id
  FROM bots b`;

/** The saved tool lists. A value that doesn't read (hand-edited, from a newer version) means "no restriction", not an error that hides every bot. */
function readTools(value: unknown): BotTools {
  if (typeof value !== "string" || !value) return DEFAULT_BOT_TOOLS;
  try {
    const parsed = BotTools.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : DEFAULT_BOT_TOOLS;
  } catch {
    return DEFAULT_BOT_TOOLS;
  }
}

/** Saved as NULL when there's nothing to restrict, so bots without a list keep a row exactly as before. */
const writeTools = (tools: BotTools) => (restrictsTools(tools) ? JSON.stringify(tools) : null);

function toBot(row: Row): Bot {
  return Bot.parse({
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    avatar: {
      shape: row.avatar_shape,
      color: row.avatar_color,
      ...(row.avatar_image ? { image: row.avatar_image } : {}),
    },
    isPrimary: row.is_primary === 1,
    pinned: row.pinned === 1,
    hidden: row.hidden === 1,
    model: row.model ?? null,
    instructions: row.instructions ?? "",
    section: row.section ?? null,
    notifications: row.notifications !== 0,
    coordinator: row.coordinator === 1,
    parentId: row.parent_id ?? null,
    temporary: row.temporary === 1,
    visual: row.visual === 1,
    clusterId: row.cluster_id ?? null,
    tools: readTools(row.tools),
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

const pick = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;

function randomAvatar(): Avatar {
  return { shape: pick(AVATAR_SHAPES), color: pick(AVATAR_COLORS) };
}

export class BotRepo {
  constructor(private readonly db: Db) {}

  list(): Bot[] {
    return this.db.prepare(SELECT_BOTS).all().map(toBot).toSorted(compareBots);
  }

  get(id: string): Bot | null {
    const row = this.db.prepare(`${SELECT_BOTS} WHERE b.id = ?`).get(id);
    return row ? toBot(row) : null;
  }

  /**
   * Creates the bot and its one-to-one thread. `helper` marks a bot a coordinator made for a task; `clusterId` a
   * bot made for a cluster's discussion.
   */
  create(
    input: CreateBotInput,
    helper?: { parentId: string; temporary: boolean; section: string },
    clusterId?: string,
  ): Bot {
    const now = new Date().toISOString();
    const avatar = input.avatar ?? randomAvatar();
    const id = newId("bot");
    const threadId = newId("thr");
    return transaction(this.db, () => {
      if (input.isPrimary) this.db.prepare("UPDATE bots SET is_primary = 0 WHERE is_primary = 1").run();
      this.db
        .prepare(
          `INSERT INTO bots (id, name, label, avatar_shape, avatar_color, avatar_image, is_primary, model,
             instructions, coordinator, parent_id, temporary, section, visual, cluster_id, tools, created_at,
             updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.label ?? null,
          avatar.shape,
          avatar.color,
          avatar.image ?? null,
          input.isPrimary ? 1 : 0,
          input.model ?? null,
          input.instructions ?? "",
          input.coordinator && !helper ? 1 : 0,
          helper?.parentId ?? null,
          helper?.temporary ? 1 : 0,
          helper?.section ?? null,
          input.visual ? 1 : 0,
          clusterId ?? null,
          writeTools(input.tools ?? DEFAULT_BOT_TOOLS),
          now,
          now,
        );
      this.db
        .prepare(
          "INSERT INTO threads (id, kind, title, created_at, updated_at) VALUES (?, 'direct', NULL, ?, ?)",
        )
        .run(threadId, now, now);
      this.db.prepare("INSERT INTO thread_members (thread_id, bot_id) VALUES (?, ?)").run(threadId, id);
      return this.get(id)!;
    });
  }

  /** Returns the updated bot, or null when no bot has this id. */
  update(id: string, patch: UpdateBotInput): Bot | null {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return null;
      if (patch.isPrimary) this.db.prepare("UPDATE bots SET is_primary = 0 WHERE is_primary = 1").run();
      const next = { ...current, ...patch, avatar: patch.avatar ?? current.avatar };
      this.db
        .prepare(
          `UPDATE bots SET name = ?, label = ?, avatar_shape = ?, avatar_color = ?, avatar_image = ?, is_primary = ?,
             pinned = ?, hidden = ?, model = ?, instructions = ?, section = ?, notifications = ?, coordinator = ?,
             tools = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.name,
          next.label,
          next.avatar.shape,
          next.avatar.color,
          next.avatar.image ?? null,
          next.isPrimary ? 1 : 0,
          next.pinned ? 1 : 0,
          next.hidden ? 1 : 0,
          next.model,
          next.instructions,
          next.section,
          next.notifications ? 1 : 0,
          // Helpers never coordinate: that is what keeps delegation one level deep.
          next.coordinator && next.parentId === null ? 1 : 0,
          writeTools(next.tools),
          new Date().toISOString(),
          id,
        );
      return this.get(id);
    });
  }

  /** Deletes the bot and its one-to-one thread (with its messages and cached summaries). */
  delete(id: string): boolean {
    return transaction(this.db, () => {
      const bot = this.get(id);
      if (!bot) return false;
      this.db.prepare("DELETE FROM threads WHERE id = ?").run(bot.threadId);
      this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
      deleteSummaries(this.db, { threadId: bot.threadId });
      deleteSummaries(this.db, { botId: id });
      return true;
    });
  }
}
