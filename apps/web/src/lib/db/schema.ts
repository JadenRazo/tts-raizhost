// Database schema for tts.raizhost.com.
// drizzle-kit reads this file for migration generation.
//
// Column naming convention:
//   - TypeScript keys: camelCase  (e.g. userId)
//   - PostgreSQL columns: snake_case (passed as first string arg)
//
// Better Auth tables follow the v1.5+ schema with usePlural: true.

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const nowTz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" }).defaultNow().notNull();

const tz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------------------
// users (Better Auth)
// ---------------------------------------------------------------------------
// Email is the sole login identifier. We never send mail and never verify;
// the address is stored as-typed but compared case-insensitively (the unique
// index is on lower(email)). TOTP is the only credential.

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    /** Better Auth reads `name` for cookie payload; we mirror email into it
     * so existing setSessionCookie code paths keep working without a custom
     * coercion helper. */
    name: text("name"),
    image: text("image"),

    totpSecretEnc: text("totp_secret_enc"),
    recoveryCodesEnc: text("recovery_codes_enc"),
    enrolledAt: tz("enrolled_at"),
    isAdmin: boolean("is_admin").default(false).notNull(),

    createdAt: nowTz("created_at"),
    updatedAt: nowTz("updated_at"),
  },
  (t) => [
    uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ---------------------------------------------------------------------------
// sessions (Better Auth)
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    token: text("token").unique().notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: nowTz("created_at"),
    updatedAt: nowTz("updated_at"),
  },
  (t) => [
    uniqueIndex("sessions_token_idx").on(t.token),
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

// ---------------------------------------------------------------------------
// accounts (Better Auth)
// ---------------------------------------------------------------------------
// Required by the Drizzle adapter even when no OAuth providers are wired.

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: tz("access_token_expires_at"),
  refreshTokenExpiresAt: tz("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: nowTz("created_at"),
  updatedAt: nowTz("updated_at"),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

// ---------------------------------------------------------------------------
// verifications (Better Auth)
// ---------------------------------------------------------------------------

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  createdAt: nowTz("created_at"),
  updatedAt: nowTz("updated_at"),
});

export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;

// ---------------------------------------------------------------------------
// enrollment_tokens
// ---------------------------------------------------------------------------
// One-time URL-safe token issued by `scripts/create-user.ts`. The user opens
// /enroll/<token>, scans QR, submits TOTP — at which point the token is
// burned and the user's totp_secret_enc + recovery_codes_enc are populated.

export const enrollmentTokens = pgTable(
  "enrollment_tokens",
  {
    token: text("token").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    usedAt: tz("used_at"),
    createdAt: nowTz("created_at"),
  },
  (t) => [
    index("enrollment_tokens_user_id_idx").on(t.userId),
    index("enrollment_tokens_expires_at_idx").on(t.expiresAt),
  ],
);

export type EnrollmentToken = typeof enrollmentTokens.$inferSelect;
export type NewEnrollmentToken = typeof enrollmentTokens.$inferInsert;

// ---------------------------------------------------------------------------
// invite_codes
// ---------------------------------------------------------------------------
// Codes minted by `scripts/issue-invite.ts` and consumed at signup. The
// friend-tier beta gate: signup is rejected unless a valid code is
// presented and it still has remaining uses. A CHECK constraint
// guarantees use_count <= max_uses even under concurrent UPDATEs, so a
// code never gets over-redeemed.
//
// max_uses=1 is single-use (the default; `consumed_at` becomes the use
// timestamp). max_uses>1 is a shareable link — `consumed_at`,
// `consumed_by_email`, `consumed_by_user_id` record only the FIRST
// consumer; the full audit trail comes from the users table filtered
// by created_at within the issued_at window.

