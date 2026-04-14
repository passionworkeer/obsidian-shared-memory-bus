// ops/extraction-prompt.mjs
// ESM module - builds extraction prompt for LLM

let USER_IDENTITY_CONTEXT = "";

export function setUserIdentityContext(ctx) {
  USER_IDENTITY_CONTEXT = ctx;
}

export function buildExtractionPrompt(transcript, projectContext = "") {
  const sections = [];

  if (USER_IDENTITY_CONTEXT) {
    sections.push(`## User Identity\n${USER_IDENTITY_CONTEXT}`);
  }

  if (projectContext) {
    sections.push(`## Project Context\n${projectContext}`);
  }

  sections.push(`## Transcript\n${transcript}`);

  const prompt = `${sections.join('\n\n')}

---

Please analyze the transcript above and output an XML extraction result with the following structure:

\`\`\`xml
<extraction>
  <session_type>bugfix|feature|refactor|discovery|docs|chore</session_type>
  <confidence>0.0-1.0</confidence>
  <facts>
    <fact type="user|project">
      <content>事实描述（中文，30-200字）</content>
      <scope>user|project</scope>
    </fact>
    ...
  </facts>
  <decisions>
    <decision>关键决策及其原因</decision>
    ...
  </decisions>
  <entities>
    <entity type="person|project|concept">
      <name>实体名称</name>
      <context>上下文说明</context>
    </entity>
    ...
  </entities>
</extraction>
\`\`\``;

  return prompt;
}

export const SESSION_TYPE_VALUES = new Set([
  "bugfix",
  "feature",
  "refactor",
  "discovery",
  "docs",
  "chore"
]);
