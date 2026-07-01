// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Labeled fixture for the AUTO-MEMORY recall-quality harness (§9b dogfood gate proxy).
//
// The question it answers: if recall is allowed to surface AUTO-captured memory (not just 🟢 reviewed),
// does it HELP (a relevant fact the user told a past session now surfaces) or HURT (noise / stale /
// misleading entries get injected, wasting tokens and eroding "别信绿")? The Commander's instinct is that
// raw-narrative auto memory is low-signal → recalling it is a net negative. This fixture makes that
// measurable instead of a guess.
//
// Each memory has a lane + (for auto) a quality label the harness scores against:
//   lane 'reviewed'  → human-promoted; SHOULD surface when relevant (the recall we already trust).
//   lane 'auto'      → machine-captured; quality ∈ { useful | noise | misleading }.
//       useful      = a genuine fact worth recalling → surfacing it is a GAIN.
//       noise       = low-signal narrative fragment → surfacing it is HARM (token waste).
//       misleading  = stale/contradicted/log-like → surfacing it is WORSE-than-noise HARM.
//
// Each prompt declares the entry ids that SHOULD surface (relevant) and MUST-NOT (traps). An off-topic
// prompt must surface nothing at all (recall stays silent — earns its tokens or says nothing). Mixed
// zh/EN on purpose (cross-language recall is a known-weak lane).

export const FIXTURE = {
  source: 'in-repo labeled auto-memory recall-quality fixture (reviewed vs auto: useful/noise/misleading)',
  memories: [
    // ── reviewed (human-promoted) — the trusted baseline ──
    { id: 'r_release', lane: 'reviewed', text: 'Decision: ship release notes weekly, every Friday, owned by the platform team.' },
    { id: 'r_pg_tz', lane: 'reviewed', text: 'Postgres timestamptz stores UTC internally; convert to local time only at the application edge.' },
    { id: 'r_pref_cold', lane: 'reviewed', text: '用户偏好：配色用低饱和冷色调，不要高对比荧光色。' },
    { id: 'r_deploy', lane: 'reviewed', text: 'Production deploys are blue-green; rollback is an instant traffic switch to the previous slot.' },

    // ── auto · USEFUL — a real fact captured from a session; recalling it is a genuine gain ──
    { id: 'a_ratelimit', lane: 'auto', quality: 'useful', text: 'The vendor API rate limit was raised to 500 requests per minute per key.' },
    { id: 'a_node_req', lane: 'auto', quality: 'useful', text: 'The runtime requires Node 22.12+ because it depends on the built-in node:sqlite module.' },
    { id: 'a_pref_font', lane: 'auto', quality: 'useful', text: '用户说中文 SVG 默认用鸿蒙字体（HarmonyOS Sans SC），回退苹方。' },

    // ── auto · NOISE — low-signal session-narrative fragments; recalling them wastes tokens ──
    { id: 'n_ok', lane: 'auto', quality: 'noise', text: 'Assistant: Sure, I can help with that. Let me take a look at the files first.' },
    { id: 'n_did', lane: 'auto', quality: 'noise', text: 'Did: 183 shell commands (ls, cd, cat, echo, grep). Working on it now.' },
    { id: 'n_thanks', lane: 'auto', quality: 'noise', text: 'Great, that works. Thanks! Moving on to the next step now.' },
    { id: 'n_greet', lane: 'auto', quality: 'noise', text: '你好，请问有什么可以帮你的吗？' },

    // ── auto · MISLEADING — stale/contradicted/log-like; surfacing them is worse than noise ──
    { id: 'm_ratelimit_old', lane: 'auto', quality: 'misleading', text: 'The vendor API rate limit is 100 requests per minute per key.' }, // stale: contradicted by a_ratelimit (500)
    { id: 'm_stacktrace', lane: 'auto', quality: 'misleading', text: 'Error: ECONNREFUSED at TCPConnectWrap.afterConnect (net.js:1146:16) — retrying connection to localhost:5432.' },
    { id: 'm_disclaimer', lane: 'auto', quality: 'misleading', text: 'Note: this is a low-weight auto-captured entry; verify before relying. Source: session transcript floor.' }, // self-referential floor noise (feedback-loop shaped)
  ],
  // relevant = ids that SHOULD surface; traps = auto ids that MUST NOT surface for this prompt.
  prompts: [
    { q: 'what is the vendor api rate limit', relevant: ['a_ratelimit'], traps: ['m_ratelimit_old'], kind: 'auto-useful-vs-stale' },
    { q: 'which node version does the runtime need', relevant: ['a_node_req'], traps: [], kind: 'auto-useful' },
    { q: '中文 svg 用什么字体', relevant: ['a_pref_font'], traps: [], kind: 'auto-useful-zh' },
    { q: 'when do we ship release notes', relevant: ['r_release'], traps: [], kind: 'reviewed' },
    { q: 'postgres timezone handling', relevant: ['r_pg_tz'], traps: [], kind: 'reviewed' },
    { q: '配色偏好是什么', relevant: ['r_pref_cold'], traps: [], kind: 'reviewed-zh' },
    { q: 'how do rollbacks work in prod', relevant: ['r_deploy'], traps: [], kind: 'reviewed' },
    // off-topic: recall must stay SILENT — surfacing anything here is pure token-waste harm.
    { q: 'what is the capital of France', relevant: [], traps: ['n_ok', 'n_did', 'n_thanks', 'n_greet', 'm_stacktrace', 'm_disclaimer'], kind: 'off-topic' },
    { q: '帮我写一首诗', relevant: [], traps: ['n_greet', 'n_ok'], kind: 'off-topic-zh' },
  ],
};
