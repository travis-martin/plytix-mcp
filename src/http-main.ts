import 'dotenv/config';
import { createHttpApp, loadHttpConfig } from './http.js';

try {
  const config = loadHttpConfig();
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const server = createHttpApp(config).listen(port, config.host, () => {
    console.error(`Plytix MCP listening on port ${port}`);
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.on('error', () => { console.error('HTTP listener failed'); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 8_000).unref(); });
  }
} catch {
  console.error('Plytix MCP HTTP startup failed; check local configuration');
  process.exitCode = 1;
}
