const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function query(text, params) {
  return pool.query(text, params);
}

function getCounterKey(ticketType) {
  return ticketType === 'paid'
    ? 'paid_ticket_counter'
    : 'standard_ticket_counter';
}

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      discord_user_id TEXT PRIMARY KEY,
      lifetime_ticket_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      channel_id TEXT UNIQUE NOT NULL,
      owner_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('standard', 'paid')),
      ticket_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'deleted')),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMP NULL,
      deleted_at TIMESTAMP NULL,
      transcript_generated BOOLEAN NOT NULL DEFAULT FALSE,
      transcript_generated_at TIMESTAMP NULL,
      is_queued BOOLEAN NOT NULL DEFAULT FALSE,
      queue_position INTEGER NULL,
      queued_at TIMESTAMP NULL
    );
  `);

  await query(`
    ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS transcript_generated BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS transcript_generated_at TIMESTAMP NULL,
    ADD COLUMN IF NOT EXISTS is_queued BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS queue_position INTEGER NULL,
    ADD COLUMN IF NOT EXISTS queued_at TIMESTAMP NULL;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await query(`
    INSERT INTO bot_state (key, value)
    VALUES
      ('standard_ticket_counter', '0'),
      ('paid_ticket_counter', '0'),
      ('req_standard_crowns', '1000'),
      ('req_booster_crowns', '700'),
      ('req_staff_crowns', '500'),
      ('req_ap', 'null'),
      ('req_ads', '4')
    ON CONFLICT (key) DO NOTHING;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ticket_intake (
      channel_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      ticket_type TEXT NOT NULL CHECK (ticket_type IN ('standard', 'paid')),
      step TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'stopped')) DEFAULT 'active',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
    // ==================== COUNTING BOT TABLES ====================
  await query(`
    CREATE TABLE IF NOT EXISTS counting_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_number INTEGER NOT NULL DEFAULT 0,
      last_user_id TEXT,
      last_message_id TEXT,
      current_streak INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    INSERT INTO counting_state (id, current_number, current_streak)
    VALUES (1, 0, 0)
    ON CONFLICT (id) DO NOTHING;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_counting_stats (
      user_id TEXT PRIMARY KEY,
      highest_streak INTEGER NOT NULL DEFAULT 0,
      highest_streak_date TIMESTAMP,
      total_mistakes INTEGER NOT NULL DEFAULT 0
    );
  `);
}

async function getNextTicketNumber(ticketType) {
  const key = getCounterKey(ticketType);

  const result = await query(
    `SELECT value FROM bot_state WHERE key = $1`,
    [key]
  );

  const current = parseInt(result.rows[0].value, 10);
  const next = current + 1;

  await query(
    `UPDATE bot_state
     SET value = $1
     WHERE key = $2`,
    [String(next), key]
  );

  return next;
}

async function getTicketCounter(ticketType) {
  const key = getCounterKey(ticketType);

  const result = await query(
    `SELECT value FROM bot_state WHERE key = $1`,
    [key]
  );

  return parseInt(result.rows[0].value, 10);
}

async function setTicketCounter(ticketType, value) {
  const key = getCounterKey(ticketType);

  await query(
    `UPDATE bot_state
     SET value = $1
     WHERE key = $2`,
    [String(value), key]
  );
}

async function getRequirements() {
  const result = await query(
    `SELECT key, value
     FROM bot_state
     WHERE key IN (
       'req_standard_crowns',
       'req_booster_crowns',
       'req_staff_crowns',
       'req_ap',
       'req_ads'
     )`
  );

  const map = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));

  return {
    standardCrowns: map.req_standard_crowns ?? '1000',
    boosterCrowns: map.req_booster_crowns ?? '700',
    staffCrowns: map.req_staff_crowns ?? '500',
    ap: map.req_ap ?? 'null',
    ads: map.req_ads ?? '4'
  };
}

async function setRequirements({
  standardCrowns,
  boosterCrowns,
  staffCrowns,
  ap,
  ads
}) {
  const updates = [
    ['req_standard_crowns', String(standardCrowns)],
    ['req_booster_crowns', String(boosterCrowns)],
    ['req_staff_crowns', String(staffCrowns)],
    ['req_ap', String(ap)],
    ['req_ads', String(ads)]
  ];

  for (const [key, value] of updates) {
    await query(
      `UPDATE bot_state
       SET value = $1
       WHERE key = $2`,
      [value, key]
    );
  }
}

async function ensureUserExists(userId) {
  await query(
    `INSERT INTO users (discord_user_id)
     VALUES ($1)
     ON CONFLICT (discord_user_id) DO NOTHING`,
    [userId]
  );
}

async function incrementLifetimeTicketCount(userId) {
  await ensureUserExists(userId);

  await query(
    `UPDATE users
     SET lifetime_ticket_count = lifetime_ticket_count + 1
     WHERE discord_user_id = $1`,
    [userId]
  );
}

async function getLifetimeTicketCount(userId) {
  await ensureUserExists(userId);

  const result = await query(
    `SELECT lifetime_ticket_count
     FROM users
     WHERE discord_user_id = $1`,
    [userId]
  );

  return result.rows[0].lifetime_ticket_count;
}

async function createTicket({
  channelId,
  ownerId,
  type,
  ticketNumber
}) {
  await query(
    `INSERT INTO tickets (
      channel_id,
      owner_id,
      type,
      ticket_number,
      status
    ) VALUES ($1, $2, $3, $4, 'open')`,
    [channelId, ownerId, type, ticketNumber]
  );
}

async function getTicketByChannelId(channelId) {
  const result = await query(
    `SELECT *
     FROM tickets
     WHERE channel_id = $1`,
    [channelId]
  );

  return result.rows[0] || null;
}

async function getOpenTicketByOwnerId(ownerId) {
  const result = await query(
    `SELECT *
     FROM tickets
     WHERE owner_id = $1
       AND status = 'open'
     ORDER BY created_at DESC
     LIMIT 1`,
    [ownerId]
  );

  return result.rows[0] || null;
}

async function getQueuedOpenTickets() {
  const result = await query(
    `SELECT *
     FROM tickets
     WHERE status = 'open'
       AND is_queued = TRUE
     ORDER BY
       CASE WHEN queue_position IS NULL THEN 1 ELSE 0 END,
       queue_position ASC NULLS LAST,
       queued_at ASC NULLS LAST,
       created_at ASC`
  );

  return result.rows;
}

async function addTicketToQueue(channelId) {
  await query(
    `UPDATE tickets
     SET is_queued = TRUE,
         queued_at = NOW()
     WHERE channel_id = $1`,
    [channelId]
  );
}

async function removeTicketFromQueue(channelId) {
  await query(
    `UPDATE tickets
     SET is_queued = FALSE,
         queue_position = NULL,
         queued_at = NULL
     WHERE channel_id = $1`,
    [channelId]
  );
}

async function setTicketQueuePosition(channelId, position) {
  await query(
    `UPDATE tickets
     SET queue_position = $2
     WHERE channel_id = $1`,
    [channelId, position]
  );
}

async function clearQueueForClosedOrDeletedTicket(channelId) {
  await query(
    `UPDATE tickets
     SET is_queued = FALSE,
         queue_position = NULL,
         queued_at = NULL
     WHERE channel_id = $1`,
    [channelId]
  );
}

async function closeTicket(channelId) {
  await query(
    `UPDATE tickets
     SET status = 'closed',
         closed_at = NOW()
     WHERE channel_id = $1`,
    [channelId]
  );
}

async function deleteTicket(channelId) {
  await query(
    `UPDATE tickets
     SET status = 'deleted',
         deleted_at = NOW()
     WHERE channel_id = $1`,
    [channelId]
  );
}

async function markTranscriptGenerated(channelId) {
  await query(
    `UPDATE tickets
     SET transcript_generated = TRUE,
         transcript_generated_at = NOW()
     WHERE channel_id = $1`,
    [channelId]
  );
}

async function createIntakeSession({
  channelId,
  ownerId,
  ticketType,
  step
}) {
  await query(
    `INSERT INTO ticket_intake (
      channel_id,
      owner_id,
      ticket_type,
      step,
      status,
      data
    ) VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb)
    ON CONFLICT (channel_id)
    DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      ticket_type = EXCLUDED.ticket_type,
      step = EXCLUDED.step,
      status = 'active',
      data = '{}'::jsonb,
      updated_at = NOW()`,
    [channelId, ownerId, ticketType, step]
  );
}

async function getIntakeSession(channelId) {
  const result = await query(
    `SELECT *
     FROM ticket_intake
     WHERE channel_id = $1`,
    [channelId]
  );

  return result.rows[0] || null;
}

async function updateIntakeSession(channelId, { step, status, data }) {
  await query(
    `UPDATE ticket_intake
     SET step = COALESCE($2, step),
         status = COALESCE($3, status),
         data = COALESCE($4, data),
         updated_at = NOW()
     WHERE channel_id = $1`,
    [channelId, step ?? null, status ?? null, data ?? null]
  );
}

async function stopIntakeSession(channelId) {
  await query(
    `UPDATE ticket_intake
     SET status = 'stopped',
         updated_at = NOW()
     WHERE channel_id = $1`,
    [channelId]
  );
}

// ====================== COUNTING BOT DATABASE FUNCTIONS ======================

async function getCountingState() {
  const result = await query(`SELECT * FROM counting_state WHERE id = 1`);
  return result.rows[0] || { current_number: 0, last_user_id: null, current_streak: 0 };
}

async function updateCountingState(currentNumber, lastUserId, currentStreak) {
  await query(`
    UPDATE counting_state
    SET current_number = $1,
        last_user_id = $2,
        current_streak = $3,
        updated_at = NOW()
    WHERE id = 1
  `, [currentNumber, lastUserId, currentStreak]);
}

async function recordHighStreak(userId, streakLength) {
  await query(`
    INSERT INTO user_counting_stats (user_id, highest_streak, highest_streak_date)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      highest_streak = GREATEST(user_counting_stats.highest_streak, $2),
      highest_streak_date = NOW()
  `, [userId, streakLength]);
}

async function incrementMistakes(userId) {
  await query(`
    INSERT INTO user_counting_stats (user_id, total_mistakes)
    VALUES ($1, 1)
    ON CONFLICT (user_id)
    DO UPDATE SET total_mistakes = user_counting_stats.total_mistakes + 1
  `, [userId]);
}

async function getTopStreaks(limit = 10) {
  const result = await query(`
    SELECT user_id, highest_streak, highest_streak_date
    FROM user_counting_stats
    WHERE highest_streak > 0
    ORDER BY highest_streak DESC, highest_streak_date DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

async function getTopMistakes(limit = 10) {
  const result = await query(`
    SELECT user_id, total_mistakes
    FROM user_counting_stats
    WHERE total_mistakes > 0
    ORDER BY total_mistakes DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

module.exports = {
  pool,
  query,
  initDatabase,
  getNextTicketNumber,
  getTicketCounter,
  setTicketCounter,
  getRequirements,
  setRequirements,
  ensureUserExists,
  incrementLifetimeTicketCount,
  getLifetimeTicketCount,
  createTicket,
  getTicketByChannelId,
  getOpenTicketByOwnerId,
  getQueuedOpenTickets,
  addTicketToQueue,
  removeTicketFromQueue,
  setTicketQueuePosition,
  clearQueueForClosedOrDeletedTicket,
  closeTicket,
  deleteTicket,
  markTranscriptGenerated,
  createIntakeSession,
  getIntakeSession,
  updateIntakeSession,
  stopIntakeSession,
  getCountingState,
  updateCountingState,
  recordHighStreak,
  incrementMistakes,
  getTopStreaks,
  getTopMistakes
};