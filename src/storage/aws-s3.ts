import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  R2StorageInterface,
  GetObjectOptions,
  GetObjectResult,
  PutObjectOptions,
  PutObjectResult,
} from "../types/storage.ts";

export interface AwsS3Config {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  bucketName: string;
  endpointUrl?: string; // Optional (e.g. S3 Express One Zone, LocalStack, or custom gateway)
}

/**
 * Production AWS S3 client implementing Cursor's Continuity storage requirements:
 * 1. PutObject with If-Match (Atomic CAS on wal_index.json)
 * 2. GetObject with If-None-Match (304 Not Modified cache validation)
 * 3. Raw packfile streaming and retrieval
 */
export class AwsS3Storage implements R2StorageInterface {
  private readonly client: S3Client;
  public readonly bucketName: string;

  constructor(config: AwsS3Config) {
    this.bucketName = config.bucketName;

    const region =
      config.region ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      "us-east-1";

    const accessKeyId =
      config.accessKeyId ??
      process.env.AWS_ACCESS_KEY_ID ??
      "";

    const secretAccessKey =
      config.secretAccessKey ??
      process.env.AWS_SECRET_ACCESS_KEY ??
      "";

    const sessionToken =
      config.sessionToken ??
      process.env.AWS_SESSION_TOKEN;

    const credentials =
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey, sessionToken }
        : undefined;

    this.client = new S3Client({
      region,
      endpoint: config.endpointUrl ?? process.env.AWS_ENDPOINT_URL,
      credentials,
    });
  }

  async getObject(key: string, options?: GetObjectOptions): Promise<GetObjectResult> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      IfNoneMatch: options?.ifNoneMatch,
    });

    try {
      const resp = await this.client.send(cmd);
      const data = resp.Body ? await resp.Body.transformToByteArray() : new Uint8Array();
      return {
        status: 200,
        data,
        etag: resp.ETag,
      };
    } catch (err: any) {
      const httpStatus = err?.$metadata?.httpStatusCode;
      const errorCode = err?.name || err?.Code;

      // Sub-10ms conditional 304 Not Modified
      if (httpStatus === 304 || errorCode === "304") {
        return {
          status: 304,
          etag: options?.ifNoneMatch,
        };
      }

      // 404 Not Found
      if (httpStatus === 404 || errorCode === "NoSuchKey") {
        return { status: 404 };
      }

      throw err;
    }
  }

  async putObject(
    key: string,
    data: Uint8Array | string,
    options?: PutObjectOptions
  ): Promise<PutObjectResult> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;

    const cmd = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: bytes,
      IfMatch: options?.ifMatch && options.ifMatch !== "NONE" ? options.ifMatch : undefined,
    });

    try {
      const resp = await this.client.send(cmd);
      return {
        status: 200,
        etag: resp.ETag,
      };
    } catch (err: any) {
      const httpStatus = err?.$metadata?.httpStatusCode;
      const errorCode = err?.name || err?.Code;

      // Conditional CAS 412 Precondition Failed
      if (httpStatus === 412 || errorCode === "PreconditionFailed") {
        return {
          status: 412,
          error: "Precondition Failed: ETag mismatch on AWS S3 CAS",
        };
      }

      throw err;
    }
  }

  async listObjects(prefix: string): Promise<string[]> {
    const cmd = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
    });

    const resp = await this.client.send(cmd);
    return (resp.Contents ?? []).map((item) => item.Key!).filter(Boolean);
  }

  async deleteObject(key: string): Promise<boolean> {
    const cmd = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    await this.client.send(cmd);
    return true;
  }
}
