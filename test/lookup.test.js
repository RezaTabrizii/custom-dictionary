import { test } from "node:test";
import assert from "node:assert/strict";
import { createLookup, LookupError } from "../src/lookup.js";

const fakeClient = (response) => {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params) => (calls.push(params), response) } },
  };
};

const reply = (json, extra = {}) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(json) }],
  ...extra,
});

test("returns the corrected word and its senses", async () => {
  const client = fakeClient(reply({
    found: true, word: "receive", phonetic: "/rɪˈsiːv/",
    senses: [{ partOfSpeech: "verb", persian: ["دریافت کردن"], definition: "To get something.", example: "I received a letter." }],
  }));
  const entry = await createLookup({ client })("recieve");
  assert.equal(entry.word, "receive");
  assert.equal(entry.senses[0].persian[0], "دریافت کردن");
  assert.equal(client.calls[0].messages[0].content, "recieve");
  assert.equal(client.calls[0].output_config.format.type, "json_schema");
});

test("rejects input that is not an English word", async () => {
  const client = fakeClient(reply({ found: false, word: "", phonetic: "", senses: [] }));
  await assert.rejects(createLookup({ client })("qwzx"), LookupError);
});

test("turns a refusal into a friendly error", async () => {
  const client = fakeClient({ stop_reason: "refusal", content: [] });
  await assert.rejects(createLookup({ client })("word"), LookupError);
});
