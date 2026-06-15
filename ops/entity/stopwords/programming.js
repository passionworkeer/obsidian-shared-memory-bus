// ops/entity/stopwords/programming.js
//
// Programming-language keywords and type-system tokens. These appear
// frequently in source-code snippets embedded in conversation logs but
// are never entities worth extracting.

export const PROGRAMMING_STOPWORDS = [
  "return", "print", "def", "class", "import", "function", "const", "let", "var",
  "async", "await", "try", "catch", "throw", "finally",
  "switch", "case", "break", "continue", "while", "for", "else", "elif",
  "yield", "raise", "pass", "global", "nonlocal", "lambda",
  "static", "public", "private", "protected", "final", "abstract",
  "extends", "implements", "void", "null", "undefined", "typeof", "instanceof",
  "self", "cls", "kwargs", "arg",
  "str", "int", "bool", "dict",
];
