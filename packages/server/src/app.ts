import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express, { type Express } from "express";

import { PROTOCOL_VERSION } from "@battletank/shared";

import { CLIENT_ORIGIN } from "./config.js";

/**
 * Absolute path to the built client bundle.
 *
 * This module sits two directories deep in its package (`src/app.ts` in dev via
 * tsx, `dist/app.js` once built), so the client's `dist` is `../../client/dist`
 * from here either way. `CLIENT_DIST` overrides it for unusual layouts.
 */
const CLIENT_DIST =
  process.env["CLIENT_DIST"] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");

/**
 * Builds the HTTP side of the server (health check, and — in a bundled
 * deployment — the static client).
 *
 * Colyseus intercepts `/matchmake/*` on the raw HTTP server before Express ever
 * sees it, and the WebSocket upgrade is handled off the `upgrade` event, so the
 * static handler and SPA fallback below only ever field genuine page/asset
 * requests. Neither can shadow matchmaking or the realtime socket.
 */
export function createApp(): Express {
  const app = express();

  app.use(cors({ origin: CLIENT_ORIGIN }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", protocolVersion: PROTOCOL_VERSION });
  });

  // Only serve the client when a build is actually present. In local dev the
  // client runs on the Vite dev server and this directory does not exist, so
  // skipping it keeps the API server usable on its own.
  if (existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));

    // SPA fallback: hand any other GET the app shell so deep links resolve.
    // Express 5 rejects a bare "*" path, so this uses a named wildcard.
    app.get("/*splat", (_req, res) => {
      res.sendFile(path.join(CLIENT_DIST, "index.html"));
    });

    console.log(`[server] serving client from ${CLIENT_DIST}`);
  } else {
    console.log(`[server] no client build at ${CLIENT_DIST} — API only`);
  }

  return app;
}
