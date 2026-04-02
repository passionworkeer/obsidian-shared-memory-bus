---
name: {{name}}
description: {{description}}
type: {{durable_type}}
durable_type: {{durable_type}}
content_hash: sha256:{{content_hash}}
promotion:
  version: 1
  durable_type: {{durable_type}}
  key: {{slug}}
  reason: {{reason}}
  source_type: {{source_type}}
  source_confidence: 0.5
  promoted_at: {{iso_now}}
provenance:
  original_session: {{session_id}}
  consolidation_pass: 0
lifecycle:
  expires_at: {{expires_at}}
  access_count: 0
  promotion_count: 1
---

# {{title}}

{{content}}
