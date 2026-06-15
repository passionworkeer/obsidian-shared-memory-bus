// ops/entity/stopwords/prose.js
//
// Common prose filler words and abstract nouns that appear as subjects
// in conversation but are too generic to be useful entities. Also includes
// "tech-abstract" tokens (stack/layer/mode/test) that are too generic to
// distinguish from one another without additional context.

export const PROSE_STOPWORDS = [
  // Common prose filler
  "step", "usage", "run", "check", "find", "add", "set", "list", "args",
  "path", "file", "name", "note", "example", "option", "result",
  "error", "warning", "info", "returns", "raises",
  "item", "key", "value", "type",
  // Abstract nouns that appear as subjects but aren't entities
  "system", "agent", "agents", "tool", "tools", "memory", "model", "models",
  "network", "networks", "training", "inference", "data", "content",
  "thing", "things", "way", "ways", "time", "times", "day", "days",
  "part", "parts", "point", "points",
  "idea", "ideas", "fact", "facts", "sense", "question", "answer",
  "reason", "number", "version",
  "people", "person", "something", "nothing", "everything", "anything",
  "someone", "everyone",
  // Tech-abstract that are too generic
  "stack", "layer", "mode", "test", "stop", "start", "copy", "move",
  "source", "target", "output", "outputs", "input", "inputs",
  "records", "record", "entry", "entries",
  // Verbs commonly used in tutorial-style prose
  "use", "get", "got", "make", "made", "take", "put", "come", "go",
  "see", "know", "think",
];
