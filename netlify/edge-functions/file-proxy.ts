// File proxy: serves book files (PDFs) from S3 first, falls back to Supabase.
// Supports Range requests so PDF.js can stream pages.
//
// Path shapes:
//   /f/book-files/books/<name>.pdf   ← legacy Supabase bucket name
//   /f/book-covers/covers/<name>.jpg ← legacy Supabase bucket name
//   /f/s3/books/<name>.pdf           ← explicit S3
//   /f/s3/covers/<name>.jpg          ← explicit S3

const SUPABASE_BASE =
  "https://kydmyxsgyxeubhmqzrgo.supabase.co/storage/v1/object/public";
const S3_BASE = "https://kotobi.s3.eu-north-1.amazonaws.com";

// Map the first path segment to the S3 key prefix used during migration.
// Files migrated to S3 live at kotobi/books/<name> and kotobi/covers/<name>.
function toS3Url(bucket: string, filePath: string): string | null {
  if (bucket === "s3") return `${S3_BASE}/${filePath}`;
  if (bucket === "book-files") {
    // Supabase path was books/<name>, S3 is books/<name>
    const key = filePath.startsWith("books/") ? filePath : `books/${filePath}`;
    return `${S3_BASE}/${key}`;
  }
  if (bucket === "book-covers") {
    const key = filePath.startsWith("covers/") ? filePath : `covers/${filePath}`;
    return `${S3_BASE}/${key}`;
  }
  return null;
}

function toSupabaseUrl(bucket: string, filePath: string, search: string): string | null {
  if (bucket === "s3") {
    // s3/books/<name> → book-files/books/<name>
    if (filePath.startsWith("books/"))
      return `${SUPABASE_BASE}/book-files/${filePath}${search}`;
    if (filePath.startsWith("covers/"))
      return `${SUPABASE_BASE}/book-covers/${filePath}${search}`;
    return null;
  }
  return `${SUPABASE_BASE}/${bucket}/${filePath}${search}`;
}

export default async (request: Request, _context: unknown) => {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "f") {
    return new Response(
      JSON.stringify({ error: "Invalid path. Use /f/<bucket>/<path>" }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      },
    );
  }

  const bucket = parts[1];
  const filePath = parts.slice(2).join("/");

  const range = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");
  const ifRange = request.headers.get("if-range");

  // Build candidate URLs: try S3 first, then Supabase as fallback.
  const candidates: string[] = [];
  const s3Url = toS3Url(bucket, filePath);
  if (s3Url) candidates.push(s3Url);
  const supabaseUrl = toSupabaseUrl(bucket, filePath, url.search);
  if (supabaseUrl) candidates.push(supabaseUrl);

  let upstream: Response | null = null;
  let lastStatus = 502;
  for (const target of candidates) {
    try {
      const upstreamHeaders: Record<string, string> = {
        accept: request.headers.get("accept") || "*/*",
      };
      if (range) upstreamHeaders["range"] = range;
      if (ifNoneMatch) upstreamHeaders["if-none-match"] = ifNoneMatch;
      if (ifRange) upstreamHeaders["if-range"] = ifRange;

      const res = await fetch(target, { headers: upstreamHeaders });
      lastStatus = res.status;
      if (res.ok || res.status === 206 || res.status === 304) {
        upstream = res;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!upstream) {
    return new Response(JSON.stringify({ error: "File not found" }), {
      status: lastStatus,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
    });
  }

  // Forward upstream headers but enforce CORS + caching.
  const headers = new Headers();
  const passThrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ];
  for (const h of passThrough) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set(
    "netlify-cdn-cache-control",
    "public, durable, max-age=31536000, immutable",
  );
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "range, if-none-match, if-range");
  headers.set("access-control-expose-headers",
    "content-length, content-range, accept-ranges, etag, last-modified");

  return new Response(upstream.body, { status: upstream.status, headers });
};
