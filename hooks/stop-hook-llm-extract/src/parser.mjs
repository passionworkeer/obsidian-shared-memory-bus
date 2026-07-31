// LLM extraction response parser. XML is preferred; JSON is the fallback.

function emptyResult(text = '') {
  return {
    session_type: 'discovery',
    confidence: 0.3,
    facts: [],
    decisions: [],
    entities: [],
    summary: text.slice(0, 200),
  };
}

/**
 * Parse an LLM response into the normalized extraction schema.
 *
 * @param {object|string} raw API response, text block, or serialized payload
 * @returns {{session_type:string,confidence:number,facts:string[],decisions:string[],entities:object[],summary:string}}
 */
export function parseExtraction(raw) {
  let text = '';

  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw?.content)) {
    text = raw.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  } else if (typeof raw?.text === 'string') {
    text = raw.text;
  } else if (typeof raw?.content === 'string') {
    text = raw.content;
  } else {
    try {
      text = JSON.stringify(raw ?? '');
    } catch {
      text = String(raw ?? '');
    }
  }

  const xmlResult = tryXmlParse(text);
  if (xmlResult) return xmlResult;

  const jsonResult = tryJsonParse(text);
  return jsonResult || emptyResult(text);
}

function tryXmlParse(text) {
  try {
    const get = (tag) => {
      const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
      return match ? match[1].replace(/<!--[\s\S]*?-->/g, '').trim() : '';
    };
    const getAll = (tag) => [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
      .map((match) => match[1].trim())
      .filter(Boolean);
    const getEntities = () => [...text.matchAll(/<entity\s+name="([^"]+)"\s+type="([^"]+)"/g)]
      .map((match) => ({ name: match[1].trim(), type: match[2].trim() }));

    const sessionType = get('session_type');
    const facts = getAll('fact');
    if (!sessionType && facts.length === 0) return null;

    return {
      session_type: normalizeSessionType(sessionType),
      confidence: parseConfidence(get('confidence'), 0.5),
      facts,
      decisions: getAll('decision'),
      entities: getEntities(),
      summary: get('summary'),
    };
  } catch {
    return null;
  }
}

function tryJsonParse(text) {
  try {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i)
      || text.match(/```\s*([\s\S]*?)\s*```/);
    const parsed = JSON.parse((jsonMatch ? jsonMatch[1] : text).trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    return {
      session_type: normalizeSessionType(parsed.session_type || ''),
      confidence: parseConfidence(parsed.confidence, 0.5),
      facts: Array.isArray(parsed.facts) ? parsed.facts.filter((value) => typeof value === 'string') : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter((value) => typeof value === 'string') : [],
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.filter((value) => value && typeof value === 'object')
        : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };
  } catch {
    return null;
  }
}

function parseConfidence(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function normalizeSessionType(type) {
  const valid = ['bugfix', 'feature', 'refactor', 'discovery', 'docs', 'chore'];
  const normalized = String(type || '').toLowerCase().trim();
  return valid.includes(normalized) ? normalized : 'discovery';
}
