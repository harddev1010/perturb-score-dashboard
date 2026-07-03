import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PORT } from "./config.js";
import { router } from "./routes.js";
import { startPoller, stopPoller } from "./poller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api", router);

// Serve the built client in production (client/dist), if present.
const clientDist = path.resolve(__dirname, "../public");
if (fs.existsSync(clientDist)) {
	app.use(express.static(clientDist));
	app.get("*", (_req, res) =>
		res.sendFile(path.join(clientDist, "index.html")),
	);
}

const server = app.listen(PORT, () => {
	console.log(`[server] listening on http://localhost:${PORT}`);
	startPoller();
});

function shutdown() {
	console.log("\n[server] shutting down…");
	stopPoller();
	server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
