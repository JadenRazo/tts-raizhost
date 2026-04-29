import { requireAuth } from "@/lib/auth/session";
import { MAX_BOOKS_PER_USER, MAX_FILE_BYTES } from "@/lib/books";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  await requireAuth();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Upload a PDF
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Pick a PDF from your device. We&apos;ll extract the text and add it to
        your library. Up to {MAX_BOOKS_PER_USER} books,{" "}
        {Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB each.
      </p>
      <div className="mt-8">
        <UploadForm
          maxBytes={MAX_FILE_BYTES}
          maxBooks={MAX_BOOKS_PER_USER}
        />
      </div>
      <p className="mt-10 text-sm text-muted">
        <a
          href="/"
          className="underline underline-offset-4 hover:text-fg decoration-border-strong hover:decoration-fg"
        >
          Back to library
        </a>
      </p>
    </main>
  );
}