export const inviteCodes = pgTable(
  "invite_codes",
  {
    code: text("code").primaryKey(),
    issuedAt: nowTz("issued_at"),
    issuedBy: text("issued_by"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    consumedAt: tz("consumed_at"),
    consumedByEmail: text("consumed_by_email"),
    consumedByUserId: uuid("consumed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
  },
  (t) => [
    index("invite_codes_available_idx")
      .on(t.code)
      .where(sql`${t.useCount} < ${t.maxUses}`),
  ],
);

export type InviteCode = typeof inviteCodes.$inferSelect;
export type NewInviteCode = typeof inviteCodes.$inferInsert;

// ---------------------------------------------------------------------------
// user_tts_quota
// ---------------------------------------------------------------------------
// Per-user daily synthesis quota in characters. Counts only cache-miss
// requests (cache hits cost no GPU time). Reset daily at 00:00 UTC by
// the tts-quota-reset CronJob; lifetime usage is preserved.

export const userTtsQuota = pgTable("user_tts_quota", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  charsUsedToday: integer("chars_used_today").notNull().default(0),
  dailyLimit: integer("daily_limit").notNull().default(200_000),
  lastResetAt: nowTz("last_reset_at"),
  totalCharsLifetime: bigint("total_chars_lifetime", { mode: "number" })
    .notNull()
    .default(0),
});

export type UserTtsQuota = typeof userTtsQuota.$inferSelect;
export type NewUserTtsQuota = typeof userTtsQuota.$inferInsert;

// ---------------------------------------------------------------------------
// books
// ---------------------------------------------------------------------------
// Library of uploaded PDFs. The blob lives on disk at
// /var/lib/tts-raizhost/books/<user_id>/<book_id>.pdf; this row is the index.

export const books = pgTable(
  "books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    author: text("author"),
    originalFilename: text("original_filename").notNull(),
    filePath: text("file_path").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    pageCount: integer("page_count").notNull(),
    sentenceCount: integer("sentence_count").notNull(),
    /** sha256 of the normalized extracted text — used for cache invalidation
     * when the same book is re-uploaded with the same content. */
    textSha256: text("text_sha256").notNull(),
    /** Curated public-domain books available to every signed-in user.
     * Owned by a fixed system user (see scripts/seed-public-books.ts);
     * excluded from per-user storage caps and from the Delete affordance. */
    isPublic: boolean("is_public").default(false).notNull(),
    uploadedAt: nowTz("uploaded_at"),
    lastOpenedAt: tz("last_opened_at"),
  },
  (t) => [
    index("books_user_id_last_opened_idx").on(
      t.userId,
      sql`${t.lastOpenedAt} desc nulls last`,
    ),
    index("books_text_sha256_idx").on(t.textSha256),
    index("books_is_public_idx").on(t.uploadedAt).where(sql`${t.isPublic} = true`),
  ],
);

export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;

// ---------------------------------------------------------------------------
// book_sentences
// ---------------------------------------------------------------------------
// Parsed sentence list for each book. Authoritative addressing for reading
// positions and the TTS request layer. Inserted in bulk on upload.

export const bookSentences = pgTable(
  "book_sentences",
  {
    bookId: uuid("book_id")
      .references(() => books.id, { onDelete: "cascade" })
      .notNull(),
    idx: integer("idx").notNull(),
    page: integer("page").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.idx] }),
    index("book_sentences_book_id_idx").on(t.bookId),
  ],
);

export type BookSentence = typeof bookSentences.$inferSelect;
export type NewBookSentence = typeof bookSentences.$inferInsert;

// ---------------------------------------------------------------------------
// book_prerender_runs
// ---------------------------------------------------------------------------
// Persistent marker for "this (book, voice, speed) has been fully
// prerendered". The in-process `inflight` Map in lib/tts-prerender.ts
// dedupes within a single pod's lifetime; this table is the source of
// truth across pod restarts. Without it, every reader that opens a
// book after a deploy walks all ~4500 sentences re-checking the audio
// cache before realizing every sentence is already on disk.
//
// status values: queued | in_progress | complete | failed. Enforced by
// a CHECK constraint rather than pgEnum to keep migrations
// rollback-friendly (adding/dropping enum values requires a separate
// transactional dance Postgres only partly supports).

export const bookPrerenderRuns = pgTable(
  "book_prerender_runs",
  {
    bookId: uuid("book_id")
      .references(() => books.id, { onDelete: "cascade" })
      .notNull(),
    voiceId: text("voice_id").notNull(),
    /** Quantized to two decimal places — see ALLOWED_SPEEDS in
     * apps/web/src/app/api/tts/route.ts. */
    speed: real("speed").notNull(),
    status: text("status").notNull(),
    prerenderedAt: tz("prerendered_at"),
    errorText: text("error_text"),
    updatedAt: nowTz("updated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.voiceId, t.speed] }),
    check(
      "book_prerender_runs_status_check",
      sql`${t.status} in ('queued', 'in_progress', 'complete', 'failed')`,
    ),
  ],
);

export type BookPrerenderRun = typeof bookPrerenderRuns.$inferSelect;
export type NewBookPrerenderRun = typeof bookPrerenderRuns.$inferInsert;

// ---------------------------------------------------------------------------
// book_chapters
// ---------------------------------------------------------------------------
// Outline / table-of-contents extracted from the PDF at upload time.
// Each chapter points to the sentence idx where it begins (resolved from
// the PDF's `dest` → page → first sentence-on-page mapping). Books
// without a usable PDF outline have zero rows here, and the reader's
// chapter navigation falls through to page-level. `depth` preserves
// hierarchy so a future UI can render nested TOCs; `ord` preserves
// authorial order across the depth tree (PDF outlines are walked
// depth-first, so `ord` is just the visit index).

export const bookChapters = pgTable(
  "book_chapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .references(() => books.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    startSentenceIdx: integer("start_sentence_idx").notNull(),
    depth: integer("depth").default(0).notNull(),
    ord: integer("ord").notNull(),
  },
  (t) => [
    index("book_chapters_book_id_idx").on(t.bookId, t.startSentenceIdx),
    uniqueIndex("book_chapters_book_id_ord_idx").on(t.bookId, t.ord),
    check(
      "book_chapters_start_sentence_idx_chk",
      sql`${t.startSentenceIdx} >= 0`,
    ),
    check("book_chapters_depth_chk", sql`${t.depth} >= 0`),
  ],
);

