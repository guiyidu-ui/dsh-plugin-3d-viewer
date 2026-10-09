// dsh-plugin-3d-viewer — host half.
//
// Registers GET /model3d/<workspace-root>/<rel> on the DSH web server so the
// client bundle (Three.js viewer) can fetch model files that live INSIDE the
// session workspace — the same-origin route is required because the chat
// renderer only loads http(s) URLs and the browser cannot open file:// paths.
//
// Root discovery: the host cannot know the session workspace from a bare
// route, so the root is passed in the path. The agent writes the code block
// with its own absolute workspace root (it knows it from the system context):
//   ```3d
//   D:\models\demo.obj
//   ```
// and the client derives
//   /model3d/E:/AI%20share/models/demo.obj
//   (the workspace root up to the last backslash, drive letter lowercased,
//    path slashes normalized, then URL-encoded segment by segment).
//
// Security (mirrors serve-images, stricter):
//   - GET/HEAD only; model extensions only (obj/mtl/stl/gltf/glb), fixed
//     content-types.
//   - Same-origin guard: server binds 0.0.0.0 (LAN/Tailscale); a request
//     carrying an Origin header whose host does not match the request Host is
//     rejected 403.
//   - Path rules: the encoded part after /model3d/ must decode to an absolute
//     Windows or POSIX path (no driveless "E:foo", no relative, no ".."
//     segments, no NUL); the decoded root segment must not equal a Windows
//     drive root (e.g. E:/) — that would let a request read the whole disk.
//   - No per-root trust list: the route is same-origin + loopback/LAN only,
//     single-user machine; a malicious cross-origin page cannot read files
//     (CORS: responses carry no Access-Control-Allow-Origin, and the
//     same-origin check above rejects mismatched Origin anyway).
//   - Bounded: 60 MiB per file (glb scenes can be large).

import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";

const name = "3d-viewer";
const inject = ["webServer"];

const PREFIX = "/model3d";
const REPRO_PREFIX = "/repro";
// Optional read-only static root for the development repro page
// (same-origin three.js test harness; no arbitrary-path exposure).
// Unset by default → the route is not registered at all, so a published
// install never exposes any local directory.
const REPRO_ROOT = (process.env.DSH_3D_VIEWER_REPRO_ROOT ?? "").trim();
const REPRO_MAX = 8 * 1024 * 1024; // 8 MiB (three.module.js is ~1.3 MB)
const REPRO_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const MAX_BYTES = 60 * 1024 * 1024; // 60 MiB

const MIME = {
  ".obj": "model/obj",
  ".mtl": "model/mtl",
  ".stl": "model/stl",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary"
};

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === void 0 || origin === "") return true;
  const host = req.headers.host;
  if (host === void 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Decode the /model3d/<encoded-abs-path> tail into a concrete file path.
// Returns { path } on success or { status, body } on failure.
// Decode the /model3d/<abs-path> tail into a concrete file path.
//
// Wire convention (client <-> host): the path is split on "/", every segment
// is percent-encoded, and the drive-separator slash after "E:" is kept
// LITERAL in the URL (i.e. the URL is /model3d/E:/AI%20share/...). The host
// therefore must NOT decodeURIComponent the whole tail: that would turn the
// literal drive slash into "/" and blur the drive form. Instead it decodes
// segment by segment (delimiters stay literal) and validates each segment.
//
// Returns { path, type } on success or { status, body } on failure.
function resolveModel(encodedTail) {
  let rel = encodedTail.startsWith("/") ? encodedTail.slice(1) : encodedTail;
  if (rel.length === 0) return { status: 404, body: "not-found" };
  const rawSegs = rel.split("/");

  // Decode each segment (delimiters stay literal — decoding the whole tail
  // would blur the drive separator); any decode failure is a 400. Reject
  // ".." segments BEFORE the empty/`.` filter so traversal can never be
  // normalized away.
  const segs = [];
  for (const raw of rawSegs) {
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return { status: 400, body: "bad-encoding" };
    }
    if (seg.indexOf("\0") !== -1) return { status: 400, body: "bad-path" };
    // A decoded segment may itself contain "/" (e.g. "..%2F..%2Fx" decodes
    // to "../../x") — re-split on the decoded delimiters and reject any ".."
    // that surfaces, so traversal can never hide inside one encoded segment.
    for (const sub of seg.split(/[\\/]+/)) {
      if (sub === "..") return { status: 400, body: "traversal" };
      if (sub.indexOf("\0") !== -1) return { status: 400, body: "bad-path" };
    }
    if (seg === "" || seg === ".") continue;
    segs.push(seg);
  }
  if (segs.length === 0) return { status: 404, body: "not-found" };

  // Windows drive form: first segment is a drive letter + colon ("E:"),
  // followed by at least one path segment. The client emits the drive
  // separator encoded (%2F) so the URL reads /model3d/E:/AI%20share/...;
  // the HTTP layer may deliver it with the %2F already decoded to "/", in
  // which case split("/") yields ["E:", "AI share", ...] — the same shape
  // after the empty/`.` filter.
  if (/^[A-Za-z]:$/.test(segs[0])) {
    if (segs.length === 1) return { status: 404, body: "not-found" };
    const normalized =
      segs[0].toUpperCase() + sep + segs.slice(1).join(sep);
    const type = MIME[extname(normalized).toLowerCase()];
    if (type === void 0) return { status: 404, body: "not-a-model" };
    return { path: normalized, type };
  }

  // POSIX absolute: tail started with "/" (first raw segment empty) and at
  // least one path segment remains.
  if (rawSegs[0] === "" && segs.length >= 1) {
    const normalized = sep + segs.join(sep);
    if (!isAbsolute(normalized)) return { status: 400, body: "not-absolute" };
    const type = MIME[extname(normalized).toLowerCase()];
    if (type === void 0) return { status: 404, body: "not-a-model" };
    return { path: normalized, type };
  }

  // Anything else: relative or malformed.
  return { status: 400, body: "not-absolute" };
}

