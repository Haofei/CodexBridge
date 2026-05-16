import fs from "node:fs/promises";

export async function createThreadStore({ stateFile, codex }) {
  const inMemoryThreads = new Map();
  const persistedThreadIds = await loadThreadState(stateFile);
  const saveQueue = createSaveQueue();

  async function getOrCreateThread(sessionId, threadOptions) {
    const cached = inMemoryThreads.get(sessionId);
    if (cached) return cached;

    const persistedId = persistedThreadIds.get(sessionId);
    let thread;
    if (persistedId) {
      try {
        thread = codex.resumeThread(persistedId, threadOptions);
        inMemoryThreads.set(sessionId, { thread });
        return { thread };
      } catch (error) {
        console.warn(
          `Failed to resume thread ${persistedId} for session ${sessionId}:`,
          error?.message ?? error,
        );
      }
    }

    thread = codex.startThread(threadOptions);
    inMemoryThreads.set(sessionId, { thread });
    return { thread };
  }

  async function persistThreadIdIfNeeded(sessionId, thread) {
    if (!thread?.id) return;
    if (persistedThreadIds.get(sessionId) === thread.id) return;
    persistedThreadIds.set(sessionId, thread.id);
    await saveQueue(async () => saveThreadState(stateFile, persistedThreadIds));
  }

  return {
    getOrCreateThread,
    persistThreadIdIfNeeded,
    getPersistedSessionCount: () => persistedThreadIds.size,
    getCachedThreadCount: () => inMemoryThreads.size,
  };
}

export async function loadThreadState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Object.entries(parsed.sessions ?? {});
    return new Map(entries);
  } catch {
    return new Map();
  }
}

export async function saveThreadState(stateFile, map) {
  const payload = {
    sessions: Object.fromEntries(map.entries()),
  };
  await fs.writeFile(stateFile, JSON.stringify(payload, null, 2), "utf8");
}

export function createSaveQueue() {
  let last = Promise.resolve();
  return (task) => {
    last = last.then(() => task()).catch((err) => {
      console.error("Failed to persist thread IDs:", err);
    });
    return last;
  };
}
