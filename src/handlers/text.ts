/**
 * Text message handler for Claude Telegram Bot.
 *
 * Handles incoming text messages with thread-based conversation support.
 * Each new message in main chat creates a new thread, while replies
 * within existing threads continue the same session.
 */

import type { Context } from "grammy";
import { sessionManager } from "../session-manager";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  checkInterruptPrefix,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

/**
 * Determine the thread anchor for a message.
 * - If user replies to a message that has a session, use that thread
 * - Otherwise, the user's message becomes the new thread anchor
 */
function determineThreadAnchor(
  ctx: Context,
  chatId: number
): { threadAnchorId: number; isNewThread: boolean } {
  const messageId = ctx.message?.message_id;
  const replyToMessage = ctx.message?.reply_to_message;

  if (!messageId) {
    throw new Error("No message ID");
  }

  // Check if user is replying to an existing message
  if (replyToMessage) {
    const replyToId = replyToMessage.message_id;

    // Check if the replied-to message belongs to an existing session
    // We need to check if there's a session for this thread anchor
    const existingSession = sessionManager.getSession(chatId, replyToId);
    if (existingSession) {
      // Continue in the existing thread
      return { threadAnchorId: replyToId, isNewThread: false };
    }

    // Also check if the replied-to message's thread anchor exists
    // (user might be replying to a bot's response within a thread)
    for (const session of sessionManager.getSessionsForChat(chatId)) {
      // This is a simple heuristic - the user's message becomes thread anchor
      // Bot replies within the thread don't create new sessions
      if (session.threadAnchorId === replyToId) {
        return { threadAnchorId: replyToId, isNewThread: false };
      }
    }
  }

  // New message in main chat or reply to non-session message = new thread
  return { threadAnchorId: messageId, isNewThread: true };
}

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.", {
      reply_to_message_id: ctx.message?.message_id,
    });
    return;
  }

  // 2. Check for interrupt prefix (! at start)
  const { text: strippedMessage, isInterrupt } = checkInterruptPrefix(message);
  message = strippedMessage;
  if (!message.trim()) {
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
      { reply_to_message_id: ctx.message?.message_id }
    );
    return;
  }

  // 4. Determine thread anchor
  const { threadAnchorId, isNewThread } = determineThreadAnchor(ctx, chatId);

  // 5. Handle interrupt - stop any running sessions in this chat
  if (isInterrupt) {
    const sessions = sessionManager.getSessionsForChat(chatId);
    for (const s of sessions) {
      if (s.isRunning) {
        console.log(`! prefix - interrupting session ${s.threadAnchorId}`);
        s.markInterrupt();
        await s.stop();
        await Bun.sleep(50);
        s.clearStopRequested();
      }
    }
  }

  // 6. Get or create session for this thread
  const titlePreview = message.slice(0, 50);
  const session = sessionManager.getOrCreateSession(
    chatId,
    threadAnchorId,
    titlePreview
  );

  // 7. Mark processing started
  const stopProcessing = session.startProcessing();

  // 8. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 9. Create streaming state and callback with thread anchor
  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state, threadAnchorId);

  // 10. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await session.sendMessageStreaming(
        message,
        username,
        userId,
        statusCallback,
        ctx
      );

      // 11. Audit log
      await auditLog(userId, username, "TEXT", message, response);

      // 12. Save sessions after successful query
      sessionManager.saveSessions();

      break; // Success - exit retry loop
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      // Clean up any partial messages from this attempt
      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Retry on Claude Code crash (not user cancellation)
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `[Thread ${threadAnchorId}] Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await session.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`, {
          reply_to_message_id: threadAnchorId,
        });
        // Reset state for retry
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state, threadAnchorId);
        continue;
      }

      // Final attempt failed or non-retryable error
      console.error(`[Thread ${threadAnchorId}] Error processing message:`, error);

      // Check if it was a cancellation
      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
        const wasInterrupt = session.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.", {
            reply_to_message_id: threadAnchorId,
          });
        }
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`, {
          reply_to_message_id: threadAnchorId,
        });
      }
      break; // Exit loop after handling error
    }
  }

  // 13. Cleanup
  stopProcessing();
  typing.stop();
}
