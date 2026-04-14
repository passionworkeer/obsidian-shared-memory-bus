// ops/extraction-validate.mjs
// ESM module - validates and parses XML extraction results

import { SESSION_TYPE_VALUES } from "./extraction-prompt.mjs";

const MAX_FACT_LENGTH = 500;
const MAX_DECISION_LENGTH = 300;
const MAX_ENTITY_CONTEXT_LENGTH = 200;

export function parseExtractionXml(xml) {
  const errors = [];

  if (!xml || xml.trim() === '') {
    return {
      valid: false,
      errors: ['empty-xml-response'],
      session_type: 'discovery',
      confidence: 0.5,
      facts: [],
      decisions: [],
      entities: []
    };
  }

  // Parse session_type
  let sessionTypeMatch = xml.match(/<session_type>([^<]*)<\/session_type>/i);
  let session_type = sessionTypeMatch ? sessionTypeMatch[1].trim() : 'discovery';
  if (!SESSION_TYPE_VALUES.has(session_type)) {
    errors.push(`unknown session_type: ${session_type}`);
  }

  // Parse confidence
  let confidenceMatch = xml.match(/<confidence>([^<]*)<\/confidence>/i);
  let confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5;
  if (isNaN(confidence) || confidence < 0 || confidence > 1) {
    errors.push('confidence must be 0.0-1.0');
  }

  // Parse facts
  const facts = [];
  const factRegex = /<fact(?:\s[^>]*)?>([\s\S]*?)<\/fact>/gi;
  let factMatch;
  while ((factMatch = factRegex.exec(xml)) !== null) {
    const factBlock = factMatch[1];

    // Extract type attribute from <fact ...>
    const factOpenMatch = factMatch[0].match(/<fact(?:\s([^>]*))?>/i);
    let factType = 'project';
    if (factOpenMatch && factOpenMatch[1]) {
      const typeAttrMatch = factOpenMatch[1].match(/type=["']([^"']*)["']/i);
      if (typeAttrMatch) {
        factType = typeAttrMatch[1];
      }
    }

    // Extract content
    const contentMatch = factBlock.match(/<content>([^<]*)<\/content>/i);
    let content = contentMatch ? contentMatch[1].trim() : '';
    if (content.length > MAX_FACT_LENGTH) {
      content = content.substring(0, MAX_FACT_LENGTH);
    }

    // Extract scope
    const scopeMatch = factBlock.match(/<scope>([^<]*)<\/scope>/i);
    const scope = scopeMatch ? scopeMatch[1].trim() : 'project';

    facts.push({ type: factType, content, scope });
  }

  // Parse decisions
  const decisions = [];
  const decisionRegex = /<decision>([^<]*)<\/decision>/gi;
  let decisionMatch;
  while ((decisionMatch = decisionRegex.exec(xml)) !== null) {
    let decision = decisionMatch[1].trim();
    if (decision.length > MAX_DECISION_LENGTH) {
      decision = decision.substring(0, MAX_DECISION_LENGTH);
    }
    decisions.push(decision);
  }

  // Parse entities
  const entities = [];
  const entityRegex = /<entity(?:\s[^>]*)?>([\s\S]*?)<\/entity>/gi;
  let entityMatch;
  while ((entityMatch = entityRegex.exec(xml)) !== null) {
    const entityBlock = entityMatch[1];

    // Extract type attribute
    const entityOpenMatch = entityMatch[0].match(/<entity(?:\s([^>]*))?>/i);
    let entityType = 'concept';
    if (entityOpenMatch && entityOpenMatch[1]) {
      const typeAttrMatch = entityOpenMatch[1].match(/type=["']([^"']*)["']/i);
      if (typeAttrMatch) {
        entityType = typeAttrMatch[1];
      }
    }

    // Extract name
    const nameMatch = entityBlock.match(/<name>([^<]*)<\/name>/i);
    const name = nameMatch ? nameMatch[1].trim() : '';

    // Extract context
    const contextMatch = entityBlock.match(/<context>([^<]*)<\/context>/i);
    let context = contextMatch ? contextMatch[1].trim() : '';
    if (context.length > MAX_ENTITY_CONTEXT_LENGTH) {
      context = context.substring(0, MAX_ENTITY_CONTEXT_LENGTH);
    }

    entities.push({ type: entityType, name, context });
  }

  return {
    valid: errors.length === 0,
    errors,
    session_type,
    confidence,
    facts,
    decisions,
    entities
  };
}

export function meetsQualityBar(result, minFacts = 1) {
  return result.valid && result.facts.length >= minFacts;
}
