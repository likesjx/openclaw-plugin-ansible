#!/usr/bin/env node
/**
 * Simple test to verify y-websocket sync between server (setupWSConnection) and client (WebsocketProvider)
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocketServer, WebSocket } from "ws";
import { setupWSConnection, getYDoc } from "y-websocket/bin/utils";

const PORT = 9999;
const ROOM = "test-room";

console.log("Starting y-websocket sync test...");

// Start server
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  console.log("[Server] New connection from", req.socket.remoteAddress);
  console.log("[Server] Request URL:", req.url);
  setupWSConnection(ws, req, { docName: ROOM });
});

wss.on("listening", () => {
  console.log(`[Server] Listening on port ${PORT}`);

  // Wait a bit then start client
  setTimeout(startClient, 500);
});

wss.on("error", (err) => {
  console.error("[Server] Error:", err.message);
});

function startClient() {
  console.log("[Client] Creating Y.Doc and connecting...");

  const clientDoc = new Y.Doc();
  clientDoc.getMap("test");

  const provider = new WebsocketProvider(`ws://localhost:${PORT}`, ROOM, clientDoc, {
    connect: true,
    WebSocketPolyfill: WebSocket,
  });

  provider.on("status", (event) => {
    console.log(`[Client] Status: ${event.status}`);
  });

  provider.on("sync", (synced) => {
    console.log(`[Client] Synced: ${synced}`);
    if (synced) {
      // Test a write from client
      console.log("[Client] Writing test data...");
      clientDoc.getMap("test").set("hello", "world");

      // Read back after a delay
      setTimeout(() => {
        const serverDoc = getYDoc(ROOM);
        const serverValue = serverDoc.getMap("test").get("hello");
        console.log(`[Server] Value in server doc: ${serverValue}`);

        if (serverValue === "world") {
          console.log("\n✓ Sync test PASSED!");
        } else {
          console.log("\n✗ Sync test FAILED - value not synced");
        }

        // Cleanup
        provider.destroy();
        wss.close();
        process.exit(0);
      }, 1000);
    }
  });

  provider.on("connection-error", (event) => {
    console.error("[Client] Connection error:", event);
  });

  // Timeout if nothing happens
  setTimeout(() => {
    console.log("\n✗ Test timed out");
    provider.destroy();
    wss.close();
    process.exit(1);
  }, 10000);
}
