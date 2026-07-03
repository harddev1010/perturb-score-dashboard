import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, MAX_TASKS } from "./config.js";

// Ensure the data directory exists before opening the DB file.
const dir = path.dirname(DB_PATH);
if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  -- One row per (miner, scoring task). task_id is the natural dedup key:
  -- polling every 15s re-sends the same task until a new round starts, so
  -- INSERT OR IGNORE keeps exactly one score per task per miner.
  CREATE TABLE IF NOT EXISTS scores (
    uid         INTEGER NOT NULL,
    task_id     TEXT    NOT NULL,
    score       REAL,
    rmse        REAL,
    norm        REAL,
    result      TEXT,
    captured_at TEXT    NOT NULL,
    PRIMARY KEY (uid, task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_scores_uid_time
    ON scores (uid, captured_at DESC);

  -- Latest known snapshot per miner (drives the dashboard ranking).
  CREATE TABLE IF NOT EXISTS miners (
    uid        INTEGER PRIMARY KEY,
    hotkey     TEXT,
    coldkey    TEXT,
    rank       INTEGER,
    incentive  REAL,
    avg_score  REAL,
    last_score REAL,
    rmse       REAL,
    norm       REAL,
    result     TEXT,
    image_url  TEXT,
    updated_at TEXT
  );

  -- Single-row network summary from the most recent poll.
  CREATE TABLE IF NOT EXISTS network (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    task_id            TEXT,
    timestamp          TEXT,
    total_miners       INTEGER,
    available_miners   INTEGER,
    avg_score          REAL,
    avg_rmse           REAL,
    avg_norm           REAL,
    success_count      INTEGER,
    last_weight_update TEXT,
    captured_at        TEXT
  );
`);

// Prepared statements -------------------------------------------------------

const insertScoreStmt = db.prepare(`
  INSERT OR IGNORE INTO scores (uid, task_id, score, rmse, norm, result, captured_at)
  VALUES (@uid, @task_id, @score, @rmse, @norm, @result, @captured_at)
`);

const upsertMinerStmt = db.prepare(`
  INSERT INTO miners (uid, hotkey, coldkey, rank, incentive, avg_score,
                      last_score, rmse, norm, result, image_url, updated_at)
  VALUES (@uid, @hotkey, @coldkey, @rank, @incentive, @avg_score,
          @last_score, @rmse, @norm, @result, @image_url, @updated_at)
  ON CONFLICT(uid) DO UPDATE SET
    hotkey=@hotkey, coldkey=@coldkey, rank=@rank, incentive=@incentive,
    avg_score=@avg_score, last_score=@last_score, rmse=@rmse, norm=@norm,
    result=@result, image_url=@image_url, updated_at=@updated_at
`);

const upsertNetworkStmt = db.prepare(`
  INSERT INTO network (id, task_id, timestamp, total_miners, available_miners,
                       avg_score, avg_rmse, avg_norm, success_count,
                       last_weight_update, captured_at)
  VALUES (1, @task_id, @timestamp, @total_miners, @available_miners,
          @avg_score, @avg_rmse, @avg_norm, @success_count,
          @last_weight_update, @captured_at)
  ON CONFLICT(id) DO UPDATE SET
    task_id=@task_id, timestamp=@timestamp, total_miners=@total_miners,
    available_miners=@available_miners, avg_score=@avg_score,
    avg_rmse=@avg_rmse, avg_norm=@avg_norm, success_count=@success_count,
    last_weight_update=@last_weight_update, captured_at=@captured_at
`);

// Drop scores for tasks older than the most recent MAX_TASKS distinct tasks.
// (All rows of a task share the same captured_at, so MAX == first-seen time.)
const pruneStmt = db.prepare(`
  DELETE FROM scores
  WHERE task_id NOT IN (
    SELECT task_id FROM scores
    GROUP BY task_id
    ORDER BY MAX(captured_at) DESC
    LIMIT @keep
  )
`);

export function pruneOldTasks(keep = MAX_TASKS) {
  return pruneStmt.run({ keep }).changes;
}

// Persist one full poll atomically. Returns number of new score rows inserted.
export const persistSnapshot = db.transaction((snapshot) => {
  const { network, miners, capturedAt } = snapshot;
  let inserted = 0;

  upsertNetworkStmt.run({
    task_id: network.taskId,
    timestamp: network.timestamp,
    total_miners: network.totalMiners,
    available_miners: network.availableMiners,
    avg_score: network.avgScore,
    avg_rmse: network.avgRmse,
    avg_norm: network.avgNorm,
    success_count: network.successCount,
    last_weight_update: network.lastWeightUpdate,
    captured_at: capturedAt,
  });

  for (const m of miners) {
    upsertMinerStmt.run({
      uid: m.uid,
      hotkey: m.hotkey,
      coldkey: m.coldkey,
      rank: m.rank,
      incentive: m.incentive,
      avg_score: m.avgScore,
      last_score: m.lastScore,
      rmse: m.rmse,
      norm: m.norm,
      result: m.result,
      image_url: m.imageUrl,
      updated_at: capturedAt,
    });

    const res = insertScoreStmt.run({
      uid: m.uid,
      task_id: network.taskId,
      score: m.lastScore,
      rmse: m.rmse,
      norm: m.norm,
      result: m.result,
      captured_at: capturedAt,
    });
    inserted += res.changes;
  }

  return inserted;
});
