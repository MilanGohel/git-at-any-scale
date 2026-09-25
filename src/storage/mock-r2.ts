import type {
  R2StorageInterface,
  GetObjectOptions,
  GetObjectResult,
  PutObjectOptions,
  PutObjectResult,
} from "../types/storage.ts";

interface StoredObject {
  data: Uint8Array;
  etag: string;
}

/**
 * High-fidelity in-memory Cloudflare R2 simulator.
 * Supports exact HTTP status codes (200, 304, 404, 412), ETag computation,
 * and Atomic Compare-And-Swap (CAS) for zero-credential local development and testing.
 */
export class MockR2Storage implements R2StorageInterface {
  private readonly objects = new Map<string, StoredObject>();
  public readonly bucketName: string;

  constructor(bucketName: string = "cursor-continuity-r2") {
    this.bucketName = bucketName;
  }

  /**
   * Computes an S3/R2 compliant MD5 hex ETag.
   */
  private computeETag(data: Uint8Array): string {
    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(data);
    return `"${hasher.digest("hex")}"`;
  }

  async getObject(key: string, options?: GetObjectOptions): Promise<GetObjectResult> {
    const entry = this.objects.get(key);
    if (!entry) {
      return { status: 404 };
    }

    // Sub-10ms conditional check used by read replicas:
    // If the client's cached ETag matches, return 304 with no body!
    if (options?.ifNoneMatch && options.ifNoneMatch === entry.etag) {
      return { status: 304, etag: entry.etag };
    }

    return {
      status: 200,
      data: new Uint8Array(entry.data),
      etag: entry.etag,
    };
  }

  async putObject(
    key: string,
    data: Uint8Array | string,
    options?: PutObjectOptions
  ): Promise<PutObjectResult> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const newEtag = this.computeETag(bytes);
    const existing = this.objects.get(key);

    // CAS check for object creation: must not exist
    if (options?.ifMatch === "NONE" && existing) {
      return {
        status: 412,
        error: "Precondition Failed: Object already exists",
      };
    }

    // CAS check for update: must match provided ETag
    if (options?.ifMatch && options.ifMatch !== "NONE") {
      if (!existing) {
        return {
          status: 412,
          error: "Precondition Failed: Object does not exist",
        };
      }
      if (existing.etag !== options.ifMatch) {
        return {
          status: 412,
          error: `Precondition Failed: ETag mismatch. expected ${options.ifMatch}, got ${existing.etag}`,
        };
      }
    }

    this.objects.set(key, {
      data: bytes,
      etag: newEtag,
    });

    return {
      status: 200,
      etag: newEtag,
    };
  }

  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys.sort();
  }

  async deleteObject(key: string): Promise<boolean> {
    return this.objects.delete(key);
  }

  /**
   * Helper to inspect current stored objects count.
   */
  get size(): number {
    return this.objects.size;
  }
}
