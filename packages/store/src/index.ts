import { BotRepo } from "./bots";
import { openDatabase, type Db } from "./db";
import { LibraryRepo } from "./library";
import { MemoryRepo, SkillRepo } from "./memory";
import { RoutineRepo } from "./routines";
import { SettingsRepo } from "./settings";
import { MessageRepo, ThreadRepo } from "./threads";

export { BotRepo } from "./bots";
export { migrate, openDatabase, transaction, type Db } from "./db";
export { LibraryRepo } from "./library";
export { MemoryRepo, SkillRepo } from "./memory";
export { MIGRATIONS, type Migration } from "./migrations";
export { RoutineRepo } from "./routines";
export { SettingsRepo } from "./settings";
export { MessageRepo, ThreadRepo, type NewMessage } from "./threads";

export interface Store {
  db: Db;
  bots: BotRepo;
  threads: ThreadRepo;
  messages: MessageRepo;
  memory: MemoryRepo;
  skills: SkillRepo;
  library: LibraryRepo;
  routines: RoutineRepo;
  settings: SettingsRepo;
  close(): void;
}

export function openStore(path: string): Store {
  const db = openDatabase(path);
  return {
    db,
    bots: new BotRepo(db),
    threads: new ThreadRepo(db),
    messages: new MessageRepo(db),
    memory: new MemoryRepo(db),
    skills: new SkillRepo(db),
    library: new LibraryRepo(db),
    routines: new RoutineRepo(db),
    settings: new SettingsRepo(db),
    close: () => db.close(),
  };
}
