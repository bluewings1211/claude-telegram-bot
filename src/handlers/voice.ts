/**
 * Voice message handler for Claude Telegram Bot.
 *
 * Handles incoming voice messages with thread-based conversation support.
 * Voice is transcribed via OpenAI, then processed like a text message.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { sessionManager } from "../session-manager";
import { ALLOWED_USERS, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  transcribeVoice,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;
  const messageId = ctx.message?.message_id;

  if (!userId || !voice || !chatId || !messageId) {
    return;
  }

  // Voice messages always start a new thread (user's voice message is the anchor)
  const threadAnchorId = messageId;

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.", {
      reply_to_message_id: threadAnchorId,
    });
    return;
  }

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env",
      { reply_to_message_id: threadAnchorId }
    );
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
      { reply_to_message_id: threadAnchorId }
    );
    return;
  }

  // 4. Get or create session for this thread
  const session = sessionManager.getOrCreateSession(
    chatId,
    threadAnchorId,
    "[Voice message]"
  );

  // 5. Mark processing started (allows /stop to work during transcription)
  const stopProcessing = session.startProcessing();

  // 6. Start typing indicator for transcription
  const typing = startTypingIndicator(ctx);

  let voicePath: string | null = null;

  try {
    // 7. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    // Download the file
    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // 8. Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing...", {
      reply_to_message_id: threadAnchorId,
    });

    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Transcription failed."
      );
      stopProcessing();
      return;
    }

    // 9. Update session title with transcript preview
    session.title = transcript.slice(0, 50);

    // 10. Show transcript
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 "${transcript}"`
    );

    // 11. Create streaming state and callback
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state, threadAnchorId);

    // 12. Send to Claude
    const claudeResponse = await session.sendMessageStreaming(
      transcript,
      username,
      userId,
      statusCallback,
      ctx
    );

    // 13. Audit log
    await auditLog(userId, username, "VOICE", transcript, claudeResponse);

    // 14. Save sessions
    sessionManager.saveSessions();
  } catch (error) {
    console.error(`[Thread ${threadAnchorId}] Error processing voice:`, error);

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.", {
          reply_to_message_id: threadAnchorId,
        });
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`, {
        reply_to_message_id: threadAnchorId,
      });
    }
  } finally {
    stopProcessing();
    typing.stop();

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch (error) {
        console.debug("Failed to delete voice file:", error);
      }
    }
  }
}
