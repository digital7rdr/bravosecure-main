/**
 * lint-staged config — filters which staged files reach the root
 * eslint command.
 *
 * Why a JS config instead of the inline package.json form: the root
 * eslint config is a React-Native one (`@react-native/eslint-config`)
 * with `parserOptions.project` pointing at the root tsconfig. It does
 * NOT understand the workspace layout under `apps/` (each Nest /
 * Next.js service has its own tsconfig + plugin set). When a staged
 * file lives under `apps/`, the root eslint resolves the nearest
 * `apps/<svc>/.eslintrc.*`, finds `eslint-plugin-react-hooks` loaded
 * from BOTH the root node_modules AND the service's node_modules,
 * and refuses to run with "ESLint couldn't determine the plugin
 * 'react-hooks' uniquely". Each service is responsible for linting
 * its own files; the root hook should leave them alone.
 *
 * Filter: only pass files OUTSIDE `apps/` and `worldmonitor/` to the
 * root eslint. Files inside those directories are still committed
 * (no skip), they just don't get the root lint pass — each service's
 * own CI handles its eslint.
 */
const path = require('node:path');

module.exports = {
  '*.{ts,tsx}': files => {
    const filtered = files.filter(f => {
      const rel = path.relative(__dirname, f).replace(/\\/g, '/');
      return !rel.startsWith('apps/') && !rel.startsWith('worldmonitor/');
    });
    if (filtered.length === 0) {return [];}
    return [`eslint --fix --max-warnings=20 ${filtered.map(f => `"${f}"`).join(' ')}`];
  },
  '*.{js,jsx,json,md,yml,yaml}': 'prettier --write --ignore-unknown',
};
