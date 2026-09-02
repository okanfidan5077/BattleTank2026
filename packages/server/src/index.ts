import { createServer } from "node:http";

import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { BATTLE_ROOM, CAMPAIGN_ROOM } from "@battletank/shared";

import { createApp } from "./app.js";
import { HOST, PORT } from "./config.js";
import { BattleRoom } from "./rooms/BattleRoom.js";
import { CampaignRoom } from "./rooms/CampaignRoom.js";

const httpServer = createServer(createApp());

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define(BATTLE_ROOM, BattleRoom);
gameServer.define(CAMPAIGN_ROOM, CampaignRoom);

await gameServer.listen(PORT, HOST);
console.log(`[server] listening on ${HOST}:${PORT} (room: "${BATTLE_ROOM}")`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void gameServer.gracefullyShutdown();
  });
}
