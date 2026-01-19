/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses:
 * - askuser:{request_id}:{option_index} - MCP ask_user integration
 * - resume:{thread_anchor_id} - Resume session from /resume command
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { sessionManager } from "../session-manager";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Route callback based on prefix
  if (callbackData.startsWith("askuser:")) {
    await handleAskUserCallback(ctx, callbackData, userId, username, chatId);
  } else if (callbackData.startsWith("resume:")) {
    await handleResumeCallback(ctx, callbackData, chatId);
  } else {
    await ctx.answerCallbackQuery();
  }
}

/**
 * Handle ask_user MCP callback.
 */
async function handleAskUserCallback(
  ctx: Context,
  callbackData: string,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Parse callback data: askuser:{request_id}:{option_index}
  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
    chat_id?: string;
    thread_anchor_id?: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // Get thread anchor from request data
  const threadAnchorId = requestData.thread_anchor_id
    ? parseInt(requestData.thread_anchor_id, 10)
    : undefined;

  // Find the session for this thread
  let session;
  if (threadAnchorId) {
    session = sessionManager.getSession(chatId, threadAnchorId);
  }

  if (!session) {
    // Fallback: find any active session in this chat
    const sessions = sessionManager.getSessionsForChat(chatId);
    session = sessions.find((s) => s.isActive);
  }

  if (!session) {
    await ctx.reply("❌ Session not found. Please start a new conversation.", {
      reply_to_message_id: threadAnchorId,
    });
    return;
  }

  // Interrupt any running query - button responses are always immediate
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
    await session.stop();
    await Bun.sleep(100);
  }

  // Use the session's thread anchor if we didn't have one
  const anchorId = threadAnchorId || session.threadAnchorId;

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state, anchorId);

  try {
    const response = await session.sendMessageStreaming(
      selectedOption,
      username,
      userId,
      statusCallback,
      ctx
    );

    await auditLog(userId, username, "CALLBACK", selectedOption, response);
    sessionManager.saveSessions();
  } catch (error) {
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.", {
          reply_to_message_id: anchorId,
        });
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`, {
        reply_to_message_id: anchorId,
      });
    }
  } finally {
    typing.stop();
  }
}

/**
 * Handle resume session callback from /resume command.
 */
async function handleResumeCallback(
  ctx: Context,
  callbackData: string,
  chatId: number
): Promise<void> {
  // Parse callback data: resume:{thread_anchor_id}
  const parts = callbackData.split(":");
  if (parts.length !== 2) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const threadAnchorId = parseInt(parts[1]!, 10);
  if (isNaN(threadAnchorId)) {
    await ctx.answerCallbackQuery({ text: "Invalid thread ID" });
    return;
  }

  // Try to resume the session
  const session = await sessionManager.resumeSession(chatId, threadAnchorId);

  if (!session) {
    await ctx.answerCallbackQuery({ text: "Session not found or expired" });
    // Update the original message
    try {
      await ctx.editMessageText("❌ Session not found or expired.");
    } catch (error) {
      console.debug("Failed to edit resume message:", error);
    }
    return;
  }

  // Answer the callback
  await ctx.answerCallbackQuery({
    text: `Resumed: ${session.title?.slice(0, 30) || "Session"}`,
  });

  // Update the original message
  try {
    await ctx.editMessageText(
      `✅ Resumed session: ${session.title || "Untitled"}\n\n` +
        `Reply to your original message (ID: ${threadAnchorId}) to continue the conversation.`
    );
  } catch (error) {
    console.debug("Failed to edit resume message:", error);
  }
}
