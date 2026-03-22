// Quick script to test the agent without the chat UI.
// Make sure `npm run dev` is running first, then:
//   npm run agent "draw a simple flowchart"

const message = process.argv.slice(2).join(" ") || "draw a rectangle";
const url = "ws://localhost:5173/agents/design-agent/test";

const ws = new WebSocket(url);
const requestId = crypto.randomUUID();

ws.addEventListener("open", () => {
  console.log(`Sending: "${message}"\n`);

  // AIChatAgent protocol: send a cf_agent_use_chat_request with
  // the messages in the init.body as JSON.
  const userMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: message }],
  };

  ws.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: requestId,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [userMessage] }),
      },
    })
  );
});

ws.addEventListener("message", (event) => {
  const data = event.data;
  try {
    const parsed = JSON.parse(data);

    // Only print chunks from our request, ignore identity/mcp messages
    if (parsed.type === "cf_agent_use_chat_response" && parsed.id === requestId) {
      // The body contains the streamed chunk
      process.stdout.write(parsed.body);
      if (parsed.done) {
        console.log("\n");
        ws.close();
      }
    }
  } catch {
    // Not JSON, just print it
    process.stdout.write(data);
  }
});

ws.addEventListener("close", () => {
  process.exit(0);
});

ws.addEventListener("error", (err) => {
  console.error("WebSocket error:", err.message);
  console.error("Make sure `npm run dev` is running first.");
  process.exit(1);
});

setTimeout(() => {
  console.log("\n\nTimeout, closing.");
  ws.close();
  process.exit(0);
}, 60000);
