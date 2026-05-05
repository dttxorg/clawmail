# ClawMail

ClawMail is a Docker-ready ClawEmail inbox. It keeps the original IMAP-based mailbox sync core, adds a web server, and supports two access modes:

- Admin: add mailboxes, refresh a single mailbox, reset a mailbox guest key, and delete mailboxes.
- Guest: enter a mailbox-specific key to access only that mailbox.

Guest access triggers an on-demand refresh for that mailbox only. There is no global background refresh, so large mailbox counts do not block the whole service.

## Run With Docker Compose

Edit `docker-compose.yml` before first launch:

- `CLAWMAIL_ADMIN_USERNAME`: admin username.
- `CLAWMAIL_ADMIN_PASSWORD`: admin password.
- `CLAWMAIL_MASTER_KEY`: stable encryption key for stored IMAP credentials. Do not change it after mailboxes are added.
- `CLAWMAIL_REFRESH_COOLDOWN_MS`: per-mailbox guest refresh cooldown.

Then start:

```bash
docker compose up -d
```

Open:

```text
http://SERVER_IP:8080
```

## Local Development

```bash
npm install
npm run build
CLAWMAIL_DATA_DIR=./data CLAWMAIL_ADMIN_PASSWORD=admin CLAWMAIL_MASTER_KEY=development-master-key node dist/server/index.js
```

Open `http://127.0.0.1:8080`.

## Security Notes

- IMAP auth codes are encrypted before being written to disk.
- Guest keys are stored as hashes in SQLite and are only shown once when generated or reset.
- Use HTTPS in front of the container for public network access.
