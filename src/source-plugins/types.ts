// Source-plugin interface — Phase F per planning doc 46.
//
// V0 ships one implementation: LocalFSPlugin. V2-V5 add Google Drive,
// OneDrive, Dropbox, SMB/NFS direct. All plugins satisfy this interface
// so the WSS client + frame serializer don't know which backend the
// bytes are coming from.
//
// Plugin output is plaintext. Encryption happens in a wrapper layer
// between the plugin and the WSS push (V0.3+ wraps THUMB / READ bytes
// with AES-256-GCM); plugins themselves never touch the CEK.

export interface FileEntry {
  /** POSIX-separated path relative to the plugin's source root. */
  relPath: string;
  /** File size in bytes; 0 for directories. */
  size: number;
  /** Last-modified time in epoch milliseconds. */
  mtime: number;
  /** True for directories; false for regular files. Other types (symlinks,
   *  sockets, devices) are skipped in V0. */
  isDir: boolean;
  /** Best-effort MIME type from filename extension. Optional. */
  mime?: string;
  /** SHA-256 of file bytes. Lazy / opt-in — populated only when callers
   *  ask for it (V1.5+ de-dup work). Not set in V0.2's initial walk. */
  contentHash?: string;
}

export interface SourcePlugin {
  /** Stable identifier: 'local-fs' | 'google-drive' | 'onedrive' | etc. */
  readonly id: string;
  /** Human-readable label for the setup UI + source_roots JSON column. */
  readonly label: string;
  /** Path / identifier of the source root. For local-fs, the container-side
   *  path (e.g. /sources/local). For cloud plugins (V2+), the provider's
   *  internal folder ID + label. */
  readonly rootPath: string;

  /** Async-iterate every entry under the source root. Recursive. Yields
   *  directories before their contents so importers can build parent-first
   *  trees if needed. V0.2 consumers don't care about ordering — they just
   *  batch + push. */
  walk(): AsyncIterable<FileEntry>;
}
