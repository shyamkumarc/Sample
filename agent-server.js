/**
 * agent-server.js
 *
 * A minimal "OpenClaw-style" personal agent loop over WebSocket.
 *
 * Architecture (educational overview)
 * ─────────────────────────────────────────────────────────────────
 *
 *   Browser / CLI client
 *         │  WebSocket (JSON messages)
 *         ▼
 *   ┌─────────────────────────────────────────────┐
 *   │              WebSocket Server               │
 *   │   (one agent session per connection)        │
 *   │                                             │
 *   │   ┌─────────────────────────────────────┐   │
 *   │   │           Agent Loop                │   │
 *   │   │                                     │   │
 *   │   │  user message                       │   │
 *   │   │      │                              │   │
 *   │   │      ▼                              │   │
 *   │   │  Claude API  ◄──── tool results     │   │
 *   │   │      │                              │   │
 *   │   │      ▼                              │   │
 *   │   │  stop_reason == "tool_use"?         │   │
 *   │   │      │ yes → execute tools ─────►  │   │
 *   │   │      │ no  → send reply to client  │   │
 *   │   └─────────────────────────────────────┘   │
 *   └─────────────────────────────────────────────┘
 *
 * How to run
 * ──────────
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node agent-server.js
 *
 * Then connect with a WebSocket client and send JSON:
 *   { "message": "What time is it?" }
 *   { "message": "Calculate 123 * 456" }
 *   { "message": "Echo hello world back to me" }
 */

import { WebSocketServer } from "ws";
import Anthropic from "@anthropic-ai/sdk";
import * as emailSkill from "./skills/email.js";

const PORT = 8080;
const MODEL = "claude-opus-4-6";

// ─── Tool Definitions ────────────────────────────────────────────────────────
//
// Base tools + any skills.  Skills are just spread in here — the agent loop
// itself never changes, only the tool list grows.

const TOOLS = [
  // ── Email skill (requires EMAIL_USER + EMAIL_PASSWORD env vars) ────────
  ...emailSkill.TOOLS,

  // ── Built-in tools (no env vars needed) ────────────────────────────────
  {
    name: "get_current_time",
    description:
      "Returns the current date and time in ISO 8601 format. " +
      "Use this whenever the user asks what time or date it is.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "calculator",
    description:
      "Evaluates a safe arithmetic expression and returns the numeric result. " +
      "Supports +, -, *, /, ** (power), and parentheses. " +
      "Use this instead of doing math yourself.",
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "A mathematical expression, e.g. '(3 + 4) * 12 / 2'",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "echo",
    description:
      "Returns the provided text unchanged. Useful for demonstrating that the " +
      "agent loop routes tool calls correctly.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo back" },
      },
      required: ["text"],
    },
  },
];

// ─── Tool Executor ───────────────────────────────────────────────────────────
//
// When Claude decides to call a tool it returns a `tool_use` block containing
// the tool name and its arguments.  We pattern-match on the name and run the
// real logic here.  The result is a string that gets fed back to Claude so it
// can incorporate the answer into its final reply.

// executeTool routes to the right handler.
// Async because email tools involve real I/O (network calls to IMAP/SMTP).
async function executeTool(name, input) {
  // Delegate to the email skill if this is an email tool
  if (emailSkill.TOOL_NAMES.has(name)) {
    return emailSkill.execute(name, input);
  }

  switch (name) {
    case "get_current_time":
      return new Date().toISOString();

    case "calculator": {
      // We only allow digits and safe math operators to prevent code injection.
      const safe = /^[\d\s\+\-\*\/\(\)\.\*\*]+$/.test(input.expression);
      if (!safe) {
        return "Error: expression contains disallowed characters.";
      }
      try {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${input.expression})`)();
        return String(result);
      } catch (err) {
        return `Error evaluating expression: ${err.message}`;
      }
    }

    case "echo":
      return input.text;

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────
//
// This is the core of the "OpenClaw-style" pattern.
//
// Each WebSocket connection gets its own `conversationHistory` array so the
// agent remembers context across multiple turns in the same session.
//
// The loop:
//   1.  Append the latest user message.
//   2.  Call Claude with the full history + tool definitions.
//   3.  If Claude wants to call tools (stop_reason === "tool_use"):
//         a. Execute each requested tool.
//         b. Append Claude's assistant turn (including its tool_use blocks).
//         c. Append a user turn with all the tool_result blocks.
//         d. Go back to step 2.
//   4.  When Claude is done (stop_reason === "end_turn"), extract the text
//       reply and send it back to the WebSocket client.

async function runAgentLoop(client, conversationHistory, userMessage, send) {
  // Step 1 – add the new user message to history
  conversationHistory.push({ role: "user", content: userMessage });

  send({ type: "status", text: "Thinking…" });

  // The loop runs until Claude stops requesting tool calls
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        "You are a helpful personal assistant. " +
        "You have access to tools — always prefer using them over guessing. " +
        "Be concise.",
      tools: TOOLS,
      messages: conversationHistory,
    });

    const stopReason = response.stop_reason;

    // ── Case A: Claude wants to call one or more tools ────────────────────
    if (stopReason === "tool_use") {
      // Collect all tool_use blocks from Claude's response
      const toolUseBlocks = response.content.filter(
        (b) => b.type === "tool_use"
      );

      // Notify the client which tools are being called (nice for debugging)
      for (const block of toolUseBlocks) {
        send({
          type: "tool_call",
          tool: block.name,
          input: block.input,
        });
      }

      // Append Claude's full assistant turn (includes any text + tool_use blocks)
      conversationHistory.push({
        role: "assistant",
        content: response.content,
      });

      // Execute every tool and collect the results (await — may hit network)
      const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
        const result = await executeTool(block.name, block.input);
        send({ type: "tool_result", tool: block.name, result });
        return {
          type: "tool_result",
          tool_use_id: block.id, // must match the tool_use block's id
          content: String(result),
        };
      }));

      // Feed the results back to Claude as a user turn, then loop again
      conversationHistory.push({ role: "user", content: toolResults });
      continue;
    }

    // ── Case B: Claude is done — extract the final text reply ─────────────
    if (stopReason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      const reply = textBlock ? textBlock.text : "(no text response)";

      // Persist Claude's final turn in history for multi-turn memory
      conversationHistory.push({ role: "assistant", content: reply });

      send({ type: "reply", text: reply });
      return;
    }

    // ── Unexpected stop reason (max_tokens, stop_sequence, etc.) ──────────
    send({
      type: "error",
      text: `Unexpected stop_reason: ${stopReason}`,
    });
    return;
  }
}

// ─── WebSocket Server ────────────────────────────────────────────────────────

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const wss = new WebSocketServer({ port: PORT });

console.log(`Agent WebSocket server running on ws://localhost:${PORT}`);
console.log(`Send JSON: { "message": "your question here" }`);
console.log(`Available tools: ${TOOLS.map((t) => t.name).join(", ")}\n`);

wss.on("connection", (ws) => {
  console.log("Client connected");

  // Each connection gets its own conversation history (session memory)
  const conversationHistory = [];

  // Helper: send a structured JSON message back to the client
  const send = (payload) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  ws.on("message", async (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send({ type: "error", text: "Invalid JSON — expected { message: '...' }" });
      return;
    }

    const userMessage = parsed.message?.trim();
    if (!userMessage) {
      send({ type: "error", text: "Missing 'message' field in payload" });
      return;
    }

    console.log(`User: ${userMessage}`);

    try {
      await runAgentLoop(client, conversationHistory, userMessage, send);
    } catch (err) {
      console.error("Agent loop error:", err);
      send({ type: "error", text: err.message });
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});
