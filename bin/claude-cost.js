#!/usr/bin/env node
'use strict';
// Claude Code cost report: per prompt, per session, per project, per Jira epic. Run it inside Claude
// Code with the `!` prefix (no model call, no tokens): ! node <this repo>/bin/claude-cost.js --help
require('../lib/claude-cost').main(process.argv.slice(2));
