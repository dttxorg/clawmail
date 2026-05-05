import { createClawMailServer, loadServerConfig } from './server';

const config = loadServerConfig();
const server = await createClawMailServer(config);

server.listen(config.port, config.host, () => {
  console.log(`ClawMail listening on http://${config.host}:${config.port}`);
});
