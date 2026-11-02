'use strict';
const os = require('os');
const path = require('path');

const HOME = os.homedir();
// CC_HOME lets tests run against a throwaway data folder.
const DATA = process.env.CC_HOME || path.join(HOME, '.cc');

module.exports = {
  VERSION: '1.0.0',
  HOME,
  DATA,
  APP: path.resolve(__dirname, '..'),
  CLI: path.resolve(__dirname, '..', 'cc.js'),
  CONFIG: path.join(DATA, 'config.json'),
  STATE: path.join(DATA, 'state.json'),
  HISTORY: path.join(DATA, 'history.jsonl'),
  LOG: path.join(DATA, 'relay.log'),
  ACCOUNTS: path.join(DATA, 'accounts'),
  BACKUPS: path.join(DATA, 'backups'),
  CLAUDE_DIR: process.env.CC_CLAUDE_DIR || path.join(HOME, '.claude'),
  // Overridable so tests can point the relay at a fake Anthropic server.
  UPSTREAM: process.env.CC_UPSTREAM || 'https://api.anthropic.com',
  TOKEN_URL: process.env.CC_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token',
};