export type BookChapter = typeof bookChapters.$inferSelect;
export type NewBookChapter = typeof bookChapters.$inferInsert;

// ---------------------------------------------------------------------------
// reading_positions
// ---------------------------------------------------------------------------
// One row per (user, book). Last write wins. Updated on a 1s debounce while
// playback is running, plus on pause/blur/beforeunload.

export const readingPositions = pgTable(
  "reading_positions",
  {
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    bookId: uuid("book_id")
      .references(() => books.id, { onDelete: "cascade" })
      .notNull(),
    sentenceIdx: integer("sentence_idx").notNull(),
    charOffset: integer("char_offset").default(0).notNull(),
    updatedAt: nowTz("updated_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookId] })],
);

export type ReadingPosition = typeof readingPositions.$inferSelect;
export type NewReadingPosition = typeof readingPositions.$inferInsert;

// ---------------------------------------------------------------------------
// user_settings
// ---------------------------------------------------------------------------
// Per-user reading preferences. The hardware-control mapping columns
// (next_track_action, prev_track_action, seek_forward_action,
// seek_backward_action) decide what happens when a user presses a
// CarPlay / Bluetooth / lock-screen control. Defaults match the
// audiobook conventions every iOS user already knows: the steering-wheel
// skip pair maps to ±15s seek (Audible / Apple Books), and the
// nexttrack/previoustrack pair (used by some headsets and CarPlay UI
// taps) maps to whole-page jumps.
//
// `*_chapter` is accepted in the action enums even though chapter
// detection isn't shipped yet — that way the migration that adds it
// later doesn't need to alter the CHECK constraints.

export const userSettings = pgTable(
  "user_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    voiceId: text("voice_id").default("af_heart").notNull(),
    speed: real("speed").default(1.0).notNull(),
    lastBookId: uuid("last_book_id").references(() => books.id, {
      onDelete: "set null",
    }),
    theme: text("theme").default("auto").notNull(),
    /** What to do when CarPlay / Bluetooth sends `nexttrack`. Some cars
     * surface this on a single press of the wheel skip-forward button
     * (music-mode behavior); others surface seekforward instead. */
    nextTrackAction: text("next_track_action")
      .default("next_page")
      .notNull(),
    prevTrackAction: text("prev_track_action")
      .default("prev_page")
      .notNull(),
    /** What to do when CarPlay / Bluetooth sends `seekforward(N)` —
     * the audiobook-mode behavior of the wheel skip buttons. Default
     * `seek_forward` means "jump N seconds in the virtual book
     * timeline", N from `seekStepSeconds`. */
    seekForwardAction: text("seek_forward_action")
      .default("seek_forward")
      .notNull(),
    seekBackwardAction: text("seek_backward_action")
      .default("seek_back")
      .notNull(),
    /** Step in seconds when seek_forward / seek_back action fires.
     * Audible / Apple Books default 15. Range bounded so a user can't
     * accidentally configure a 1-hour or 1-second skip that nullifies
     * the feature. */
    seekStepSeconds: integer("seek_step_seconds").default(15).notNull(),
    /** Auto-rewind by this many seconds on Play after a long pause.
     * Set to 0 to disable. Long-pause threshold is ~30s, hardcoded —
     * anything tighter feels like a glitch, anything looser and the
     * user has forgotten where they were. */
    smartRewindSeconds: integer("smart_rewind_seconds")
      .default(5)
      .notNull(),
    /** Default duration the sleep timer button preselects. */
    sleepTimerDefaultMinutes: integer("sleep_timer_default_minutes")
      .default(30)
      .notNull(),
    updatedAt: nowTz("updated_at"),
  },
  (t) => [
    check(
      "user_settings_next_track_action_chk",
      sql`${t.nextTrackAction} in ('next_sentence','next_page','next_chapter','seek_forward','restart_sentence')`,
    ),
    check(
      "user_settings_prev_track_action_chk",
      sql`${t.prevTrackAction} in ('prev_sentence','prev_page','prev_chapter','seek_back','restart_sentence','restart_book')`,
    ),
    check(
      "user_settings_seek_forward_action_chk",
      sql`${t.seekForwardAction} in ('seek_forward','next_sentence','next_page','next_chapter')`,
    ),
    check(
      "user_settings_seek_backward_action_chk",
      sql`${t.seekBackwardAction} in ('seek_back','prev_sentence','prev_page','prev_chapter','restart_sentence')`,
    ),
    check(
      "user_settings_seek_step_seconds_chk",
      sql`${t.seekStepSeconds} between 5 and 120`,
    ),
    check(
      "user_settings_smart_rewind_seconds_chk",
      sql`${t.smartRewindSeconds} between 0 and 60`,
    ),
    check(
      "user_settings_sleep_timer_default_minutes_chk",
      sql`${t.sleepTimerDefaultMinutes} between 5 and 120`,
    ),
  ],
);

export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;

// ---------------------------------------------------------------------------
// bookmarks
// ---------------------------------------------------------------------------
// One row per (user, book, sentence) bookmark. `note` is optional. Lookup
// is always (user_id, book_id) so the composite index there is the
// hot path — the PK on `id` only matters for delete-by-id.

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    bookId: uuid("book_id")
      .references(() => books.id, { onDelete: "cascade" })
      .notNull(),
    sentenceIdx: integer("sentence_idx").notNull(),
    note: text("note"),
    createdAt: nowTz("created_at"),
  },
  (t) => [
    index("bookmarks_user_book_idx").on(t.userId, t.bookId, t.sentenceIdx),
    check("bookmarks_sentence_idx_chk", sql`${t.sentenceIdx} >= 0`),
  ],
);

