/**
 * Cloudflare R2 / S3 Storage Abstraction Types for Continuity.
 */

export interface GetObjectResult {
  status: 200 | 304 | 404;
  data?: Uint8Array;
  etag?: string;
}

export interface PutObjectResult {
  status: 200 | 412;
  etag?: string;
  error?: string;
}

export interface PutObjectOptions {
  /**
   * If provided:
   * - A specific ETag string: write only succeeds if the existing object matches this ETag (Atomic CAS).
   * - "NONE": write only succeeds if the object does NOT exist yet (creation CAS).
   */
  ifMatch?: string;
}

export interface GetObjectOptions {
  /**
   * If provided, returns HTTP 304 Not Modified if the object's current ETag matches.
   */
  ifNoneMatch?: string;
}

export interface R2StorageInterface {
  /**
   * Fetches an object with optional conditional ETag validation (HTTP 304).
   */
  getObject(key: string, options?: GetObjectOptions): Promise<GetObjectResult>;

  /**
   * Puts an object with optional Compare-And-Swap (CAS) validation (HTTP 412).
   */
  putObject(key: string, data: Uint8Array | string, options?: PutObjectOptions): Promise<PutObjectResult>;

  /**
   * Streams a file directly from local disk to S3/R2 with zero in-memory buffering.
   */
  uploadFile(key: string, filePath: string, options?: PutObjectOptions): Promise<PutObjectResult>;

  /**
   * Lists all object keys matching the prefix.
   */
  listObjects(prefix: string): Promise<string[]>;

  /**
   * Deletes an object.
   */
  deleteObject(key: string): Promise<boolean>;
}
