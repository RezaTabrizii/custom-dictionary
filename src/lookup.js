import Anthropic from "@anthropic-ai/sdk";

const PARTS_OF_SPEECH = [
  "noun", "verb", "adjective", "adverb", "pronoun", "preposition",
  "conjunction", "interjection", "determiner", "phrasal verb", "idiom", "other",
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "word", "phonetic", "senses"],
  properties: {
    found: { type: "boolean" },
    word: { type: "string" },
    phonetic: { type: "string" },
    senses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["partOfSpeech", "persian", "definition", "example"],
        properties: {
          partOfSpeech: { type: "string", enum: PARTS_OF_SPEECH },
          persian: { type: "array", items: { type: "string" } },
          definition: { type: "string" },
          example: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM = `You are an English to Persian (Farsi) dictionary for a Persian speaker learning English.

Given an English word or short phrase, return its common senses, most common first.
The input may come from speech recognition, so fix obvious misspellings or mishearings and return the corrected headword in "word" (lowercase unless it is a proper noun).

For each sense:
- partOfSpeech: its grammatical type.
- persian: one to four natural Persian equivalents for this sense, in Persian script.
- definition: a short, plain English definition a learner can understand.
- example: one natural English sentence that uses the word in this sense.

Give one sense per distinct meaning, and a separate sense for each part of speech. Skip rare or archaic senses; usually 1 to 6 senses is right.
phonetic: the IPA pronunciation in slashes, for example /ˈwɔːtər/.
If the input is not an English word or phrase, set found to false and return an empty senses array.`;

export class LookupError extends Error {}

export function createLookup({ client = new Anthropic(), model = "claude-opus-5-5" } = {}) {
  return async function lookup(word) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: word }],
    });

    if (response.stop_reason === "refusal") {
      throw new LookupError("This word could not be looked up.");
    }
    const text = response.content.findLast((block) => block.type === "text")?.text;
    if (!text) throw new LookupError("The dictionary returned an empty answer. Try again.");

    const result = JSON.parse(text);
    if (!result.found || result.senses.length === 0) {
      throw new LookupError(`"${word}" doesn't look like an English word.`);
    }
    return { word: result.word.trim() || word, phonetic: result.phonetic, senses: result.senses };
  };
}
