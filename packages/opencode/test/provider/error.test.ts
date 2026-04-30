import { describe, expect, test } from "bun:test"
import { ProviderID } from "@/provider/schema"
import { ProviderError } from "@/provider/error"

describe("provider error parsing", () => {
  test("summarizes generic malformed stream JSON errors", () => {
    const raw = `event: response.created\ndata: {"type":"response.created","response":"${"x".repeat(1200)}`
    const parsed = ProviderError.parseGenericError({
      providerID: ProviderID.make("test"),
      error: new Error(`JSON parsing failed: Text: ${raw}`),
    })

    expect(parsed?.type).toBe("api_error")
    if (parsed?.type !== "api_error") throw new Error("expected api_error")
    expect(parsed.message).toBe("Provider stream returned malformed JSON (unterminated response event).")
    expect(parsed.metadata?.cause).toBe("malformed_stream_json")
    expect(parsed.metadata?.responseBytes).toBe(String(raw.length))
    expect(parsed.metadata?.responsePreview.length).toBeLessThan(raw.length)
    expect(parsed.responseBody?.length).toBeLessThan(raw.length)
  })

  test("summarizes standalone unterminated JSON errors", () => {
    for (const message of [
      "Unterminated string",
      "SyntaxError: Unterminated string",
      "Unterminated string in JSON at position 42",
      "SyntaxError: Unterminated string in JSON at position 42",
      "Unterminated string in JSON at line 1 column 1200",
      "SyntaxError: Unterminated string in JSON at line 1 column 1200",
    ]) {
      const parsed = ProviderError.parseGenericError({
        providerID: ProviderID.make("test"),
        error: new Error(message),
      })

      expect(parsed?.type).toBe("api_error")
      if (parsed?.type !== "api_error") throw new Error("expected api_error")
      expect(parsed.metadata?.parseError).toBe(message.replace(/^SyntaxError:\s*/, ""))
    }
  })

  test("does not copy raw provider body into parse error metadata", () => {
    const raw = `event: response.created data: ${"x".repeat(1200)}`
    const parsed = ProviderError.parseGenericError({
      providerID: ProviderID.make("test"),
      error: new Error(`JSON parsing failed: Text: ${raw}`),
    })

    expect(parsed?.type).toBe("api_error")
    if (parsed?.type !== "api_error") throw new Error("expected api_error")
    expect(parsed.metadata?.parseError).toBeUndefined()
    expect(parsed.metadata?.responseBytes).toBe(String(raw.length))
    expect(parsed.metadata?.responsePreview).not.toContain("x".repeat(600))
  })

  test("keeps parse error metadata separate from raw provider body", () => {
    const raw = `event: response.created data: ${"x".repeat(1200)}`
    const parsed = ProviderError.parseGenericError({
      providerID: ProviderID.make("test"),
      error: new Error(`JSON parsing failed: Unterminated string in JSON at position 42 Text: ${raw}`),
    })

    expect(parsed?.type).toBe("api_error")
    if (parsed?.type !== "api_error") throw new Error("expected api_error")
    expect(parsed.metadata?.parseError).toBe("Unterminated string in JSON at position 42")
    expect(parsed.metadata?.responseBytes).toBe(String(raw.length))
    expect(parsed.metadata?.responsePreview.length).toBeLessThan(raw.length)
  })
})
