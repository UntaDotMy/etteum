import { describe, expect, test } from "bun:test";
import { KiroProvider } from "../../src/proxy/providers/kiro";
import type { ChatCompletionRequest } from "../../src/proxy/providers/base";
import type { Account } from "../../src/db/schema";

/**
 * Test harness that intercepts the outgoing Kiro request body instead of
 * hitting the network, so we can assert on the conversationState we build.
 */
class CapturingKiroProvider extends KiroProvider {
  public lastBody: any = null;

  protected override async fetchWithTimeout(_url: string, init: RequestInit): Promise<Response> {
    this.lastBody = JSON.parse(String(init.body));
    // Minimal non-eventstream JSON response so parseResponse succeeds.
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function fakeAccount(): Account {
  return {
    tokens: JSON.stringify({ access_token: "test-token", profile_arn: "arn:test" }),
  } as unknown as Account;
}

/** Roles in history + the current turn, for alternation assertions. */
function turnRoles(body: any): string[] {
  const history: any[] = body.conversationState.history;
  const roles = history.map((h) => (h.userInputMessage ? "user" : "assistant"));
  roles.push("user"); // currentMessage is always a userInputMessage
  return roles;
}

describe("Kiro history construction", () => {
  test("request ending in a system message does not duplicate the current user turn", async () => {
    const provider = new CapturingKiroProvider();
    const request: ChatCompletionRequest = {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: "first question" },
        { role: "system", content: "system reminder A" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "system", content: "system reminder B" },
      ],
    };

    const result = await provider.chatCompletion(fakeAccount(), request);
    expect(result.success).toBe(true);

    const body = provider.lastBody;
    const history: any[] = body.conversationState.history;

    // History should be [user, assistant] — the trailing system message must not
    // promote "second question" into both history and the current turn.
    expect(history.length).toBe(2);
    expect(history[0].userInputMessage).toBeDefined();
    expect(history[1].assistantResponseMessage).toBeDefined();

    // Current turn is the last real user message.
    expect(body.conversationState.currentMessage.userInputMessage.content).toContain("second question");

    // Conversation must strictly alternate user -> assistant -> ... -> user.
    const roles = turnRoles(body);
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1]);
    }
  });

  test("all system messages are merged into the current turn content", async () => {
    const provider = new CapturingKiroProvider();
    const request: ChatCompletionRequest = {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "system", content: "system one" },
        { role: "user", content: "hello" },
        { role: "system", content: "system two" },
      ],
    };

    await provider.chatCompletion(fakeAccount(), request);
    const content = provider.lastBody.conversationState.currentMessage.userInputMessage.content as string;
    expect(content).toContain("system one");
    expect(content).toContain("system two");
    expect(content).toContain("hello");
  });

  test("consecutive same-role turns are merged so history alternates", async () => {
    const provider = new CapturingKiroProvider();
    const request: ChatCompletionRequest = {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
        { role: "user", content: "d" },
      ],
    };

    await provider.chatCompletion(fakeAccount(), request);
    const roles = turnRoles(provider.lastBody);
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1]);
    }
  });
});
