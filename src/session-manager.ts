/**
 * Session Manager for Claude Telegram Bot.
 *
 * Manages multiple ThreadSession instances, allowing parallel execution
 * of conversations in different Telegram threads.
 */

import { existsSync, readFileSync } from "fs";
import {
  MAX_CONCURRENT_SESSIONS,
  SESSION_TIMEOUT_MS,
  SESSIONS_FILE,
} from "./config";
import { ThreadSession } from "./session";
import type { PersistedSessions, ThreadSessionData } from "./types";

/**
 * Manages multiple thread-based sessions.
 */
class SessionManager {
  private sessions: Map<string, ThreadSession> = new Map();

  /**
   * Get unique key for a thread.
   */
  private getKey(chatId: number, threadAnchorId: number): string {
    return `${chatId}:${threadAnchorId}`;
  }

  /**
   * Get or create a session for a thread.
   */
  getOrCreateSession(
    chatId: number,
    threadAnchorId: number,
    title?: string
  ): ThreadSession {
    const key = this.getKey(chatId, threadAnchorId);

    let session = this.sessions.get(key);
    if (session) {
      return session;
    }

    // Check if we've hit the max concurrent sessions limit
    const activeSessions = this.getSessionsForChat(chatId).filter(
      (s) => s.isRunning
    );
    if (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
      console.warn(
        `[SessionManager] Max concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached for chat ${chatId}`
      );
      // Find the oldest idle session to remove
      const idleSessions = Array.from(this.sessions.values())
        .filter((s) => s.chatId === chatId && !s.isRunning)
        .sort(
          (a, b) =>
            (a.lastActivity?.getTime() || 0) - (b.lastActivity?.getTime() || 0)
        );

      const oldest = idleSessions[0];
      if (oldest) {
        this.removeSession(oldest.chatId, oldest.threadAnchorId);
        console.log(
          `[SessionManager] Removed idle session ${oldest.threadAnchorId} to make room`
        );
      }
    }

    // Create new session
    session = new ThreadSession(chatId, threadAnchorId, title);
    this.sessions.set(key, session);
    console.log(
      `[SessionManager] Created new session for thread ${threadAnchorId} (total: ${this.sessions.size})`
    );

    // Auto-save sessions
    this.saveSessions();

    return session;
  }

  /**
   * Get existing session by thread anchor (searches across all chats).
   */
  getSessionByThread(threadAnchorId: number): ThreadSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.threadAnchorId === threadAnchorId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Get session by chat and thread anchor.
   */
  getSession(chatId: number, threadAnchorId: number): ThreadSession | undefined {
    return this.sessions.get(this.getKey(chatId, threadAnchorId));
  }

