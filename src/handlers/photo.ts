/**
 * Photo message handler for Claude Telegram Bot.
 *
 * Supports single photos and media groups (albums) with 1s buffering.
 * All replies are threaded to the user's message for conversation organization.
 */

import type { Context } from "grammy";
import { sessionManager } from "../session-manager";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";

// Create photo-specific media group buffer
const photoBuffer = createMediaGroupBuffer({
  emoji: "📷",
  itemLabel: "photo",
  itemLabelPlural: "photos",
});

/**
 * Download a photo and return the local path.
 */
async function downloadPhoto(ctx: Context): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    throw new Error("No photo in message");
  }

  // Get the largest photo
  const file = await ctx.getFile();

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const photoPath = `${TEMP_DIR}/photo_${timestamp}_${random}.jpg`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(photoPath, buffer);

  return photoPath;
}

/**
 * Process photos with Claude.
 */
async function processPhotos(
  ctx: Context,
  photoPaths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  threadAnchorId: number
): Promise<void> {
  // Get or create session for this thread
  const titlePreview = caption?.slice(0, 50) || "[Photo analysis]";
  const session = sessionManager.getOrCreateSession(
    chatId,
    threadAnchorId,
    titlePreview
  );

  // Mark processing started
  const stopProcessing = session.startProcessing();

  // Build prompt
  let prompt: string;
  if (photoPaths.length === 1) {
    prompt = caption
      ? `[Photo: ${photoPaths[0]}]\n\n${caption}`
      : `Please analyze this image: ${photoPaths[0]}`;
  } else {
    const pathsList = photoPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
    prompt = caption
      ? `[Photos:\n${pathsList}]\n\n${caption}`
      : `Please analyze these ${photoPaths.length} images:\n${pathsList}`;
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state with thread anchor
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state, threadAnchorId);

  try {
    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      ctx
    );

    await auditLog(userId, username, "PHOTO", prompt, response);
    sessionManager.saveSessions();
  } catch (error) {
    await handleProcessingError(ctx, error, state.toolMessages, threadAnchorId, chatId);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Handle incoming photo messages.
 */
export async function handlePhoto(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;
  const messageId = ctx.message?.message_id;

  if (!userId || !chatId || !messageId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.", {
      reply_to_message_id: messageId,
    });
    return;
  }

  // 2. For single photos, show status and rate limit early
  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
  if (!mediaGroupId) {
    console.log(`Received photo from @${username}`);
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`,
        { reply_to_message_id: messageId }
      );
      return;
    }

    // Show status immediately
    statusMsg = await ctx.reply("📷 Processing image...", {
      reply_to_message_id: messageId,
    });
  }

  // 3. Download photo
  let photoPath: string;
  try {
    photoPath = await downloadPhoto(ctx);
  } catch (error) {
    console.error("Failed to download photo:", error);
    if (statusMsg) {
      try {
        await ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          "❌ Failed to download photo."
        );
      } catch (editError) {
        console.debug("Failed to edit status message:", editError);
        await ctx.reply("❌ Failed to download photo.", {
          reply_to_message_id: messageId,
        });
      }
    } else {
      await ctx.reply("❌ Failed to download photo.", {
        reply_to_message_id: messageId,
      });
    }
    return;
  }

  // 4. Single photo - process immediately
  if (!mediaGroupId && statusMsg) {
    // User's message is the thread anchor
    const threadAnchorId = messageId;

    await processPhotos(
      ctx,
      [photoPath],
      ctx.message?.caption,
      userId,
      username,
      chatId,
      threadAnchorId
    );

    // Clean up status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch (error) {
      console.debug("Failed to delete status message:", error);
    }
    return;
  }

  // 5. Media group - buffer with timeout
  if (!mediaGroupId) return; // TypeScript guard

  await photoBuffer.addToGroup(
    mediaGroupId,
    photoPath,
    ctx,
    userId,
    username,
    processPhotos
  );
}
