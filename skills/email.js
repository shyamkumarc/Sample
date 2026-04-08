/**
 * skills/email.js
 *
 * Email skill — reads and sends email via IMAP/SMTP.
 *
 * How a "skill" works (OpenClaw pattern)
 * ──────────────────────────────────────
 * A skill is just two exports that plug into the agent loop:
 *
 *   TOOLS    — JSON schema descriptions Claude uses to decide when/how to call
 *   execute  — the real code that runs when Claude picks a tool
 *
 * The agent loop in agent-server.js doesn't change at all.
 * Adding a skill = spreading its TOOLS into the TOOLS array
 *                + routing its tool names through executeTool().
 *
 * Setup (Gmail example)
 * ──────────────────────
 *   1. Enable IMAP in Gmail settings
 *   2. Create an App Password (Google Account → Security → App passwords)
 *   3. Set env vars:
 *        EMAIL_USER=you@gmail.com
 *        EMAIL_PASSWORD=your-app-password
 *        EMAIL_IMAP_HOST=imap.gmail.com   (default)
 *        EMAIL_SMTP_HOST=smtp.gmail.com   (default)
 *
 * Works with any IMAP/SMTP provider (Outlook, Fastmail, etc.)
 * — just change the host env vars.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

// ─── Config (from environment) ───────────────────────────────────────────────

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const IMAP_HOST = process.env.EMAIL_IMAP_HOST || "imap.gmail.com";
const SMTP_HOST = process.env.EMAIL_SMTP_HOST || "smtp.gmail.com";

// ─── Tool Definitions ─────────────────────────────────────────────────────────
//
// Claude reads these descriptions to decide when to call each tool and what
// arguments to pass.  Good descriptions = better tool-use decisions.

export const TOOLS = [
  {
    name: "list_emails",
    description:
      "Fetch a list of recent emails from a mailbox folder. " +
      "Returns email id, subject, sender, date, and a short snippet. " +
      "Use this to get an overview of the inbox before reading specific emails.",
    input_schema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Mailbox folder to read, e.g. 'INBOX', 'Sent'. Default: INBOX",
        },
        limit: {
          type: "number",
          description: "Max number of emails to return (newest first). Default: 10",
        },
        unseen_only: {
          type: "boolean",
          description: "If true, return only unread emails. Default: false",
        },
      },
      required: [],
    },
  },
  {
    name: "read_email",
    description:
      "Read the full body of a specific email by its ID. " +
      "Use list_emails first to find the ID, then call this for the full content.",
    input_schema: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The email ID returned by list_emails",
        },
        folder: {
          type: "string",
          description: "Mailbox folder containing the email. Default: INBOX",
        },
      },
      required: ["email_id"],
    },
  },
  {
    name: "send_email",
    description:
      "Send or reply to an email. " +
      "For replies, include the original subject prefixed with 'Re: ' and set in_reply_to.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address",
        },
        subject: {
          type: "string",
          description: "Email subject line",
        },
        body: {
          type: "string",
          description: "Plain-text email body",
        },
        in_reply_to: {
          type: "string",
          description: "Message-ID of the email being replied to (optional)",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "search_emails",
    description:
      "Search emails in a folder by keyword (matches subject and body).",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term to look for in subject or body",
        },
        folder: {
          type: "string",
          description: "Folder to search in. Default: INBOX",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default: 10",
        },
      },
      required: ["query"],
    },
  },
];

// ─── Tool Names (for routing in agent-server.js) ──────────────────────────────

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ─── IMAP helper: open a connection, run a callback, close ───────────────────
//
// ImapFlow uses a connection-per-operation model.  We open, do the work,
// then always close — even on error — to avoid leaking connections.

async function withImap(callback) {
  if (!EMAIL_USER || !EMAIL_PASSWORD) {
    throw new Error(
      "EMAIL_USER and EMAIL_PASSWORD environment variables are required for the email skill."
    );
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
    logger: false, // silence verbose IMAP logs
  });

  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.logout();
  }
}

// ─── Tool Executors ───────────────────────────────────────────────────────────

async function listEmails({ folder = "INBOX", limit = 10, unseen_only = false }) {
  return withImap(async (client) => {
    await client.mailboxOpen(folder);

    // Build search criteria
    const criteria = unseen_only ? { seen: false } : { all: true };

    // Collect matching UIDs, take the last `limit` (most recent)
    const uids = [];
    for await (const msg of client.fetch(criteria, { uid: true })) {
      uids.push(msg.uid);
    }
    const recentUids = uids.slice(-limit).reverse();

    if (recentUids.length === 0) return "No emails found.";

    // Fetch envelope (headers only — fast)
    const emails = [];
    for await (const msg of client.fetch(recentUids, {
      uid: true,
      envelope: true,
      bodyStructure: true,
      flags: true,
    })) {
      const env = msg.envelope;
      emails.push({
        id: String(msg.uid),
        subject: env.subject || "(no subject)",
        from: env.from?.[0]?.address || "unknown",
        date: env.date?.toISOString().slice(0, 16) || "unknown",
        unread: !msg.flags?.has("\\Seen"),
      });
    }

    return JSON.stringify(emails, null, 2);
  });
}

async function readEmail({ email_id, folder = "INBOX" }) {
  return withImap(async (client) => {
    await client.mailboxOpen(folder);

    // Download the raw message then parse it with mailparser
    const { content } = await client.download(String(email_id), undefined, {
      uid: true,
    });

    const chunks = [];
    for await (const chunk of content) chunks.push(chunk);
    const raw = Buffer.concat(chunks);

    const parsed = await simpleParser(raw);

    return JSON.stringify(
      {
        id: email_id,
        subject: parsed.subject,
        from: parsed.from?.text,
        to: parsed.to?.text,
        date: parsed.date?.toISOString(),
        message_id: parsed.messageId,
        // Prefer plain text; fall back to stripping HTML tags
        body:
          parsed.text ||
          (parsed.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      },
      null,
      2
    );
  });
}

async function sendEmail({ to, subject, body, in_reply_to }) {
  if (!EMAIL_USER || !EMAIL_PASSWORD) {
    throw new Error("EMAIL_USER and EMAIL_PASSWORD are required to send email.");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: 465,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
  });

  const mailOptions = {
    from: EMAIL_USER,
    to,
    subject,
    text: body,
    ...(in_reply_to ? { inReplyTo: in_reply_to, references: in_reply_to } : {}),
  };

  const info = await transporter.sendMail(mailOptions);
  return `Email sent. Message ID: ${info.messageId}`;
}

async function searchEmails({ query, folder = "INBOX", limit = 10 }) {
  return withImap(async (client) => {
    await client.mailboxOpen(folder);

    // IMAP TEXT search matches subject + body
    const uids = [];
    for await (const msg of client.fetch({ text: query }, { uid: true })) {
      uids.push(msg.uid);
    }
    const recentUids = uids.slice(-limit).reverse();

    if (recentUids.length === 0) return `No emails found matching "${query}".`;

    const emails = [];
    for await (const msg of client.fetch(recentUids, {
      uid: true,
      envelope: true,
      flags: true,
    })) {
      const env = msg.envelope;
      emails.push({
        id: String(msg.uid),
        subject: env.subject || "(no subject)",
        from: env.from?.[0]?.address || "unknown",
        date: env.date?.toISOString().slice(0, 16) || "unknown",
        unread: !msg.flags?.has("\\Seen"),
      });
    }

    return JSON.stringify(emails, null, 2);
  });
}

// ─── Main executor (called by agent-server.js) ────────────────────────────────

export async function execute(name, input) {
  switch (name) {
    case "list_emails":   return listEmails(input);
    case "read_email":    return readEmail(input);
    case "send_email":    return sendEmail(input);
    case "search_emails": return searchEmails(input);
    default: return `Unknown email tool: ${name}`;
  }
}
