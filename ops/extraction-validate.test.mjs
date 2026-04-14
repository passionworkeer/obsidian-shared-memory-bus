// ops/extraction-validate.test.mjs
// TDD RED phase — tests first, implementation later

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseExtractionXml, meetsQualityBar } from './extraction-validate.mjs';

describe('parseExtractionXml', () => {

  it('parses valid complete XML', () => {
    const xml = `<extraction>
  <session_type>bugfix</session_type>
  <confidence>0.85</confidence>
  <facts>
    <fact type="project"><content>修复了 UTF-16 编码损坏问题</content><scope>project</scope></fact>
  </facts>
  <decisions>
    <decision>使用 ESM 模块替代混用 require</decision>
  </decisions>
  <entities>
    <entity type="project"><name>obsidian-shared-memory-bus</name><context>多 agent 共享记忆系统</context></entity>
  </entities>
</extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.session_type, 'bugfix');
    assert.equal(result.confidence, 0.85);
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0].content, '修复了 UTF-16 编码损坏问题');
    assert.equal(result.facts[0].type, 'project');
    assert.equal(result.facts[0].scope, 'project');
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0], '使用 ESM 模块替代混用 require');
    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0].name, 'obsidian-shared-memory-bus');
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('returns errors for unknown session_type', () => {
    const xml = `<extraction><session_type>unknown</session_type><confidence>0.5</confidence></extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('unknown session_type: unknown')));
  });

  it('returns errors for invalid confidence', () => {
    const xml = `<extraction><session_type>discovery</session_type><confidence>1.5</confidence></extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('confidence must be 0.0-1.0')));
  });

  it('returns valid=false for empty XML', () => {
    const xml = '';
    const result = parseExtractionXml(xml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('empty-xml-response')));
  });

  it('parses multiple facts correctly', () => {
    const xml = `<extraction>
  <session_type>feature</session_type><confidence>0.9</confidence>
  <facts>
    <fact type="user"><content>用户住在深圳</content><scope>user</scope></fact>
    <fact type="project"><content>实现了 Stop Hook 提取引擎</content><scope>project</scope></fact>
  </facts>
  <decisions></decisions>
  <entities></entities>
</extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.facts.length, 2);
    assert.equal(result.facts[0].type, 'user');
    assert.equal(result.facts[0].content, '用户住在深圳');
    assert.equal(result.facts[1].type, 'project');
  });

  it('defaults session_type to discovery when missing', () => {
    const xml = `<extraction><confidence>0.5</confidence></extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.session_type, 'discovery');
  });

  it('defaults confidence to 0.5 when missing', () => {
    const xml = `<extraction><session_type>bugfix</session_type></extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.confidence, 0.5);
  });

  it('returns valid=true for valid XML with no facts', () => {
    const xml = `<extraction><session_type>discovery</session_type><confidence>0.5</confidence><facts></facts><decisions></decisions><entities></entities></extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.valid, true);
    assert.equal(result.facts.length, 0);
  });

  it('rejects negative confidence', () => {
    const xml = `<extraction><session_type>discovery</session_type><confidence>-0.1</confidence></extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('confidence must be 0.0-1.0')));
  });

  it('parses entity with type attribute', () => {
    const xml = `<extraction>
  <session_type>discovery</session_type><confidence>0.5</confidence>
  <facts></facts><decisions></decisions>
  <entities>
    <entity type="person"><name>张三</name><context>项目负责人</context></entity>
  </entities>
</extraction>`;
    const result = parseExtractionXml(xml);
    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0].type, 'person');
    assert.equal(result.entities[0].name, '张三');
    assert.equal(result.entities[0].context, '项目负责人');
  });
});

describe('meetsQualityBar', () => {
  it('returns true when facts >= minFacts', () => {
    const result = { valid: true, facts: [1, 2, 3] };
    assert.equal(meetsQualityBar(result, 1), true);
    assert.equal(meetsQualityBar(result, 3), true);
  });

  it('returns false when facts < minFacts', () => {
    const result = { valid: true, facts: [] };
    assert.equal(meetsQualityBar(result, 1), false);
  });

  it('returns false when valid=false regardless of facts', () => {
    const result = { valid: false, facts: [1, 2, 3] };
    assert.equal(meetsQualityBar(result, 1), false);
  });

  it('returns true when facts exactly equals minFacts', () => {
    const result = { valid: true, facts: ['one'] };
    assert.equal(meetsQualityBar(result, 1), true);
  });
});
