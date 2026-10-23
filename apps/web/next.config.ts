import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The rota packages are loaded by Node from the workspace, not bundled: they read their fixtures, the recordings and
// the agent ids from files beside them, and better-sqlite3 is a native module. The tracing includes ship those files.
const ghillie = ['@ghillie/agent-kit', '@ghillie/agent-managed', '@ghillie/agent-messages', '@ghillie/demo', '@ghillie/engine', '@ghillie/feed', '@ghillie/ledger', '@ghillie/live', '@ghillie/mcp-server', '@ghillie/stand-in'];

const config: NextConfig = {
  outputFileTracingRoot: root,
  serverExternalPackages: ['better-sqlite3', ...ghillie],
  outputFileTracingIncludes: {
    '/api/**': [
      '../../.env.example',
      '../../packages/*/package.json',
      '../../packages/*/dist/**',
      '../../packages/feed/fixtures/**',
      '../../packages/agent-managed/resources/**',
      '../../apps/demo/package.json',
      '../../apps/demo/dist/**',
      '../../apps/live/package.json',
      '../../apps/live/dist/**',
      '../../recordings/managed-live/**',
      '../../node_modules/better-sqlite3/**',
    ],
  },
  poweredByHeader: false,
  // serverExternalPackages only covers packages that resolve inside node_modules; the workspace packages resolve to
  // their own folders, so they are named here too. Node then imports each one from the workspace, as the tests do.
  webpack: (webpackConfig: { externals?: unknown[] }, { isServer }: { isServer: boolean }) => {
    if (isServer) {
      webpackConfig.externals = [
        ...(webpackConfig.externals ?? []),
        ({ request }: { request?: string }, callback: (error?: Error | null, result?: string) => void) =>
          request && /^@ghillie\//.test(request) ? callback(null, `module ${request}`) : callback(),
      ];
    }
    return webpackConfig;
  },
};

export default config;