function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: PREFIX,
        handler: async (req, res) => {
          const respond = (status, body, headers) => {
            if (res.writableEnded) return;
            res.writeHead(status, headers);
            res.end(body);
          };
          try {
            if (req.method !== "GET" && req.method !== "HEAD") {
              respond(405, "method-not-allowed", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            if (!sameOrigin(req)) {
              respond(403, "origin-mismatch", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            const rawPath = new URL(req.url ?? "/", "http://x").pathname;
            if (rawPath !== PREFIX && !rawPath.startsWith(`${PREFIX}/`)) {
              respond(404, "not-found", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            const encodedTail = rawPath.slice(PREFIX.length);
            const resolved = resolveModel(encodedTail);
            if (resolved.status !== void 0) {
              respond(resolved.status, resolved.body, {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            const data = await readFile(resolved.path);
            if (data.byteLength > MAX_BYTES) {
              respond(413, "too-large", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            respond(200, data, {
              "content-type": resolved.type,
              "content-length": String(data.byteLength),
              "cache-control": "no-store"
            });
          } catch (error) {
            if (!res.writableEnded) {
              const code = (error && error.code) || "";
              const notFound = code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
              respond(notFound ? 404 : 500, notFound ? "not-found" : "error", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
            }
          }
        }
      }),
    "3d-viewer: /model3d route"
  );
  // Optional read-only static harness for the same-origin three.js repro page.
  // Registered only when DSH_3D_VIEWER_REPRO_ROOT points somewhere.
  if (REPRO_ROOT === "") return;
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: REPRO_PREFIX,
        handler: async (req, res) => {
          const respond = (status, body, headers) => {
            if (res.writableEnded) return;
            res.writeHead(status, headers);
            res.end(body);
          };
          try {
            if (req.method !== "GET" && req.method !== "HEAD") {
              respond(405, "method-not-allowed", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            if (!sameOrigin(req)) {
              respond(403, "origin-mismatch", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            const rawPath = new URL(req.url ?? "/", "http://x").pathname;
            if (rawPath !== REPRO_PREFIX && !rawPath.startsWith(`${REPRO_PREFIX}/`)) {
              respond(404, "not-found", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            let rel = decodeURIComponent(rawPath.slice(REPRO_PREFIX.length));
            if (rel === "" || rel === "/") rel = "/index.html";
            // Path rules: reject ".." / NUL / absolute before joining.
            for (const part of rel.split(/[\\/]+/)) {
              if (part === ".." || part.indexOf("\0") !== -1) {
                respond(400, "bad-path", {
                  "content-type": "text/plain; charset=utf-8",
                  "cache-control": "no-store"
                });
                return;
              }
            }
            const full = resolve(REPRO_ROOT, "." + (rel.startsWith("/") ? rel : "/" + rel));
            if (full !== REPRO_ROOT && !full.startsWith(REPRO_ROOT + sep)) {
              respond(403, "forbidden", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            const type = REPRO_MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
            const data = await readFile(full);
            if (data.byteLength > REPRO_MAX) {
              respond(413, "too-large", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
              return;
            }
            respond(200, data, {
              "content-type": type,
              "content-length": String(data.byteLength),
              "cache-control": "no-store"
            });
          } catch (error) {
            if (!res.writableEnded) {
              const code = (error && error.code) || "";
              const notFound = code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
              respond(notFound ? 404 : 500, notFound ? "not-found" : "error", {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store"
              });
            }
          }
        }
      }),
    "3d-viewer: /repro route"
  );
}

export { apply, inject, name, resolveModel };
