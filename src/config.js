// Central configuration for the scraper + API server.
export const VALIDATOR_HOTKEY =
  process.env.VALIDATOR_HOTKEY ||
  "5EHfTi6RWouYP7YQD5tXgm56SgeC1Wp7xS7BVG6uCRWw3fvP";

export const LEADERBOARD_URL =
  process.env.LEADERBOARD_URL ||
  `https://api.perturbai.io/api/v1/leaderboard/${VALIDATOR_HOTKEY}`;

// How often we poll the upstream API (ms). Requirement: every 15 seconds.
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15_000);

// Detail / compare views work on the most recent N scores per miner.
export const SCORE_WINDOW = Number(process.env.SCORE_WINDOW || 300);

// Retention: only keep scores for the most recent N scoring tasks.
export const MAX_TASKS = Number(process.env.MAX_TASKS || 500);

export const PORT = Number(process.env.PORT || 4000);

export const DB_PATH = process.env.DB_PATH || "data/scores.db";
