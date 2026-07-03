import { Router } from "express";
import { db } from "./db.js";
import { SCORE_WINDOW } from "./config.js";

export const router = Router();

// --- prepared queries ------------------------------------------------------

const getNetwork = db.prepare(`SELECT * FROM network WHERE id = 1`);

const getLeaderboard = db.prepare(`
  SELECT m.*, (
    SELECT COUNT(*) FROM scores s WHERE s.uid = m.uid
  ) AS score_count
  FROM miners m
  ORDER BY m.rank ASC, m.avg_score DESC
`);

const getMiner = db.prepare(`SELECT * FROM miners WHERE uid = ?`);

const getRecentScores = db.prepare(`
  SELECT task_id, score, rmse, norm, result, captured_at
  FROM scores
  WHERE uid = ?
  ORDER BY captured_at DESC
  LIMIT ?
`);

// --- helpers ---------------------------------------------------------------

function serializeMiner(m) {
  if (!m) return null;
  return {
    uid: m.uid,
    hotkey: m.hotkey,
    coldkey: m.coldkey,
    rank: m.rank,
    incentive: m.incentive,
    avgScore: m.avg_score,
    lastScore: m.last_score,
    rmse: m.rmse,
    norm: m.norm,
    result: m.result,
    imageUrl: m.image_url,
    updatedAt: m.updated_at,
    scoreCount: m.score_count,
  };
}

// Compute window stats for a chronological (oldest→newest) score list.
function computeStats(scores) {
  const n = scores.length;
  if (n === 0) {
    return {
      count: 0,
      successCount: 0,
      avgScore: 0,
      avgRmse: 0,
      avgNorm: 0,
    };
  }
  let sumScore = 0,
    sumRmse = 0,
    sumNorm = 0,
    success = 0;
  for (const s of scores) {
    sumScore += s.score ?? 0;
    sumRmse += s.rmse ?? 0;
    sumNorm += s.norm ?? 0;
    if (s.result === "Valid") success += 1;
  }
  return {
    count: n,
    successCount: success,
    avgScore: sumScore / n,
    avgRmse: sumRmse / n,
    avgNorm: sumNorm / n,
  };
}

// Returns the last SCORE_WINDOW scores for a uid, oldest→newest, with a running index.
function windowScores(uid) {
  const rows = getRecentScores.all(uid, SCORE_WINDOW); // newest first
  rows.reverse(); // oldest first for charting
  return rows.map((r, i) => ({
    no: i + 1,
    taskId: r.task_id,
    score: r.score,
    rmse: r.rmse,
    norm: r.norm,
    result: r.result,
    time: r.captured_at,
  }));
}

// --- routes ----------------------------------------------------------------

router.get("/network", (_req, res) => {
  const n = getNetwork.get();
  if (!n) return res.json(null);
  res.json({
    taskId: n.task_id,
    timestamp: n.timestamp,
    totalMiners: n.total_miners,
    availableMiners: n.available_miners,
    avgScore: n.avg_score,
    avgRmse: n.avg_rmse,
    avgNorm: n.avg_norm,
    successCount: n.success_count,
    lastWeightUpdate: n.last_weight_update,
    capturedAt: n.captured_at,
  });
});

router.get("/leaderboard", (_req, res) => {
  const miners = getLeaderboard.all().map(serializeMiner);
  res.json({ miners });
});

router.get("/miners/:uid", (req, res) => {
  const uid = Number(req.params.uid);
  if (!Number.isInteger(uid)) {
    return res.status(400).json({ error: "invalid uid" });
  }
  const miner = getMiner.get(uid);
  if (!miner) return res.status(404).json({ error: "miner not found" });

  const scores = windowScores(uid);
  res.json({
    miner: serializeMiner(miner),
    stats: computeStats(scores),
    scores,
  });
});

// Compare a base miner against 1-3 target miners.
// /api/compare?uids=56,230,45  (first uid is treated as the base)
router.get("/compare", (req, res) => {
  const uids = String(req.query.uids || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));

  const unique = [...new Set(uids)];
  if (unique.length < 2) {
    return res
      .status(400)
      .json({ error: "provide at least a base and one target uid" });
  }
  if (unique.length > 4) {
    return res.status(400).json({ error: "at most 4 miners (base + 3)" });
  }

  const miners = [];
  const perMiner = new Map(); // uid -> [{taskId, score, time}, ...] oldest first

  for (const uid of unique) {
    const m = getMiner.get(uid);
    if (!m) return res.status(404).json({ error: `miner ${uid} not found` });
    const scores = windowScores(uid);
    miners.push({
      ...serializeMiner(m),
      windowStats: computeStats(scores),
      isBase: uid === unique[0],
    });
    perMiner.set(uid, scores);
  }

  // Align rows by task_id across all miners, ordered by first-seen time.
  const order = [];
  const seen = new Set();
  const timeByTask = new Map();
  for (const uid of unique) {
    for (const s of perMiner.get(uid)) {
      if (!seen.has(s.taskId)) {
        seen.add(s.taskId);
        order.push(s.taskId);
        timeByTask.set(s.taskId, s.time);
      }
    }
  }
  order.sort((a, b) => timeByTask.get(a).localeCompare(timeByTask.get(b)));

  const scoreByTask = new Map(); // uid -> Map(taskId -> score)
  for (const uid of unique) {
    const map = new Map();
    for (const s of perMiner.get(uid)) map.set(s.taskId, s.score);
    scoreByTask.set(uid, map);
  }

  // Keep the aligned table bounded to the score window as well.
  const trimmed = order.slice(-SCORE_WINDOW);
  const rows = trimmed.map((taskId, i) => {
    const row = { no: i + 1, taskId, time: timeByTask.get(taskId) };
    for (const uid of unique) {
      row[`uid_${uid}`] = scoreByTask.get(uid).get(taskId) ?? null;
    }
    return row;
  });

  res.json({ base: unique[0], uids: unique, miners, rows });
});
