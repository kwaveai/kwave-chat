import { describe, expect, it, vi } from "vitest";
import { handleKwvInteractive, parseKwvPayload, type KwvInteractiveContext } from "./handler.js";

const SHORT_ID = "0123456789abcdef0123456789abcdef";
const ENV = {
  KWAVE_LOGISTICS_CONFIRM_URL: "https://kwave.test/api/logistics/channel-confirm",
  KWAVE_LOGISTICS_CONFIRM_BEARER: "company-1.deadbeef",
} as NodeJS.ProcessEnv;

function makeCtx(overrides?: {
  senderId?: string;
  isAuthorizedSender?: boolean;
  payload?: string;
}) {
  const respond = {
    editMessage: vi.fn(async () => {}),
    clearButtons: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
  const ctx: KwvInteractiveContext = {
    senderId: overrides?.senderId ?? "ada",
    accountId: "acct-1",
    auth: { isAuthorizedSender: overrides?.isAuthorizedSender ?? true },
    callback: { namespace: "kwv", payload: overrides?.payload ?? `a:${SHORT_ID}` },
    respond,
  };
  return { ctx, respond };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(response: Response | (() => Promise<never>)) {
  return vi.fn(async () => {
    if (typeof response === "function") {
      return response();
    }
    return response;
  }) as unknown as typeof fetch;
}

const APPROVERS = ["ada"];

describe("parseKwvPayload", () => {
  it("parses approve and cancel", () => {
    expect(parseKwvPayload(`a:${SHORT_ID}`)).toEqual({ kind: "approve", shortId: SHORT_ID });
    expect(parseKwvPayload(`c:${SHORT_ID}`)).toEqual({ kind: "cancel", shortId: SHORT_ID });
  });
  it("rejects bad action, bad shortId, and missing colon", () => {
    expect(parseKwvPayload(`x:${SHORT_ID}`).kind).toBe("invalid");
    expect(parseKwvPayload("a:not-hex").kind).toBe("invalid");
    expect(parseKwvPayload("a:0123").kind).toBe("invalid");
    expect(parseKwvPayload(SHORT_ID).kind).toBe("invalid");
  });
});

describe("handleKwvInteractive - authorization gate", () => {
  it("denies a channel-unauthorized sender and never calls the confirm door", async () => {
    const { ctx, respond } = makeCtx({ isAuthorizedSender: false });
    const fetchImpl = makeFetch(jsonResponse({ ok: true, status: "executed" }));

    await handleKwvInteractive(ctx, { getApprovers: () => APPROVERS, fetchImpl, env: ENV });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledWith({ text: expect.stringContaining("not authorized") });
    expect(respond.editMessage).not.toHaveBeenCalled();
  });

  it("denies a sender not on the approver list", async () => {
    const { ctx, respond } = makeCtx({ senderId: "mallory" });
    const fetchImpl = makeFetch(jsonResponse({ ok: true, status: "executed" }));

    await handleKwvInteractive(ctx, { getApprovers: () => APPROVERS, fetchImpl, env: ENV });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalled();
  });

  it("denies when the approver list is empty (fail-closed, no wildcard)", async () => {
    const { ctx, respond } = makeCtx();
    const fetchImpl = makeFetch(jsonResponse({ ok: true, status: "executed" }));

    await handleKwvInteractive(ctx, { getApprovers: () => [], fetchImpl, env: ENV });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalled();
  });

  it("honors an explicit '*' approver as an opt-in wildcard", async () => {
    const { ctx } = makeCtx();
    const fetchImpl = makeFetch(jsonResponse({ ok: true, status: "executed" }));

    await handleKwvInteractive(ctx, { getApprovers: () => ["*"], fetchImpl, env: ENV });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed payload without contacting the confirm door", async () => {
    const { ctx, respond } = makeCtx({ payload: "a:not-a-real-id" });
    const fetchImpl = makeFetch(jsonResponse({ ok: true, status: "executed" }));

    await handleKwvInteractive(ctx, { getApprovers: () => APPROVERS, fetchImpl, env: ENV });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(respond.reply).toHaveBeenCalledWith({ text: expect.stringContaining("invalid") });
  });
});

describe("handleKwvInteractive - approve/cancel execution", () => {
  it("approves: POSTs decision=approve and reports executed", async () => {
    const { ctx, respond } = makeCtx();
    const fetchImpl = makeFetch(jsonResponse({ ok: true, status: "executed" }));

    await handleKwvInteractive(ctx, { getApprovers: () => APPROVERS, fetchImpl, env: ENV });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(ENV.KWAVE_LOGISTICS_CONFIRM_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${ENV.KWAVE_LOGISTICS_CONFIRM_BEARER}`,
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      shortId: SHORT_ID,
      decision: "approve",
    });
    expect(respond.editMessage).toHaveBeenCalledWith({ text: expect.stringContaining("Approved") });
    expect(respond.clearButtons).toHaveBeenCalled();
  });

  it("cancels: POSTs decision=cancel and reports cancelled", async () => {
    const { ctx, respond } = makeCtx({ payload: `c:${SHORT_ID}` });
    const fetchImpl = makeFetch(jsonResponse({ ok: true, status: "cancelled" }));

    await handleKwvInteractive(ctx, { getApprovers: () => APPROVERS, fetchImpl, env: ENV });

    expect(
      JSON.parse(
        ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit)
          .body as string,
      ),
    ).toEqual({ shortId: SHORT_ID, decision: "cancel" });
    expect(respond.editMessage).toHaveBeenCalledWith({
      text: expect.stringContaining("Cancelled"),
    });
  });

  it("maps already-done, expired, and error statuses", async () => {
    for (const [status, needle] of [
      ["already-done", "Already completed"],
      ["expired", "Expired"],
      ["error", "Failed"],
    ] as const) {
      const { ctx, respond } = makeCtx();
      const fetchImpl = makeFetch(jsonResponse({ ok: false, status }));
      await handleKwvInteractive(ctx, { getApprovers: () => APPROVERS, fetchImpl, env: ENV });
      expect(respond.editMessage).toHaveBeenCalledWith({ text: expect.stringContaining(needle) });
    }
  });

  it("surfaces a 401 from the confirm door as an auth failure", async () => {
    const { ctx, respond } = makeCtx();
    const fetchImpl = makeFetch(new Response("", { status: 401 }));

    await handleKwvInteractive(ctx, { getApprovers: () => APPROVERS, fetchImpl, env: ENV });

    expect(respond.editMessage).toHaveBeenCalledWith({
      text: expect.stringContaining("auth failed"),
    });
  });

  it("surfaces a transport error", async () => {
    const { ctx, respond } = makeCtx();
    const fetchImpl = makeFetch(async () => {
      throw new Error("network down");
    });

    await handleKwvInteractive(ctx, { getApprovers: () => APPROVERS, fetchImpl, env: ENV });

    expect(respond.editMessage).toHaveBeenCalledWith({
      text: expect.stringContaining("Could not reach"),
    });
  });

  it("does nothing but explain when the confirm door env is missing", async () => {
    const { ctx, respond } = makeCtx();
    const fetchImpl = makeFetch(jsonResponse({ ok: true, status: "executed" }));

    await handleKwvInteractive(ctx, {
      getApprovers: () => APPROVERS,
      fetchImpl,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(respond.editMessage).toHaveBeenCalledWith({
      text: expect.stringContaining("not configured"),
    });
  });
});
