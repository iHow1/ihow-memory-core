// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory

export const RECALL_QUERY_INTENTS_V1 = [
  'fact', 'preference', 'status', 'temporal', 'recovery', 'unknown',
] as const;

export type RecallQueryIntentV1 = typeof RECALL_QUERY_INTENTS_V1[number];

const MAX_QUERY_CHARS = 8_000;

const RECOVERY = /\b(?:resume|restore|recover|recovery|checkpoint|handoff|runbook|fallback|roll ?back|pick up where)\b|恢复|找回|继续上次|接着上次|断点|检查点|交接|运行手册|回退方案|回滚方案/iu;
const TEMPORAL = /\b(?:when|before|after|since|until|formerly|previously|current(?:ly)? valid|valid (?:at|from|through|until)|replaced?|supersed(?:e[ds]?|ing)|old (?:value|schedule|version)|new (?:value|schedule|version)|schedule|timeline)\b|何时|什么时候|之前|之后|以前|以后|当时|目前有效|当前有效|有效期|失效|过期|替代|取代|被替换|旧(?:值|日程|安排|版本)|新(?:值|日程|安排|版本)|日程|时间线/iu;
const STATUS = /\b(?:status|progress|current state|state of)\b|\bhow (?:is|are) .{0,64}(?:going|progressing)\b|\b(?:is|are|was|were|did|has|have) .{0,64}\b(?:done|complete[ds]?|finished|ready|working|fixed|passed|failed|green)\b|状态|进度|进展|当前情况|现在怎么样|怎么样了|完成了吗|准备好了吗|通过了吗|失败了吗|修好了吗/iu;
const PREFERENCE = /\b(?:prefer|preference|choice|favorite|favourite|tone|style|cadence)\b|偏好|更喜欢|首选|选择|语气|风格|节奏/iu;
const FACT = /\b(?:who|what|where|which|how)\b|谁|什么|哪里|哪儿|哪个|哪些|如何|怎么得知|多少/iu;
const META_CLASSIFICATION = /\b(?:classif(?:y|ication)|label|categor(?:y|ize)|output)\b.{0,80}\b(?:fact|preference|status|temporal|recovery|unknown|intent)\b|(?:分类|标记|标签).{0,40}(?:事实|偏好|状态|时间|恢复|未知|意图)/iu;
const GENERIC = /^(?:help|hello|hi|hey|remember|recall|memory|please|thanks?|你好|您好|帮忙|帮助|记得吗|回忆一下)[.!?。！？]*$/iu;

function stripQuotedData(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyRecallQueryIntentV1(query: string): RecallQueryIntentV1 {
  const normalized = String(query ?? '').slice(0, MAX_QUERY_CHARS).normalize('NFKC').toLowerCase().trim();
  if (!normalized || GENERIC.test(normalized) || META_CLASSIFICATION.test(normalized)) return 'unknown';

  const operative = stripQuotedData(normalized);
  if (!operative || GENERIC.test(operative)) return 'unknown';

  // This order is the frozen mixed-intent precedence, strongest first.
  if (RECOVERY.test(operative)) return 'recovery';
  if (TEMPORAL.test(operative)) return 'temporal';
  if (STATUS.test(operative)) return 'status';
  if (PREFERENCE.test(operative)) return 'preference';
  if (FACT.test(operative)) return 'fact';
  return 'unknown';
}
