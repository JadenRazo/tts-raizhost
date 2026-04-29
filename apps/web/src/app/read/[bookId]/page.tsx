// Reader page. Server component: fetches the book, the user's saved
// position + settings, the first 50 sentences, and the available voice
// list, then hands everything to the client Reader. The client lazy-fetches
// further sentence pages as the user scrolls.

import { and, asc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAuth } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { isUuid } from "@/lib/storage";
import { fetchVoices, KokoroUnreachableError, type Voice } from "@/lib/tts-client";
import { Reader, type ReaderSentence } from "./reader";

export const dynamic = "force-dynamic";

const INITIAL_SENTENCE_COUNT = 50;
const VOICES_TTL_MS = 5 * 60 * 1000;
const FALLBACK_VOICE: Voice = {
  id: "en_US-lessac-medium",
  language: "American English",
  gender: "female",
};

// Module-level memo for the static voice list. The synth service holds it
// in memory and recomputes only on container restart, so a 5-minute server
// cache here costs us at most one stale entry across a restart.
let voicesCache: { at: number; data: Voice[] } | null = null;

async function getVoicesCached(): Promise<Voice[]> {
  const now = Date.now();
  if (voicesCache && now - voicesCache.at < VOICES_TTL_MS) {
    return voicesCache.data;
  }
  try {
    const data = await fetchVoices();
    if (data.length === 0) {
      // Empty payload is suspicious; don't cache it.
      return [FALLBACK_VOICE];
    }
    voicesCache = { at: now, data };
    return data;
  } catch (err) {
    if (err instanceof KokoroUnreachableError) {
      console.warn("[reader] kokoro voices unreachable, using fallback");
    } else {
      console.error("[reader] fetchVoices failed", err);
    }
    return voicesCache?.data ?? [FALLBACK_VOICE];
  }
}

type PageProps = { params: Promise<{ bookId: string }> };

export default async function ReadPage({ params }: PageProps) {
  const session = await requireAuth();
  const userId = session.user.id;
  const { bookId } = await params;
  if (!isUuid(bookId)) {
    notFound();
  }

  const db = getDb();

  const bookRows = await db
    .select({
      id: schema.books.id,
      title: schema.books.title,
      author: schema.books.author,
      sentenceCount: schema.books.sentenceCount,
    })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, userId)))
    .limit(1);
  const book = bookRows[0];
  if (!book) {
    notFound();
  }

  const [sentenceRows, positionRows, settingsRows, voices] = await Promise.all([
    db
      .select({
        idx: schema.bookSentences.idx,
        page: schema.bookSentences.page,
        text: schema.bookSentences.text,
      })
      .from(schema.bookSentences)
      .where(
        and(
          eq(schema.bookSentences.bookId, bookId),
          gte(schema.bookSentences.idx, 0),
        ),
      )
      .orderBy(asc(schema.bookSentences.idx))
      .limit(INITIAL_SENTENCE_COUNT),

    db
      .select({
        sentenceIdx: schema.readingPositions.sentenceIdx,
        charOffset: schema.readingPositions.charOffset,
      })
      .from(schema.readingPositions)
      .where(
        and(
          eq(schema.readingPositions.userId, userId),
          eq(schema.readingPositions.bookId, bookId),
        ),
      )
      .limit(1),

    db
      .select({
        voiceId: schema.userSettings.voiceId,
        speed: schema.userSettings.speed,
      })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .limit(1),

    getVoicesCached(),
  ]);

  // Fire-and-forget: bump lastOpenedAt so library ordering reflects this
  // session. Safe to ignore failures — it's only an ordering hint.
  void db
    .update(schema.books)
    .set({ lastOpenedAt: sql`now()` })
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, userId)))
    .catch((err) => console.error("[reader] lastOpenedAt update failed", err));

  const initialSentences: ReaderSentence[] = sentenceRows;
  const initialPosition = positionRows[0] ?? { sentenceIdx: 0, charOffset: 0 };
  const settings = settingsRows[0] ?? { voiceId: "en_US-lessac-medium", speed: 1.0 };

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-10">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-subtle">Reader</p>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-fg">
            {book.title}
          </h1>
          {book.author ? (
            <p className="mt-0.5 truncate text-sm text-muted">{book.author}</p>
          ) : null}
        </div>
        <Link
          href="/"
          className="shrink-0 text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
        >
          Back to library
        </Link>
      </header>

      <div className="mt-8 flex-1">
        <Reader
          bookId={book.id}
          sentenceCount={book.sentenceCount}
          initialSentences={initialSentences}
          initialPosition={initialPosition}
          initialVoiceId={settings.voiceId}
          initialSpeed={Number(settings.speed)}
          voices={voices}
        />
      </div>
    </main>
  );
}
