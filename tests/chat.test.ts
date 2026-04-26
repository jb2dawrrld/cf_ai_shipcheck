import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateChatMessageInput } from "../src/chat/chat";

describe("validateChatMessageInput", () => {
	it("rejects empty messages", () => {
		const result = validateChatMessageInput("   ");
		assert.equal(result.ok, false);
	});

	it("accepts valid messages", () => {
		const result = validateChatMessageInput("What should I fix first?");
		assert.equal(result.ok, true);
		assert.equal(result.value, "What should I fix first?");
	});
});
