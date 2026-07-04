import { Hono } from "hono";
import { getSession, listSessions, forwardInput, cancelSession } from "../auth/browserSession";

export const browserSessionRouter = new Hono();

/**
 * GET /api/browser-sessions — list active browser sessions (for the session
 * list sidebar on the Browser Logs page).
 */
browserSessionRouter.get("/", (c) => {
  const sessions = listSessions().map((s) => ({
    sessionId: s.sessionId,
    accountId: s.accountId,
    email: s.email,
    provider: s.provider,
    phase: s.phase,
    lastMessage: s.lastMessage,
    terminal: s.terminal,
    hasChallenge: !!s.challenge,
    startedAt: s.startedAt,
  }));
  return c.json({ sessions });
});

/**
 * GET /api/browser-session/:sessionId — current session state (phase, challenge,
 * last frame info). The frontend polls this for session status.
 */
browserSessionRouter.get("/:sessionId", (c) => {
  const sid = c.req.param("sessionId");
  const s = getSession(sid);
  if (!s) return c.json({ error: "Session not found" }, 404);
  return c.json({
    sessionId: s.sessionId,
    accountId: s.accountId,
    email: s.email,
    provider: s.provider,
    phase: s.phase,
    lastMessage: s.lastMessage,
    terminal: s.terminal,
    challenge: s.challenge,
    lastFrameFormat: s.lastFrameFormat,
    lastFrameTime: s.lastFrameTime,
    startedAt: s.startedAt,
  });
});

/**
 * GET /api/browser-session/:sessionId/frames — SSE stream of browser screenshots.
 * Polls the session's lastFrame every ~500ms and sends it as an SSE event.
 * Closes when the session becomes terminal.
 */
browserSessionRouter.get("/:sessionId/frames", (c) => {
  const sid = c.req.param("sessionId");
  const s = getSession(sid);
  if (!s) return c.json({ error: "Session not found" }, 404);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let lastSentTime = 0;
      const sessionId = sid;

      const sendFrame = () => {
        const session = getSession(sessionId);
        if (!session) {
          controller.close();
          return false;
        }
        if (session.terminal && session.phase !== "complete") {
          controller.close();
          return false;
        }
        // Only send if there's a new frame.
        if (session.lastFrame && session.lastFrameTime > lastSentTime) {
          lastSentTime = session.lastFrameTime;
          const data = JSON.stringify({ base64: session.lastFrame, format: session.lastFrameFormat });
          controller.enqueue(enc.encode(`data: ${data}\n\n`));
        }
        return true;
      };

      // Send an initial connected event.
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ connected: true })}\n\n`));

      const interval = setInterval(() => {
        if (!sendFrame()) clearInterval(interval);
      }, 500);

      // Clean up on cancel.
      c.req.raw.signal?.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

/**
 * POST /api/browser-session/:sessionId/input — forward mouse/keyboard input to
 * the running browser. Body: {type:"pointer",x,y,action} or {type:"key",text,code,action}
 */
browserSessionRouter.post("/:sessionId/input", async (c) => {
  const sid = c.req.param("sessionId");
  const body = await c.req.json().catch(() => ({}));
  const ok = forwardInput(sid, body);
  return c.json({ success: ok });
});

/**
 * POST /api/browser-session/:sessionId/captcha — submit a captcha answer.
 * Body: {answer:"text"}
 */
browserSessionRouter.post("/:sessionId/captcha", async (c) => {
  const sid = c.req.param("sessionId");
  const body = await c.req.json().catch(() => ({}));
  if (!body.answer) return c.json({ error: "answer is required" }, 400);
  const ok = forwardInput(sid, { answer: body.answer });
  return c.json({ success: ok });
});

/**
 * POST /api/browser-session/:sessionId/cancel — cancel the running session.
 */
browserSessionRouter.post("/:sessionId/cancel", (c) => {
  const sid = c.req.param("sessionId");
  const ok = cancelSession(sid);
  return c.json({ success: ok });
});
