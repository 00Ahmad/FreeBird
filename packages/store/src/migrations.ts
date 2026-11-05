/** Append-only: never edit a shipped migration, add a new one. */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
      CREATE TABLE bots (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        label        TEXT,
        avatar_shape TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        is_primary   INTEGER NOT NULL DEFAULT 0,
        pinned       INTEGER NOT NULL DEFAULT 0,
        hidden       INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX bots_one_primary ON bots (is_primary) WHERE is_primary = 1;

      CREATE TABLE threads (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
        title      TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE thread_members (
        thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
        bot_id    TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
        PRIMARY KEY (thread_id, bot_id)
      );

      CREATE TABLE messages (
        id         TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('user', 'bot', 'system')),
        bot_id     TEXT REFERENCES bots (id) ON DELETE SET NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX messages_by_thread ON messages (thread_id, created_at);

      CREATE TABLE events (
        id         TEXT PRIMARY KEY,
        thread_id  TEXT REFERENCES threads (id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX events_by_thread ON events (thread_id, created_at);

      CREATE TABLE routines (
        id         TEXT PRIMARY KEY,
        bot_id     TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        trigger    TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: "chat",
    sql: `
      ALTER TABLE bots ADD COLUMN model TEXT;
      ALTER TABLE bots ADD COLUMN instructions TEXT NOT NULL DEFAULT '';

      ALTER TABLE messages ADD COLUMN parts TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
      ALTER TABLE messages ADD COLUMN model TEXT;
      ALTER TABLE messages ADD COLUMN usage TEXT;
      ALTER TABLE messages ADD COLUMN reply_to_id TEXT;

      -- Every bot gets its one-to-one thread.
      CREATE TEMP TABLE direct_threads AS
        SELECT id AS bot_id, 'thr_' || lower(hex(randomblob(16))) AS thread_id, created_at FROM bots;
      INSERT INTO threads (id, kind, title, created_at, updated_at)
        SELECT thread_id, 'direct', NULL, created_at, created_at FROM direct_threads;
      INSERT INTO thread_members (thread_id, bot_id) SELECT thread_id, bot_id FROM direct_threads;
      DROP TABLE direct_threads;
    `,
  },
  {
    id: 3,
    name: "team",
    sql: `
      ALTER TABLE bots ADD COLUMN section TEXT;
      ALTER TABLE bots ADD COLUMN notifications INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE bots ADD COLUMN avatar_image TEXT;
      ALTER TABLE messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE memories (
        id         TEXT PRIMARY KEY,
        bot_id     TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
        text       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memories_by_bot ON memories (bot_id, created_at);

      CREATE TABLE skills (
        id         TEXT PRIMARY KEY,
        bot_id     TEXT REFERENCES bots (id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        prompt     TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 4,
    name: "routines",
    sql: `
      ALTER TABLE routines ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
      ALTER TABLE routines ADD COLUMN last_run_at TEXT;
      ALTER TABLE routines ADD COLUMN last_status TEXT;
      ALTER TABLE routines ADD COLUMN next_run_at TEXT;
      ALTER TABLE routines ADD COLUMN webhook_secret TEXT;
      CREATE INDEX routines_due ON routines (enabled, next_run_at);
    `,
  },
  {
    id: 5,
    name: "helpers",
    sql: `
      ALTER TABLE bots ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE bots ADD COLUMN parent_id TEXT REFERENCES bots (id) ON DELETE SET NULL;
      ALTER TABLE bots ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 6,
    name: "library",
    sql: `
      CREATE TABLE library_items (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        text       TEXT NOT NULL,
        bot_name   TEXT,
        thread_id  TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX library_by_time ON library_items (created_at);
    `,
  },
  {
    id: 7,
    name: "visual-bots",
    sql: `ALTER TABLE bots ADD COLUMN visual INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    id: 8,
    name: "clusters",
    sql: `
      ALTER TABLE bots ADD COLUMN cluster_id TEXT;
      ALTER TABLE threads ADD COLUMN cluster INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 9,
    name: "races",
    sql: `ALTER TABLE threads ADD COLUMN race INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    id: 10,
    name: "pair-threads",
    sql: `
      ALTER TABLE threads ADD COLUMN pair INTEGER NOT NULL DEFAULT 0;
      -- Bot-to-bot threads made before the flag: two members and the "A ↔ B" title the app gave them.
      UPDATE threads SET pair = 1
        WHERE kind = 'group' AND cluster = 0 AND race = 0 AND title LIKE '% ↔ %'
          AND (SELECT COUNT(*) FROM thread_members tm WHERE tm.thread_id = threads.id) = 2;
    `,
  },
  {
    id: 11,
    name: "tidy",
    sql: `
      CREATE INDEX thread_members_by_bot ON thread_members (bot_id);
      -- Never read: message text lives in parts, and events are replayed from memory.
      ALTER TABLE messages DROP COLUMN content;
      DROP INDEX events_by_thread;
      DROP TABLE events;
    `,
  },
  {
    id: 12,
    name: "moderator-messages",
    sql: `
      ALTER TABLE messages ADD COLUMN moderator INTEGER NOT NULL DEFAULT 0;
      -- Until now a bot message without a bot in a cluster was the moderator's summary.
      UPDATE messages SET moderator = 1
        WHERE role = 'bot' AND bot_id IS NULL AND thread_id IN (SELECT id FROM threads WHERE cluster = 1);
    `,
  },
  {
    id: 13,
    name: "bot-tools",
    // JSON {"allow": [...] | null, "exclude": [...]}; NULL = no restriction, which is every bot made before this.
    sql: `ALTER TABLE bots ADD COLUMN tools TEXT;`,
  },
];
