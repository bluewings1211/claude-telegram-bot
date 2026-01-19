/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart, /retry
 * Updated for multi-session thread-based architecture.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sessionManager } from "../session-manager";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import { isAuthorized } from "../security";

/**
 * Format duration in human readable form.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.", {
      reply_to_message_id: messageId,
    });
    return;
  }

  const sessions = chatId ? sessionManager.getSessionsForChat(chatId) : [];
  const activeSessions = sessions.filter((s) => s.isActive);
  const runningSessions = sessions.filter((s) => s.isRunning);

  let status = "No active sessions";
  if (runningSessions.length > 0) {
    status = `${runningSessions.length} running, ${activeSessions.length} active`;
  } else if (activeSessions.length > 0) {
    status = `${activeSessions.length} active sessions`;
  }

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Working directory: <code>${WORKING_DIR}</code>\n\n` +
      `<b>Commands:</b>\n` +
      `/new - Clear all sessions\n` +
      `/stop - Stop running queries\n` +
      `/status - Show all sessions\n` +
      `/resume - Resume saved session\n` +
      `/retry - Retry last message\n` +
      `/restart - Restart the bot\n\n` +
      `<b>Tips:</b>\n` +
      `• Each message starts a new thread\n` +
      `• Reply to continue a thread\n` +
      `• Prefix with <code>!</code> to interrupt\n` +
      `• Use "think" keyword for extended reasoning`,
    { parse_mode: "HTML", reply_to_message_id: messageId }
  );
}

/**
 * /new - Clear all sessions and start fresh.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.", { reply_to_message_id: messageId });
    return;
  }

  if (!chatId) return;

  // Stop all running queries
  const stoppedCount = await sessionManager.stopAllSessions(chatId);

  // Clear all sessions for this chat
  const clearedCount = sessionManager.clearSessionsForChat(chatId);

  if (stoppedCount > 0 || clearedCount > 0) {
    await ctx.reply(
      `🆕 Cleared ${clearedCount} session(s), stopped ${stoppedCount} running query(s).\nNext message starts a new thread.`,
      { reply_to_message_id: messageId }
    );
  } else {
    await ctx.reply("🆕 No active sessions. Next message starts a new thread.", {
      reply_to_message_id: messageId,
    });
  }
}

/**
 * /stop - Stop running queries.
 * If in a thread, stop that thread. Otherwise stop all.
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const replyToId = ctx.message?.reply_to_message?.message_id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.", { reply_to_message_id: messageId });
    return;
  }

  if (!chatId) return;

  // If user replied to a message, try to stop that specific thread
  if (replyToId) {
    const session = sessionManager.getSession(chatId, replyToId);
    if (session?.isRunning) {
      const result = await session.stop();
      if (result) {
        await Bun.sleep(100);
        session.clearStopRequested();
        await ctx.reply("🛑 Stopped.", { reply_to_message_id: replyToId });
      }
      return;
    }
  }

  // Otherwise stop all running sessions
  const sessions = sessionManager.getSessionsForChat(chatId);
  const running = sessions.filter((s) => s.isRunning);

  if (running.length === 0) {
    // Silent if nothing running
    return;
  }

  let stoppedCount = 0;
  for (const session of running) {
    const result = await session.stop();
    if (result) {
      stoppedCount++;
      await Bun.sleep(50);
      session.clearStopRequested();
    }
  }

  if (stoppedCount > 0) {
    await ctx.reply(`🛑 Stopped ${stoppedCount} query(s).`, {
      reply_to_message_id: messageId,
    });
  }
}

/**
 * /status - Show detailed status of all sessions.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.", { reply_to_message_id: messageId });
    return;
  }

  if (!chatId) return;

  const sessions = sessionManager.getSessionsForChat(chatId);
  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  if (sessions.length === 0) {
    lines.push("No active sessions.");
    lines.push("\nSend a message to start a new thread.");
  } else {
    lines.push(`<b>${sessions.length} Session(s):</b>\n`);

    for (const session of sessions) {
      const stateEmoji = session.isRunning ? "🔄" : session.isActive ? "✅" : "⚪";
      const state = session.isRunning
        ? "Running"
        : session.isActive
          ? "Active"
          : "Idle";

      lines.push(`${stateEmoji} <b>Thread ${session.threadAnchorId}</b>`);
      lines.push(`   Title: ${session.title}`);
      lines.push(`   State: ${state}`);

      if (session.isRunning && session.queryStarted) {
        const elapsed = Date.now() - session.queryStarted.getTime();
        lines.push(`   Running: ${formatDuration(elapsed)}`);
        if (session.currentTool) {
          lines.push(`   └─ ${session.currentTool}`);
        }
      }

      if (session.lastActivity) {
        const ago = Date.now() - session.lastActivity.getTime();
        lines.push(`   Last activity: ${formatDuration(ago)} ago`);
      }

      if (session.lastUsage) {
        const u = session.lastUsage;
        lines.push(
          `   Tokens: ${u.input_tokens?.toLocaleString() || "?"} in / ${u.output_tokens?.toLocaleString() || "?"} out`
        );
      }

      if (session.lastError) {
        lines.push(`   ⚠️ Error: ${session.lastError}`);
      }

      lines.push("");
    }
  }

  lines.push(`📁 Working dir: <code>${WORKING_DIR}</code>`);

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_to_message_id: messageId,
  });
}

/**
 * /resume - Show saved sessions and let user choose which to resume.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.", { reply_to_message_id: messageId });
    return;
  }

  if (!chatId) return;

  // Get persisted sessions
  const persisted = sessionManager.getPersistedSessions(chatId);

  if (persisted.length === 0) {
    await ctx.reply("❌ No saved sessions to resume.", {
      reply_to_message_id: messageId,
    });
    return;
  }

  // Show inline keyboard with session choices
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < Math.min(persisted.length, 5); i++) {
    const s = persisted[i]!;
    const age = formatDuration(
      Date.now() - new Date(s.last_activity).getTime()
    );
    const label = `${s.title?.slice(0, 25) || "Untitled"} (${age})`;
    keyboard.text(label, `resume:${s.thread_anchor_id}`).row();
  }

  await ctx.reply("Select a session to resume:", {
    reply_markup: keyboard,
    reply_to_message_id: messageId,
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.", { reply_to_message_id: messageId });
    return;
  }

  // Save sessions before restart
  sessionManager.saveSessions();

  const msg = await ctx.reply("🔄 Restarting bot...", {
    reply_to_message_id: messageId,
  });

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /retry - Retry the last message in a thread.
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const replyToId = ctx.message?.reply_to_message?.message_id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.", { reply_to_message_id: messageId });
    return;
  }

  if (!chatId) return;

  // If user replied to a message, find that session
  let session;
  if (replyToId) {
    session = sessionManager.getSession(chatId, replyToId);
  }

  // Otherwise, find the most recent session with a lastMessage
  if (!session) {
    const sessions = sessionManager
      .getSessionsForChat(chatId)
      .filter((s) => s.lastMessage)
      .sort(
        (a, b) =>
          (b.lastActivity?.getTime() || 0) - (a.lastActivity?.getTime() || 0)
      );
    session = sessions[0];
  }

  if (!session?.lastMessage) {
    await ctx.reply("❌ No message to retry.", {
      reply_to_message_id: messageId,
    });
    return;
  }

  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running in that thread. Use /stop first.", {
      reply_to_message_id: messageId,
    });
    return;
  }

  const message = session.lastMessage;
  const threadAnchorId = session.threadAnchorId;

  await ctx.reply(
    `🔄 Retrying in thread ${threadAnchorId}: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`,
    { reply_to_message_id: messageId }
  );

  // Import and use handleText directly with a fake context
  const { handleText } = await import("./text");

  // Create a modified context that points to the original thread
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      message_id: threadAnchorId, // Use the original thread anchor
      text: message,
      reply_to_message: undefined, // Clear reply so it uses the message_id as anchor
    },
  } as Context;

  await handleText(fakeCtx);
}