export type Bookmark = typeof bookmarks.$inferSelect;
export type NewBookmark = typeof bookmarks.$inferInsert;

// ---------------------------------------------------------------------------
// tts_cache
// ---------------------------------------------------------------------------
// Content-addressed audio cache. cacheKey = sha256(voiceId|speed|sentenceText).
// Audio file lives at /var/lib/tts-raizhost/cache/<voice>/<cacheKey>.opus.
// LRU evicted by lastHitAt in a nightly job.

export const ttsCache = pgTable(
  "tts_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    voiceId: text("voice_id").notNull(),
    textHash: text("text_hash").notNull(),
    audioPath: text("audio_path").notNull(),
    durationMs: integer("duration_ms").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: nowTz("created_at"),
    lastHitAt: nowTz("last_hit_at"),
  },
  (t) => [
    index("tts_cache_last_hit_at_idx").on(t.lastHitAt),
    index("tts_cache_voice_text_idx").on(t.voiceId, t.textHash),
  ],
);

export type TtsCache = typeof ttsCache.$inferSelect;
export type NewTtsCache = typeof ttsCache.$inferInsert;

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  enrollmentTokens: many(enrollmentTokens),
  books: many(books),
  readingPositions: many(readingPositions),
  settings: one(userSettings, {
    fields: [users.id],
    references: [userSettings.userId],
  }),
  ttsQuota: one(userTtsQuota, {
    fields: [users.id],
    references: [userTtsQuota.userId],
  }),
}));

export const inviteCodesRelations = relations(inviteCodes, ({ one }) => ({
  consumedBy: one(users, {
    fields: [inviteCodes.consumedByUserId],
    references: [users.id],
  }),
}));

export const userTtsQuotaRelations = relations(userTtsQuota, ({ one }) => ({
  user: one(users, {
    fields: [userTtsQuota.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const enrollmentTokensRelations = relations(
  enrollmentTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [enrollmentTokens.userId],
      references: [users.id],
    }),
  }),
);

export const booksRelations = relations(books, ({ one, many }) => ({
  user: one(users, {
    fields: [books.userId],
    references: [users.id],
  }),
  sentences: many(bookSentences),
  chapters: many(bookChapters),
  readingPositions: many(readingPositions),
}));

export const bookChaptersRelations = relations(bookChapters, ({ one }) => ({
  book: one(books, {
    fields: [bookChapters.bookId],
    references: [books.id],
  }),
}));

export const bookSentencesRelations = relations(bookSentences, ({ one }) => ({
  book: one(books, {
    fields: [bookSentences.bookId],
    references: [books.id],
  }),
}));

export const readingPositionsRelations = relations(
  readingPositions,
  ({ one }) => ({
    user: one(users, {
      fields: [readingPositions.userId],
      references: [users.id],
    }),
    book: one(books, {
      fields: [readingPositions.bookId],
      references: [books.id],
    }),
  }),
);

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, {
    fields: [userSettings.userId],
    references: [users.id],
  }),
  lastBook: one(books, {
    fields: [userSettings.lastBookId],
    references: [books.id],
  }),
}));

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  user: one(users, {
    fields: [bookmarks.userId],
    references: [users.id],
  }),
  book: one(books, {
    fields: [bookmarks.bookId],
    references: [books.id],
  }),
}));
