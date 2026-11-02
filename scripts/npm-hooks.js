'use strict';
// npm installs the `ccm` command everywhere. On Windows, also add `cc`
// (on macOS and Linux `cc` is the C compiler, so it is left alone).
//   node scripts/npm-hooks.js install|uninstall
const fs = require('fs');
const path = require('path');

const MARK = 'cc-multi-account';
const prefix = process.env.npm_config_prefix;
const global = process.env.npm_config_global === 'true' || process.env.npm_config_location === 'global';

if (process.platform === 'win32' && global && prefix) {
  const files = {
    'cc.cmd': `@rem ${MARK}\r\n@call "%~dp0ccm.cmd" %*\r\n`,
    'cc': `#!/bin/sh\n# ${MARK}\nexec "$(dirname "$0")/ccm" "$@"\n`,
  };
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(prefix, name);
    try {
      if (process.argv[2] === 'uninstall') {
        if (fs.readFileSync(file, 'utf8').includes(MARK)) fs.unlinkSync(file);
      } else if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').includes(MARK)) {
        fs.writeFileSync(file, text);
      }
    } catch {}
  }
}