  /**
   * Get all active sessions for a chat.
   */
  getSessionsForChat(chatId: number): ThreadSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.chatId === chatId
    );
  }

  /**
   * Get all active sessions.
   */
  getAllSessions(): ThreadSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get count of running sessions.
   */
  getRunningCount(chatId?: number): number {
    const sessions = chatId
      ? this.getSessionsForChat(chatId)
      : this.getAllSessions();
    return sessions.filter((s) => s.isRunning).length;
  }

  /**
   * Stop a specific session.
   */
  async stopSession(
    chatId: number,
    threadAnchorId: number
  ): Promise<"stopped" | "pending" | false> {
    const session = this.getSession(chatId, threadAnchorId);
    if (!session) {
      return false;
    }
    return session.stop();
  }

  /**
   * Stop all sessions for a chat (or all sessions if chatId not provided).
   */
  async stopAllSessions(chatId?: number): Promise<number> {
    const sessions = chatId
      ? this.getSessionsForChat(chatId)
      : this.getAllSessions();

    let stoppedCount = 0;
    for (const session of sessions) {
      const result = await session.stop();
      if (result) {
        stoppedCount++;
      }
    }
    return stoppedCount;
  }

  /**
   * Remove a session.
   */
  removeSession(chatId: number, threadAnchorId: number): boolean {
    const key = this.getKey(chatId, threadAnchorId);
    const removed = this.sessions.delete(key);
    if (removed) {
      console.log(
        `[SessionManager] Removed session for thread ${threadAnchorId}`
      );
      this.saveSessions();
    }
    return removed;
  }

  /**
   * Clear all sessions for a chat.
   */
  clearSessionsForChat(chatId: number): number {
    const sessions = this.getSessionsForChat(chatId);
    let count = 0;
    for (const session of sessions) {
      if (this.removeSession(chatId, session.threadAnchorId)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Cleanup inactive sessions (older than timeout).
   */
  cleanupInactiveSessions(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const session of this.sessions.values()) {
      if (session.isRunning) {
        continue;
      }

      const lastActivity = session.lastActivity?.getTime() || 0;
      if (now - lastActivity > SESSION_TIMEOUT_MS) {
        this.removeSession(session.chatId, session.threadAnchorId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[SessionManager] Cleaned up ${cleaned} inactive sessions`);
    }

    return cleaned;
  }

  /**
   * Save sessions to disk.
   */
  saveSessions(): void {
    try {
      const data: PersistedSessions = {
        version: 1,
        sessions: Array.from(this.sessions.values())
          .filter((s) => s.sessionId) // Only save sessions with valid sessionId
          .map((s) => s.toData()),
      };

      Bun.write(SESSIONS_FILE, JSON.stringify(data, null, 2));
      console.log(
        `[SessionManager] Saved ${data.sessions.length} sessions to disk`
      );
    } catch (error) {
      console.error(`[SessionManager] Failed to save sessions: ${error}`);
    }
  }

  /**
   * Load sessions from disk.
   */
  loadSessions(): void {
    try {
      if (!existsSync(SESSIONS_FILE)) {
        console.log("[SessionManager] No saved sessions file found");
        return;
      }

      const text = readFileSync(SESSIONS_FILE, "utf-8");
      const data: PersistedSessions = JSON.parse(text);

      if (data.version !== 1) {
        console.warn(
          `[SessionManager] Unknown sessions file version: ${data.version}`
        );
        return;
      }

      for (const sessionData of data.sessions) {
        const session = ThreadSession.fromData(sessionData);
        const key = this.getKey(session.chatId, session.threadAnchorId);
        this.sessions.set(key, session);
      }

      console.log(
        `[SessionManager] Loaded ${data.sessions.length} sessions from disk`
      );
    } catch (error) {
      console.error(`[SessionManager] Failed to load sessions: ${error}`);
    }
  }

  /**
   * Get persisted sessions (for resume UI).
   */
  getPersistedSessions(chatId: number): ThreadSessionData[] {
    try {
      if (!existsSync(SESSIONS_FILE)) {
        return [];
      }

      const text = readFileSync(SESSIONS_FILE, "utf-8");
      const data: PersistedSessions = JSON.parse(text);

      return data.sessions
        .filter((s) => s.chat_id === chatId && s.session_id)
        .sort(
          (a, b) =>
            new Date(b.last_activity).getTime() -
            new Date(a.last_activity).getTime()
        );
    } catch {
      return [];
    }
  }

  /**
   * Resume a session from persisted data.
   */
  resumeSession(chatId: number, threadAnchorId: number): ThreadSession | null {
    // Check if already in memory
    const existing = this.getSession(chatId, threadAnchorId);
    if (existing) {
      return existing;
    }

    // Try to load from disk
    const persisted = this.getPersistedSessions(chatId);
    const sessionData = persisted.find(
      (s) => s.thread_anchor_id === threadAnchorId
    );

    if (!sessionData) {
      return null;
    }

    const session = ThreadSession.fromData(sessionData);
    const key = this.getKey(chatId, threadAnchorId);
    this.sessions.set(key, session);

    console.log(
      `[SessionManager] Resumed session for thread ${threadAnchorId}`
    );

    return session;
  }
}

// Export singleton instance
export const sessionManager = new SessionManager();

// Load sessions on startup
sessionManager.loadSessions();

// Cleanup inactive sessions periodically (every 5 minutes)
setInterval(
  () => {
    sessionManager.cleanupInactiveSessions();
  },
  5 * 60 * 1000
);
