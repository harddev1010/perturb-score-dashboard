import { LEADERBOARD_URL, POLL_INTERVAL_MS, MAX_TASKS } from "./config.js";
import { persistSnapshot, pruneOldTasks } from "./db.js";

let timer = null;
let lastTaskId = null;

async function pollOnce() {
  const capturedAt = new Date().toISOString();
  let res;
  try {
    res = await fetch(LEADERBOARD_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(`[poller] fetch failed: ${err.message}`);
    return;
  }

  if (!res.ok) {
    console.error(`[poller] upstream returned HTTP ${res.status}`);
    return;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error(`[poller] invalid JSON: ${err.message}`);
    return;
  }

  if (!data || !Array.isArray(data.miners)) {
    console.error("[poller] unexpected payload shape");
    return;
  }

  const snapshot = {
    capturedAt,
    network: {
      taskId: data.taskId,
      timestamp: data.timestamp,
      totalMiners: data.network?.totalMiners ?? null,
      availableMiners: data.network?.availableMiners ?? null,
      avgScore: data.network?.avgScore ?? null,
      avgRmse: data.network?.avgRmse ?? null,
      avgNorm: data.network?.avgNorm ?? null,
      successCount: data.network?.successCount ?? null,
      lastWeightUpdate: data.lastWeightUpdate ?? null,
    },
    miners: data.miners,
  };

  const inserted = persistSnapshot(snapshot);
  const isNewTask = data.taskId !== lastTaskId;
  lastTaskId = data.taskId;

  if (inserted > 0) {
    // Only new tasks add rows, so prune retention window on those polls.
    const removed = pruneOldTasks();
    console.log(
      `[poller] task ${data.taskId} — ${inserted} new score rows ` +
        `(${data.miners.length} miners)` +
        (removed ? `, pruned ${removed} old rows (keep ${MAX_TASKS} tasks)` : "") +
        ` @ ${capturedAt}`
    );
  } else if (isNewTask) {
    console.log(`[poller] task ${data.taskId} — no new rows @ ${capturedAt}`);
  }
}

export function startPoller() {
  // Fire immediately, then on the fixed interval.
  pollOnce();
  timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  console.log(`[poller] polling every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopPoller() {
  if (timer) clearInterval(timer);
}
