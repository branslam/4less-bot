# 4less-bot

A Discord bot for managing application tickets, transcripts, and a counting game. Built with Node.js, discord.js, and PostgreSQL.

## Project Structure

- `index.js` — Main bot entrypoint. Handles Discord events, commands, ticket flow, intake sessions, and the counting game.
- `database.js` — PostgreSQL data layer (uses `pg`). Manages users, tickets, queues, intake sessions, and counting state.
- `package.json` — Node.js dependencies (discord.js, discord-html-transcripts, dotenv, mathjs, pg).

## Tech Stack

- Runtime: Node.js 20
- Database: PostgreSQL (Replit-managed, connected via `DATABASE_URL`)
- Discord library: discord.js v14

## Replit Setup

- Workflow: `Discord Bot` runs `node index.js` (console output, no port).
- Database: Replit PostgreSQL is provisioned. Tables are created automatically on startup via `initDatabase()`.

## Required Secrets

- `DISCORD_TOKEN` — Discord bot token (provided)
- `DATABASE_URL` — PostgreSQL connection string (provided automatically by Replit)

## Optional Configuration (set via Secrets when ready)

These configure the bot to work with a specific Discord server. Without them, the bot logs in but commands referencing missing IDs will not work:

- `STAFF_ROLE_ID`, `OWNER_ROLE_ID`, `OWNER_USER_ID`
- `STANDARD_CATEGORY_ID`, `PAID_CATEGORY_ID`
- `CLOSED_STANDARD_CATEGORY_ID`, `CLOSED_PAID_CATEGORY_ID`
- `TRANSCRIPT_LOG_CHANNEL_ID`, `COUNTING_CHANNEL_ID`
- `BOT_LOGO_URL`, `FOOTER_ICON_URL`
- `PREFIX` (command prefix)

## Deployment

The bot is a long-running background service. Deploy as a Reserved VM deployment so the process stays online continuously.
