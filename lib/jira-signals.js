'use strict';
// Which Jira tickets a prompt worked on, read from what Copilot logged: the prompt text,
// Jira tool calls (arguments and results) and the git branch. Pure functions, no I/O.

const KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

/** Every ticket-shaped key in a string, in order, without repeats. */
function keysIn(text) {
  return [...new Set(String(text ?? '').match(KEY) || [])];
}

// Argument names that hold a ticket key in the Atlassian tools (and jira.sh calls).
const KEY_ARGS = ['issueIdOrKey', 'issueKey', 'issue_key', 'key', 'parent', 'parentKey', 'epicKey', 'issue'];

/** Ticket keys named in a Jira tool call's arguments, plus a created ticket's parent link. */
function argKeys(args) {
  const out = [];
  const a = args && typeof args === 'object' ? args : {};
  for (const name of KEY_ARGS) if (typeof a[name] === 'string') out.push(...keysIn(a[name]));
  if (typeof a.jql === 'string') out.push(...keysIn(a.jql));
  return [...new Set(out)];
}

const isJiraTool = (name) => /jira|atlassian/i.test(String(name ?? ''));

/** {key, type, parent, parentType, summary} of one Jira issue object (REST shape), or null. */
function issueMeta(j) {
  if (!j || !j.key || !j.fields) return null;
  const f = j.fields;
  const p = f.parent;
  return {
    key: j.key, type: f.issuetype && f.issuetype.name || null, summary: f.summary || null,
    parent: p && p.key || null, parentType: p && p.fields && p.fields.issuetype && p.fields.issuetype.name || null,
    parentSummary: p && p.fields && p.fields.summary || null,
  };
}

/** Every issue a lookup or search result holds: Copilot's plain issue object, or Claude's Atlassian
 *  connector shape {issues: {nodes: [...]}}, or an array. Tolerates truncated JSON by falling back to patterns. */
function parseIssues(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j
      : j && j.issues && Array.isArray(j.issues.nodes) ? j.issues.nodes
        : j && Array.isArray(j.issues) ? j.issues
          : j && Array.isArray(j.nodes) ? j.nodes : [j];
    return list.map(issueMeta).filter(Boolean);
  } catch { /* fall through */ }
  const key = /^\s*\{[^]*?"key":"([A-Z][A-Z0-9]+-\d+)"/.exec(text);
  if (!key) return [];
  const par = /"parent":\{"id":"\d+","key":"([A-Z][A-Z0-9]+-\d+)"/.exec(text);
  return [{ key: key[1], type: null, summary: null, parent: par ? par[1] : null, parentType: null, parentSummary: null }];
}

/** The first issue of a result, or null. */
const parseIssue = (content) => parseIssues(content)[0] || null;

/** {key} of a ticket a create call produced. */
function createdKey(content) {
  const m = /"key":"([A-Z][A-Z0-9]+-\d+)"/.exec(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
  return m ? m[1] : null;
}

/** Collects the signals of one prompt as its events stream by. */
class PromptJira {
  constructor() { this.toolKeys = {}; this.meta = {}; }

  /** A tool call started: count the ticket keys in its arguments. */
  start(toolName, args) {
    if (!isJiraTool(toolName)) return null;
    const keys = argKeys(args);
    for (const k of keys) this.toolKeys[k] = (this.toolKeys[k] || 0) + 1;
    return { keys, args };
  }

  /** The matching result arrived. */
  complete(toolName, started, content) {
    if (!started) return;
    if (/createJiraIssue/i.test(toolName)) {
      const child = createdKey(content);
      const parent = started.args && typeof started.args.parent === 'string' ? started.args.parent : null;
      if (child) {
        this.toolKeys[child] = (this.toolKeys[child] || 0) + 1;
        this.meta[child] = { ...this.meta[child], p: parent || (this.meta[child] || {}).p || null,
          t: started.args.issueTypeName || null, s: started.args.summary ? String(started.args.summary).slice(0, 120) : null };
      }
      return;
    }
    if (!/(get|search)JiraIssue/i.test(toolName)) return;
    for (const issue of parseIssues(content)) {
      const m = this.meta[issue.key] = { ...this.meta[issue.key] };
      if (issue.type) m.t = issue.type;
      if (issue.summary) m.s = issue.summary.slice(0, 120);
      if (issue.parent) m.p = issue.parent;
      if (issue.parent && issue.parentType) this.meta[issue.parent] = { ...this.meta[issue.parent], t: issue.parentType,
        ...(issue.parentSummary ? { s: issue.parentSummary.slice(0, 120) } : {}) };
    }
  }

  /** Compact, serialisable form (null when there is nothing). */
  toJSON() {
    const hasKeys = Object.keys(this.toolKeys).length;
    const hasMeta = Object.keys(this.meta).length;
    return hasKeys || hasMeta ? { keys: this.toolKeys, meta: this.meta } : null;
  }
}

module.exports = { KEY, keysIn, argKeys, isJiraTool, parseIssue, parseIssues, issueMeta, createdKey, PromptJira };
